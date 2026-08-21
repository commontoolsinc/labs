---
status: historical
created: 2026-08-17
archived: 2026-08-18
reason: "Stage-C evidence: the two-round self-review of #5969 (the lunch residual re-characterized as served-handler double dispatch; the arrival-gate KEEP verdict)."
---

# Stage C (lunch residual + arrival-gate revisit) — self-review report

Branch `claude/server-exec-v2-stage-c-lunch` (worktree `/Users/berni/labs-worktrees/stage-c-lunch`),
one commit `eb64d8694` on the fan-out-B tip `fb2292a24`. PR #5969 → base `claude/server-exec-v2-fanout-b`.
Two adversarial subagent passes over the full diff; every finding addressed or recorded.

## Round 1 (on the first Stage-C wording)

- **M1 — "`events.processed > events.appended` is the double-delivery signature" over-claimed.**
  `processed` counts drain queueings + re-drains; `appended` counts feed-notified/activation appends;
  an in-wave LT1 cascade counts in neither → the gap also arises from ordinary re-drains.
  → Dropped as a signature everywhere; the per-event RUN COUNTS from the un-instrumented stores are
  the evidence; a "not a signature" correction is recorded in the register.
- **M2 — "the serving runtime EMITS A DUPLICATE derived-class append to castVote's OTHER stream instance /
  2 authored + 2 derived appends" mischaracterized.** Re-derived from the clean stores: ONE castVote sidecar
  entry per click (one stream cell, one eventId); the "2 authored + 2 derived" was the ordinary
  click→cascade chain. The duplication is at DISPATCH (one durable event run 2–5×). → Rewritten as the
  dossier (register OW32 row, skip entry, PR body).
- **M3 — n/N green not stated.** → "0/2 clean runs green; 5 instrumented runs (2 reached the vote steps
  green, 3 RED; none counted as gate-green)".
- **m1/m2/m3 (the `#now` pin)** — assert on the ADVANCED tick's revision (not the initial acquire-time
  write), by the tick doc's own id (`{wish:{now:true,interval:1000}}`), class `derived` + holder = the
  space server's holder; add a "current" assertion (within 5 s of `Date.now()`). → Done.
- **m4 — MWISH/F3 attribution wrong**: F3's sidecar-chain pin had already landed on the base
  (`f5a0cac5c`, `executor-cross-space.test.ts:932`). → Attribution dropped from the test; the register's
  stale "OWED" recorded as landed in the Stage-C delta.
- **m5 — the handler-at-dispatch read (F4's precise hypothesis) had no unit pin.** → Added
  `executor-events-down.test.ts` "a SERVED handler bound to an interval-#now derivation reads a CURRENT
  nowTick at dispatch" (the handler writes the bound `nowTick` or a `-1` null sentinel; mutation → RED).
- **m6 — arrival-gate evidence wording**: only the OW32-shape pin's mutation is the gate removal (the
  other two pin the riders); "no server-side change touches" softened to the frame-coupling statement.
  → Done (register delta + speculation.md).
- **m7 — record served-run counts per click.** → Done (clean 1: Alice 3 / Bob 5; clean 2: Bob 2 / Alice 4;
  probe: Bob 4 / Alice 5; fixer stores re-read).
- **m8 / NITs** — wording drift, `~2052`→`2035`, bold spans. → Done.

## Round 2 (on the rewritten dossier)

- **All cited `file:line` verified against the tip; no per-eventId dedupe exists anywhere** (`queueSchedulerEvent`
  just pushes; the W4 collapse is disabled under the flag; `dropQueuedEvent` is by object identity; the drain's
  only skip is the store-side `duplicateOfConsequenced` twin) — the central claim stands. Nothing purges the
  scheduler queue at wave close.
- **MAJOR — resolution (i)(β) unsound as first worded**: a drain skip keyed on "already queued/ran" would, if the
  other copy is the `streamEntry`-less LT1 leftover, leave the entry unmarked and re-drained the next wave; and
  (α)'s purge must run synchronously at the deadline decision, not after `await commitWave`. → Sharpened:
  the skip keys on a mark-bearing (`streamEntry`) copy; the purge is deadline-time with the discriminator
  `served !== undefined && served.streamEntry === undefined`.
- **MAJOR — PR-body claims re-derived from the tip**: the client echo IS a cause of the RENDERED divergence
  (coin 2), not of the store-side loss. → The PR body/Why/Flags carry coin 2 explicitly.
- **MINOR — derivation-emitter hole in (α)**: a derivation-kind LT1 emitter's append can be dropped per-doc as
  superseded (nothing re-emits) → a purge would lose it; today it runs as an orphan consequence. → Named in the
  dossier; (ii)'s sentence must decide the orphan-delivery clause.
- **MINOR — shaper-held events invisible to a queue-only dedupe** (renderer-trusted clicks take
  `holdShapedEvent`). → Named; the dedupe must include the shaper's held set.
- **MINOR — β's re-arm doors understated + `#eventDeferrals` never cleared on success** (a small leak). → Named.
- **MINOR — the lift condition needs BOTH coins.** → Cross-referenced in the DISPOSITION and the skip entry.
- **MINOR — the `#now` pin's "post-install by construction" was a timing argument.** → `firstTick` is now read
  only after `host.spaceServer(space)?.active === true` (activation installs the seal destination and then flips
  `active`), so the asserted ADVANCE is post-install.
- **MINOR — events-down comment overclaimed the server timer.** → Corrected (the ON client's own timer may
  feed the tick doc; the pin is about the served handler's read; it does not distinguish one dispatch from two).
- **NITs** — "4–5" → 5 with the interleaving explained; (α)'s discriminator stated; (ii) "one COMPLETED
  delivery"; the pre-existing dangling `**` at "residual x).**" removed; layout nested. → Done.
- Two-browsers lockdown line verified by the reviewer: `commitTrustedAdminToggle` bound directly to the click;
  a native click's serialized `detail` is the click count, `cf-change` (which carries `checked`) is not bound →
  the toggle branch → same class (re-drain variant only). No caveat needed.

## Verification after addressing (final)

- `executor-serving-loop` (25 steps) + `executor-events-down` (12 steps), real clock, soaked together 3× + 2×
  after the last edits: 37/37 each time. `speculation-arrival-gate` 3/3. `executor-fan-out` 11/11.
- Skip-list validator test 17/17; CLI validator keeps the lunch entry in `--ignore`. `check-docs` 548.
  `deno fmt --check` / `deno check` clean. `deno lint`: only the 2 pre-existing `require-await`.
- Lunch gate (un-instrumented, harness protocol, ON binary `sha=59b5329ae` define=true, fresh store, load
  recorded): 0/2 green — the skip STAYS.
