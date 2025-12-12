# Session Log: CRDT Collaborative Editing

## Status: Ready to Implement

## What We've Done
- [x] Explored framework architecture (Chronicle, Cell, transaction system)
- [x] Analyzed ct-code-editor (already uses CodeMirror)
- [x] Compared Automerge vs Yjs - decided on **Yjs**
- [x] Created implementation plan (TODO-crdt-collaborative-editing.md)
- [x] Created branches in both repos (`feature/crdt-collaborative-editing`)

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

## What's Next (After Questions Answered)

### Phase 1: Infrastructure
- [ ] Set up y-websocket server
- [ ] Test basic Yjs sync between two browser tabs

### Phase 2: ct-code-editor
- [ ] Add `collaborative` and `roomId` props
- [ ] Integrate y-codemirror.next
- [ ] Test with two editors

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
