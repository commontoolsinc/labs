# CRDT Collaborative Editing: Implementation Plan

## Goal
Add real-time collaborative editing to text fields without stomping concurrent edits, using **Yjs** as the CRDT library.

## Why Yjs over Automerge

Automerge's strengths (structured data, offline-first, branching, time-travel) overlap with what CommonTools already provides via Cells + Chronicle. Using Automerge would mean two competing data models.

Yjs is designed as a **thin real-time sync layer** that complements existing systems:
- **Smaller bundle**: ~15KB vs ~80KB
- **Faster for text**: Optimized specifically for collaborative text editing
- **Better editor ecosystem**: y-prosemirror, y-codemirror, y-tiptap are mature & battle-tested
- **Simpler model**: Just syncs text between connected clients, doesn't try to be the data layer
- **Production proven**: Powers collaborative editing in Notion, and many other production apps

## Constraints
- **Rich text priority** (plain text secondary)
- **No offline support needed** - assumes live internet, server is canonical
- **Component-specific is fine** - doesn't need to be general framework feature
- **Ephemeral CRDT state** - no persistence of Yjs history
- **ct-code-editor uses CodeMirror** - can leverage y-codemirror

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────┐
│  Components (share Yjs infrastructure)                         │
│                                                                │
│  ct-code-editor (modify)       ct-richtext-editor (new)       │
│  + y-codemirror                + TipTap + y-prosemirror       │
│           │                              │                     │
│           └──────────┬───────────────────┘                     │
│                      │                                         │
│               Y.Doc (shared document)                          │
│               WebsocketProvider (y-websocket)                  │
│                      │                                         │
│            WebSocket (/api/collab/:room)                       │
│            or use y-websocket server                           │
├────────────────────────────────────────────────────────────────┤
│  Cell Layer (UNCHANGED)                                        │
│  - Stores plain text/HTML on blur                              │
│  - No CRDT state persisted, no framework changes               │
│  - Standard debounced StringCellController                     │
└────────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

1. **Zero runtime changes** - Chronicle, Cell, transactions untouched
2. **Yjs for sync only** - Not for persistence; Cell stores plain text/HTML
3. **y-websocket server** - Can use off-the-shelf y-websocket, or minimal custom relay
4. **Lazy-loaded Yjs** - Bundle only loads when collaboration enabled (~15KB)
5. **Room = Cell entity ID** - Each collaborative field gets its own Y.Doc

## Implementation Phases

### Phase 1: Collaboration Infrastructure

**Option A: Use y-websocket server (recommended for simplicity)**

y-websocket provides a drop-in WebSocket server. We can either:
1. Run it as a separate process alongside toolshed
2. Embed it in toolshed using the y-websocket utils

```typescript
// Minimal integration - just need to set up the WebSocket upgrade
import { setupWSConnection } from 'y-websocket/bin/utils';

// In toolshed WebSocket handler:
wss.on('connection', (ws, req) => {
  const roomName = req.url.slice(1); // e.g., /space:entityId
  setupWSConnection(ws, req, { docName: roomName });
});
```

**Option B: Custom relay (if more control needed)**

New files:
- `/packages/toolshed/routes/collab/collab.handlers.ts`

But y-websocket is battle-tested and handles all the edge cases.

**Client-side:**
```typescript
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

// Per-room Y.Doc management
const docs = new Map<string, Y.Doc>();
const providers = new Map<string, WebsocketProvider>();

function getOrCreateDoc(roomId: string): Y.Doc {
  if (!docs.has(roomId)) {
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(
      'wss://toolshed.example.com/collab',
      roomId,
      ydoc
    );
    docs.set(roomId, ydoc);
    providers.set(roomId, provider);
  }
  return docs.get(roomId)!;
}
```

### Phase 2: Code Editor Collaboration (y-codemirror)

**Modify:** `/packages/ui/src/v2/components/ct-code-editor/ct-code-editor.ts`

**New properties:**
```typescript
collaborative: boolean = false;  // Enable collaboration
roomId?: string;                 // Override auto-derived room ID
```

**Integration with y-codemirror.next (CodeMirror 6):**
```typescript
import * as Y from 'yjs';
import { yCollab } from 'y-codemirror.next';
import { WebsocketProvider } from 'y-websocket';

// In _initializeEditor(), when collaborative=true:
if (this.collaborative) {
  const roomId = this.roomId ?? this._deriveRoomId();

  // Create or get Y.Doc for this room
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText('codemirror');

  // Connect to collaboration server
  const provider = new WebsocketProvider(
    this._getCollabUrl(),
    roomId,
    ydoc
  );

  // Add y-codemirror extension
  extensions.push(yCollab(ytext, provider.awareness));

  // Store for cleanup
  this._ydoc = ydoc;
  this._provider = provider;
}
```

**Cell sync (unchanged pattern):**
- Still uses `StringCellController` with debounce
- On blur/idle: `cell.set(editor.state.doc.toString())`
- External Cell changes still call `_updateEditorFromCellValue()`
- Yjs handles real-time sync; Cell handles persistence

### Phase 3: Rich Text Editor (new component)

**New files:**
- `/packages/ui/src/v2/components/ct-richtext-editor/ct-richtext-editor.ts`
- `/packages/ui/src/v2/components/ct-richtext-editor/styles.ts`
- `/packages/ui/src/v2/components/ct-richtext-editor/index.ts`

**TipTap + y-prosemirror** (battle-tested combination):

TipTap is a headless ProseMirror wrapper with excellent DX. The `@tiptap/extension-collaboration` package wraps y-prosemirror.

```typescript
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

// Create collaborative TipTap editor
const ydoc = new Y.Doc();
const provider = new WebsocketProvider(collabUrl, roomId, ydoc);

const editor = new Editor({
  extensions: [
    StarterKit,
    Collaboration.configure({
      document: ydoc,
    }),
    CollaborationCursor.configure({
      provider,
      user: { name: 'User', color: '#f783ac' },
    }),
  ],
});
```

**Component API:**
```typescript
class CTRichtextEditor extends BaseElement {
  value: Cell<string> | string;  // HTML content
  collaborative: boolean = false;
  roomId?: string;
  placeholder: string;
  readonly: boolean;
  disabled: boolean;
  toolbar: 'full' | 'minimal' | 'none';
  // ... standard editor props
}
```

**Cell stores HTML:**
```typescript
// On blur/idle:
const html = editor.getHTML();
this._cellController.setValue(html);

// On external Cell change:
const html = this._cellController.getValue();
editor.commands.setContent(html, false);  // Don't emit update
```

### Phase 4: Polish & Testing

1. **Cursor presence** - Show where other users are editing (built into y-codemirror and TipTap collaboration extensions)
2. **User awareness** - Names/colors for collaborators (via Yjs awareness protocol)
3. **Reconnection handling** - WebsocketProvider handles auto-reconnect
4. **Performance testing** - Multiple concurrent editors
5. **Bundle optimization** - Lazy-load Yjs + editor deps when `collaborative=true`

## File Changes Summary

### New Files
| File | Purpose |
|------|---------|
| `ui/src/v2/components/ct-richtext-editor/*` | New rich text component with TipTap |
| `toolshed/routes/collab/*` | y-websocket integration (optional, can run standalone) |

### Modified Files
| File | Change |
|------|--------|
| `ui/src/v2/components/ct-code-editor/ct-code-editor.ts` | Add `collaborative` prop, y-codemirror integration |
| `ui/deno.json` | Add Yjs dependencies |
| `toolshed/lib/create-app.ts` | Register collab WebSocket upgrade (if embedding y-websocket) |

### Dependencies to Add
```json
{
  "yjs": "^13.x",
  "y-websocket": "^1.x",
  "y-codemirror.next": "^0.x",
  "@tiptap/core": "^2.x",
  "@tiptap/pm": "^2.x",
  "@tiptap/starter-kit": "^2.x",
  "@tiptap/extension-collaboration": "^2.x",
  "@tiptap/extension-collaboration-cursor": "^2.x"
}
```

**Bundle sizes:**
- yjs: ~15KB gzipped
- y-websocket: ~3KB
- y-codemirror.next: ~5KB
- TipTap (full): ~50KB (but tree-shakeable)

## Open Questions for Prototyping

1. **y-websocket deployment**: Run as separate process or embed in toolshed?
   - Separate: simpler, can use off-the-shelf y-websocket server
   - Embedded: single process, can reuse toolshed auth

2. **Room derivation**: Use Cell entity ID directly, or hash it for shorter room IDs?

3. **Authentication**: Does collab WebSocket need auth? (Probably yes - reuse existing toolshed auth)

4. **Initial content sync**: When user joins room, how to initialize Y.Doc from Cell value?
   - Option A: First joiner seeds from Cell, others sync from Yjs
   - Option B: Server initializes Y.Doc from Cell on room creation

## Success Criteria

- [ ] Two users can edit the same `ct-code-editor` field simultaneously without data loss
- [ ] Two users can edit the same `ct-richtext-editor` field simultaneously without data loss
- [ ] Cell stores plain text/HTML (no Yjs state persisted)
- [ ] No changes to Chronicle, Cell implementation, or transaction system
- [ ] Collaboration is opt-in via `collaborative` property
- [ ] Works with existing CellController patterns
- [ ] Cursor presence shows other users' positions

## Non-Goals (explicitly out of scope)

- Offline support / conflict resolution on reconnect
- Yjs history persistence (state is ephemeral)
- General Cell-level CRDT integration
- Server-side document storage (y-websocket is stateless relay)
- Transparent Cell API (explicit component is fine)
- Version history / undo across sessions
