---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "OW51 loss-triage: the default-app splitDefinitions undefined-read under ON — which ON read shape reaches the note.tsx lift undefined (served value vintage, schema default not applied, or arrival ordering), and the fix or flag."
---

# OW51 — the default-app `splitDefinitions` undefined-read: triage

Register row: `docs/specs/server-side-execution/verification-coverage.md`
§3 OW51. Evidence base:
`docs/history/plans/server-execution-v2/stage-c/first-on-ci-gate.md`
row 1; the same console error W4 §6.2 recorded on the note workload
(17 and 6 occurrences per run, attributed pre-existing there).

Surface: `packages/patterns/integration/default-app.test.ts` (file-level
ON skip). The browser console gate trips on a deterministic
`TypeError: Cannot read properties of undefined (reading 'split')` at
`splitDefinitions` (`api/patterns/notes/reference-block.ts:62`) inside
note.tsx lift callbacks.

## 1. Reproduction (ON binary, this worktree's tip)

Built the ON binary (`EXPERIMENTAL_SERVER_EXECUTION=true deno task
build-binaries toolshed`; `/api/meta` verified `shellServerExecutionDefine
"true"` + servingLoop present, gitSha = branch tip) and ran
`default-app.test.ts` against it: **both steps fail the console gate**
with the exact registered error, while the FUNCTIONAL flow succeeds
(note created, listed, reload survives) — the crash is a background
failure of two computeds, not a flow-blocker.

The stack traces pin BOTH crash sites to the two `pendingEdit.get()`
readers in note.tsx:

- `pendingAddresses` (note.tsx:428, `splitDefinitions(body)` at 431);
- the staged-edit apply computed (note.tsx:444, `splitDefinitions(body)`
  at 448)

running in the SHELL WORKER's scheduler (`runPullSchedulerSettleLoop`
→ `invokeReactiveAction` → the lift callback), reported over the
runtime-client protocol as `callback:error`. No `editProjection` is
ever driven by the test — the crash happens on a FRESH note during the
create/open flow.

## 2. What the reads mean

`pendingEdit` is `new Writable<string | null>(null)` in the pattern
body. `createWithDefault` (runner cell.ts) puts the initial `null`
into the cell's SCHEMA as `default` — there is NO durable write of the
initial value; every read depends on schema-default application. Both
readers guard `body === null` only, so a read that yields `undefined`
(default not applied, or value not there to read) falls through into
`splitDefinitions(undefined)` → the TypeError at reference-block.ts:62
(`body.split`).

## 3. Negative results (they narrow the seam)

Two headless reproduction attempts against the same ON toolshed, both
GREEN — the crash needs something the browser flow has and these do
not:

- A PiecesController client instantiating notes/note.tsx directly
  (client-authored creation) and driving `editProjection`: no crash,
  edit applies.
- A MultiRuntimeHarness run (bootstrap worker creates the piece,
  session opens it BY ID from storage): no crash.

So client-created pieces read their schema defaults fine under ON,
including open-by-id from another runtime's creation. The browser
difference: the note is created INSIDE a HANDLER run
(`menuNewNote` in system/default-app.tsx does
`navigateTo(Note({...}))`) — under ON that handler runs SERVER-side
(authoritative instantiation in the wave) while the client runs it
speculatively (overlay-local child; per speculation.md §4's W2.1
clarification, the two runs' handler-frame-caused entity ids DIFFER) —
and the shell then renders the note through that convergence.

## 4. In-situ probe

(running — note.tsx's two readers instrumented in the working tree to
log the undefined read with the cell's normalized link and raw value,
then decline instead of crashing, so subsequent runs show whether the
read recovers; binary rebuilt with the probe)

## 5. Root cause

(pending)

## 6. Fix (or flag)

(pending)
