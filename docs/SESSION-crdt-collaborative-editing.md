# Session Log: CRDT Collaborative Editing

## Status: Phase 1 Complete - Starting Phase 2

## What We've Done
- [x] Explored framework architecture (Chronicle, Cell, transaction system)
- [x] Analyzed ct-code-editor (already uses CodeMirror)
- [x] Compared Automerge vs Yjs - decided on **Yjs**
- [x] Created implementation plan (TODO-crdt-collaborative-editing.md)
- [x] Created branches in both repos (`feature/crdt-collaborative-editing`)
- [x] **Phase 1: Implemented y-websocket server in toolshed**
  - Added yjs, y-protocols, lib0 dependencies to toolshed
  - Created `/packages/toolshed/routes/collab/` with:
    - `yjs-server.ts` - Deno-native Yjs sync server
    - `collab.routes.ts` - OpenAPI route definitions
    - `collab.handlers.ts` - WebSocket handler
    - `collab.index.ts` - Router registration
  - Endpoints available:
    - `GET /api/collab/stats` - Service statistics
    - `GET /api/collab/:roomId` (WebSocket) - Collaborative editing
    - `POST /api/collab/:roomId/init` - Initialize room content

## Decisions Made

### 1. y-websocket deployment
**Decision:** Embedded in toolshed
- Fits "everything in toolshed" approach
- Single process to manage
- Can reuse toolshed auth

### 2. Room ID derivation
**Decision:** Direct Cell entity ID
- More debuggable
- Consistent with existing entity references

### 3. Authentication
**Decision:** Yes, reuse toolshed auth tokens
- Secure by default
- Consistent with other toolshed endpoints

### 4. Initial content sync
**Decision:** Server initializes Y.Doc from Cell on room creation
- Avoids race conditions
- Server can read canonical Cell value
- Requires toolshed to have Cell access (which it already does)

## Implementation Progress

### Phase 1: Infrastructure ✅
- [x] Set up y-websocket server in toolshed
- [ ] Test basic Yjs sync between two browser tabs

### Phase 2: ct-code-editor ✅
- [x] Add `collaborative` and `roomId` props
- [x] Add `collabUrl`, `userName`, `userColor` props
- [x] Integrate y-codemirror.next with yCollab extension
- [x] Added Yjs dependencies to ui package (yjs, y-codemirror.next, y-websocket, lib0)
- [x] Updated JSX type definitions for new props
- [x] Created test pattern (patterns/jkomoros/WIP/collab-test.tsx)
- [x] Tested - WebSocket connects successfully and shows "Collab status: connected"

### Phase 3: ct-richtext-editor (new)
- [ ] Create component with TipTap
- [ ] Add Collaboration extension
- [ ] Test rich text sync

### Phase 4: Polish
- [ ] Cursor presence / awareness
- [ ] Reconnection handling
- [ ] Bundle optimization (lazy loading)

## Key Files to Modify

**In labs:**
- `/packages/ui/src/v2/components/ct-code-editor/ct-code-editor.ts`
- `/packages/ui/deno.json` (add deps)
- `/packages/toolshed/...` (if embedding y-websocket)

**New in labs:**
- `/packages/ui/src/v2/components/ct-richtext-editor/*`
