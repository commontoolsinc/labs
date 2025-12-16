# Session Log: CRDT Collaborative Editing

## Status: Phase 4 Complete - Ready for Review

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
**Decision:** Cryptographic auth using same identity system as memory storage
- Components sign auth tokens using `cell.runtime.storageManager.as` (Signer)
- Server verifies using `VerifierIdentity.fromDid()`
- Token payload: `{ roomId, timestamp, userDid }` (signed, base64-encoded)
- Passed as URL query params: `?payload=...&sig=...&did=...`
- Currently allows anonymous connections; can enforce auth when ready

### 5. Presence/Privacy Model
**Decision:** Collaborative mode implies full presence sharing (cursor visibility = consent)
- When `collaborative={true}`, user's cursor position and name are broadcast to all connected clients
- The distinctive colored cursors with name labels serve as the visual consent indicator
- Users who see collaborative cursors know they are in a shared editing session
- This follows the Google Docs model: presence visibility is intrinsic to the collaborative experience
- No "sync-only" mode without presence - if you want privacy, don't enable collaborative mode
- Security: auth ensures only authorized users can connect; presence ensures no one is surprised by sharing

### 4. Initial content sync
**Decision:** Server initializes Y.Doc from Cell on room creation
- Avoids race conditions
- Server can read canonical Cell value
- Requires toolshed to have Cell access (which it already does)

## Implementation Progress

### Phase 1: Infrastructure ✅
- [x] Set up y-websocket server in toolshed
- [x] Test basic Yjs sync between two browser tabs

### Phase 2: ct-code-editor ✅
- [x] Add `collaborative` and `roomId` props
- [x] Add `collabUrl`, `userName`, `userColor` props
- [x] Integrate y-codemirror.next with yCollab extension
- [x] Added Yjs dependencies to ui package (yjs, y-codemirror.next, y-websocket, lib0)
- [x] Updated JSX type definitions for new props
- [x] Created test pattern (patterns/jkomoros/WIP/collab-test.tsx)
- [x] Tested - WebSocket connects successfully and shows "Collab status: connected"
- [x] **Verified real-time sync between two browser tabs** - bidirectional text sync works!
- [x] **Cursor presence works** - shows other user's cursor position with name label

### Phase 3: ct-richtext-editor ✅
- [x] Create component with TipTap (StarterKit + Collaboration + CollaborationCursor)
- [x] Add TipTap and y-prosemirror dependencies to ui package
- [x] Added JSX type definitions for new props
- [x] Created test pattern (patterns/jkomoros/WIP/richtext-collab-test.tsx)
- [x] **Verified real-time sync between two browser tabs** - rich text collaboration works!
- [x] **Cursor presence works** - shows other user's cursor with name label

### Phase 4: Polish ✅
- [x] Cursor presence / awareness (basic implementation working)
- [x] Initial content sync - clients initialize Y.Doc from Cell on first sync (no server call needed)
- [x] Server simplified to generic Yjs relay (no component-specific knowledge)
- [x] **Authentication - Implemented cryptographic auth extending existing identity system**
  - Server: `collab.auth.ts` verifies signed tokens using VerifierIdentity
  - Client: `collab-auth.ts` signs tokens using Cell's Signer
  - Tokens passed as WebSocket URL query params
- [x] Reconnection handling - y-websocket handles automatically with exponential backoff
- [x] Bundle optimization - documented; tree shaking handles unused code paths

## Key Files Modified

**In labs:**
- `/packages/ui/src/v2/components/ct-code-editor/ct-code-editor.ts` - Added collaborative editing with auth
- `/packages/ui/src/v2/components/ct-richtext-editor/` - New component (created)
  - `ct-richtext-editor.ts` - TipTap-based rich text editor with Yjs and auth
  - `styles.ts` - Component styles including cursor presence
  - `index.ts` - Export and custom element registration
- `/packages/ui/src/v2/core/collab-auth.ts` - Client-side auth token signing
- `/packages/ui/src/v2/index.ts` - Added ct-richtext-editor export
- `/packages/ui/deno.json` - Added yjs, y-codemirror.next, y-websocket, lib0, TipTap deps
- `/packages/html/src/jsx.d.ts` - Added collaborative props for both editors
- `/packages/toolshed/routes/collab/` - Yjs WebSocket server with auth
  - `yjs-server.ts` - Core Yjs sync logic with userIdentity tracking
  - `collab.auth.ts` - Server-side auth token verification
  - `collab.routes.ts` - OpenAPI route definitions
  - `collab.handlers.ts` - WebSocket handlers with auth verification
  - `collab.index.ts` - Router registration
- `/packages/toolshed/app.ts` - Added collab route registration
