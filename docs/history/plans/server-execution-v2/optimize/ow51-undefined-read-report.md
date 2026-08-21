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
row 1.

Surface: `packages/patterns/integration/default-app.test.ts` (file-level
ON skip). The browser console gate trips on a deterministic
`TypeError: Cannot read properties of undefined (reading 'split')` at
`splitDefinitions` (`api/patterns/notes/reference-block.ts:62`) inside
note.tsx lift callbacks — an ON read-semantics seam: the lift's input
arrives `undefined` where the OFF arm always supplies it. Reproduced
locally ON; OFF green. NOT a demand hole.

Question this report answers: WHICH ON read shape reaches the lift
undefined — served value vintage, schema default not applied, or
arrival ordering — and the fix at the producer or the lift contract,
whichever the root cause honestly names (a "lifts must tolerate
undefined during arrival" contract change would be FLAGGED, not
decided here).

## 1. Status

QUEUED — OW52 (data-loss class) runs first.

## 2. Reproduction

(pending)

## 3. Root cause

(pending)

## 4. Fix (or flag)

(pending)
