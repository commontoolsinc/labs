---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "OW54 follow-on build (the RULING-5 report §4 outline, coordinator-green-lit): a served event refused pre-storage by CFC seals an error consequence — mechanism confirmation, the red-first evidence, the which-direction (double-seal) analysis, and the suites run."
---

# OW54 build — a served event refused pre-storage by CFC seals an error consequence

Seat: OW54 follow-on (the RULING-5 report §4 outline). Branch
`claude/server-exec-v2-ow54-event-seal` off `origin/main` @
`ec6361782`. Scope exactly as green-lit: the served give-up arm's
discriminated `served.onFailure` — no cfc/, no seal machinery, no
wave code.

## 1. Mechanism, confirmed against the code at this head

The assessment's chain verified end to end before building:

- The CFC pre-storage refusal is minted ONLY in
  `extended-storage-transaction.ts` (`rejectCommitBeforeStorage`, two
  sites: "relevant transaction was not prepared[: reason]" and
  "prepared digest changed"), with `name:
  "StorageTransactionAborted"` and the "CFC enforcement rejected
  commit" message prefix — BEFORE the `#sealDestination.seal` branch,
  so a refused served tx never enters a wave and its consequenced
  mark never seals.
- In `classifyCommitDisposition` that error is not permanent
  (`PreconditionFailedError`), not terminal (`RowLabelCommitError` /
  `SpeculativeBasisError`), and not stale-basis (`ConflictError` /
  `StorageTransactionInconsistent`) → `{kind: "give-up", reason:
  "non-retryable"}` (served copies queue with `retries: false`, but
  the opt-out branch is unreachable for this class — the non-stale
  check fires first).
- The give-up arm settled the callback (`runFinalCommitCallback`) and
  reported the loss (`reportDroppedCfcRejectedWrite`) but never
  called `served.onFailure`, so the drain-in-flight guard released in
  the "queued" state, the durable entry stayed unconsequenced, and
  the post-wave re-arm re-drained it — the base evidence below shows
  the give-up disposition firing twice for one eventId across two
  waves.
- Pre-OW50 the same crash threw from `prepareTxForCommit` inside the
  event finalize and took the ERROR arm, whose contract is `"the
  error IS the consequence"` (`served.onFailure({kind: "error",
  message})`).

One shape the assessment did not spell out, checked here: the LT1
in-process copy's `served` carriage (cell.ts's same-space emission)
carries NO `onFailure`, so for a CFC-refused LT1 copy the new arm is
a safe no-op — the durable entry then re-drains as a root drain copy
(which carries the hook and the `streamEntry`) and the consequence
seals there, one wave later. The seal always happens where the
notice machinery lives.

## 2. The fix as built

`packages/runner/src/scheduler/events.ts`:

- `isCfcRejectedCommitError` — the message-prefix predicate, extracted
  so the sealed consequence and the loss report key on the SAME
  discriminator by construction (`reportDroppedCfcRejectedWrite` now
  calls it).
- The give-up arm: when `served !== undefined` and the predicate
  holds, `served.onFailure({kind: "error", message})` — wrapped in
  the same try/log isolation as the throw arm — BEFORE
  `runFinalCommitCallback()`, so the drain's in-flight guard sees the
  staged notice ("marked") instead of releasing the still-"queued"
  copy. Every other give-up class is byte-identical.

Docs in the same PR: events.md §5 gains the class (the refusal IS the
consequence; every other served commit refusal keeps the wave-cadence
re-drain), and the OW54 register row is CLOSED with the pin as lift
evidence. An OW57 closure on #6184's handler-armed settle gate was
drafted on early corroboration and then WITHDRAWN in the same PR: a
post-rebase run observed the race at the hardened construction
(§5 below) — the row instead records #6184 as a hardening that
reduced but did not eliminate the race.

## 3. Red-first, watched

Two pins in `executor-events-down.test.ts`, both run against the
UNMODIFIED base (`ec6361782`) first.

- **The main pin** ("the give-up arm's CFC discriminator (OW54)"): a
  served event whose handler writes a doc with a genuinely-ambiguous
  STORED envelope (`result.anyOf` with TWO ifc carriers — the class
  the RULING-5 narrowing still refuses; fixtures mirror
  cfc-prepare-crash-surfacing.test.ts), the envelope seeded as the
  doc's first write from the client and pre-pulled into the serving
  replica before the fire (the live ordering). RED on base:

  ```
  error: Error: timed out waiting for the CFC refusal to seal an
  error consequence   (waitUntil, test/executor-events-down.test.ts)
  ```

  with the served copy taking the give-up disposition TWICE for the
  same eventId — two `served-event-commit-failed` + two "dropping the
  write without retry" warns ~250 ms apart (01:48:51.868 and
  01:48:52.115), the post-wave re-arm's second drain — and the entry
  never consequenced (a diagnostic run also confirmed the third
  re-drain waits on the next wave: the quiet harness produces none,
  which is exactly "the wave IS the retry cadence"). GREEN with the
  fix: exactly ONE completed run per event, ONE consequence commit
  naming each eventId, ONE dropped-write report per event, the
  entry's `error` carries the refusal (matched both the
  "CFC enforcement rejected commit" prefix and the
  `/divergent anyOf|commit-prep crashed/` class — the divergence
  surfaced through the cross-runtime pre-pull), the watermark
  advances, and a second poisoned fire seals its own consequence
  behind the first (the stream advances; no second consequence for
  the first event).
- **The scope-boundary pin** ("a NON-CFC give-up on a served event
  keeps the re-drain cadence"): the handler aborts its own
  transaction (`tx.abort`), a non-CFC give-up. GREEN on base AND
  after the fix, with the same two-give-ups-per-eventId re-drain
  shape in both runs — the non-CFC cadence is unchanged, and the pin
  reddens if the discriminator is ever widened to every give-up.

## 4. Which-direction analysis ((α): exactly-once, no double seal)

The invariant is EXACTLY-ONCE consequence per event entry. Paths that
can seal a consequence for a served entry, checked one by one:

1. **The handler tx's own mark** (success path): mutually exclusive
   with the new arm by construction — the arm fires only on a
   PRE-STORAGE refusal, i.e. the tx that carried the mark never
   reached the wave and is dead (`rejectCommitBeforeStorage`
   finalizes the rejection; there is no later landing).
2. **The ERROR arm** (handler threw): mutually exclusive —
   `finalize(error)` returns before any commit is attempted, so
   `handleCommitResult` (and with it the give-up arm) never runs for
   that dispatch.
3. **The terminal and permanent arms**: mutually exclusive — one
   classification switch, one disposition. Neither calls
   `served.onFailure` (unchanged).
4. **The LT1 late-seal refusal**: handled by an early return ABOVE
   the classification; never reaches the give-up arm (and its
   sentinel error does not carry the CFC prefix).
5. **Re-dispatch of the same entry**: between `onFailure` and the
   notice's durable landing the drain-in-flight guard holds
   ("marked", released only by the wave outcome); after it lands the
   entry is consequenced and excluded from the drain; if the notice
   FAILS to seal, the guard releases, the entry re-drains, and the
   arm seals again — convergence to exactly one durable consequence,
   the same self-healing loop the existing error/drop notices use.
   A re-admission of the same eventId at a new seq falls to the
   existing SKIP arm (its notice annotates the duplicate entry, not
   this one).
6. **The dispatch is single-shot**: `tx.commit().then(...)` settles
   once; `handleCommitResult` runs once per dispatch.

Pinned observables: `probeRuns` exactly 1 per event at the seal, ONE
consequence commit naming each eventId (re-checked after the second
fire — still 1 for the first event), ONE dropped-write report per
event. The reverse direction (the fix must not widen): the
scope-boundary pin above, green on base and after.

**Flagged, not filled** (unstated semantics ship as questions):

- A served TERMINAL rejection (`RowLabelCommitError` — the
  storage-time commit-rule refusal, deterministic by its own doc)
  also seals NO consequence today and would re-drain on the wave
  cadence, the same shape OW54 had. The green-lit outline scopes this
  PR to the pre-storage class, so the terminal arm is untouched;
  recorded in the register row as an adjacent residual for the
  owner/coordinator, not silently included.
- Non-CFC give-ups (transport, authorization, handler abort) keep
  re-draining forever by design ("the wave IS the retry cadence").
  Whether an AUTHORIZATION denial is deterministic enough to deserve
  a consequence is the same future question; the boundary is pinned
  as it stands.

## 5. Suites run

All at the fixed head, one file per invocation (the runner test
task's flags):

- `executor-events-down.test.ts` at `ec6361782`: two RED runs on base
  (the pin's timeout; every other step green — the two sibling
  (α3)-family steps included), then at the fix: 4 full-file runs with
  clean verdicts, all `1 passed (21 steps) | 0 failed`, plus 3 more
  runs verifying the two "(α3) + a same-eventId SIBLING tx" steps
  green — 9/9 sibling-step observations at that head.
- `executor-events-down.test.ts` after the rebase onto `b775787b6`
  (#6083, content-addressed schemas on by default): 8 full-file runs
  — BOTH new OW54 pins green in all 8; the "(α3) + a same-eventId
  SIBLING tx (M1)" step red ONCE (run 1, on a loaded machine) with
  the exact CT-2060 signature: the ping entry durable AND
  consequenced at the held-wave probe. Attribution runs: 5/5 green on
  PLAIN origin/main at the same head (no inserted tests), matching
  the row's original observation that tests inserted ahead shift
  timing into the window. Consequence: the drafted OW57 closure was
  withdrawn; the row records #6184 as a hardening that reduced but
  did not eliminate the race, and keeps the don't-blame clause — a
  red of that step with the ping already durable at the probe is
  CT-2060, not this PR's defect.
- Neighbor suites, green per-file: `executor-serving-loop` (25
  steps), `executor-space-server` (15), `cfc-prepare-crash-surfacing`
  (15), `cfc-schema-merge` (58), and the give-up-path binders
  `scheduler-commit-backpressure` (9), `cfc-writer-claim-
  correspondence` (17), `mergeable-append-multispace-conflict` (2).
- The full runner battery (`deno task test` in packages/runner) at
  the end — result in the PR's test plan.
