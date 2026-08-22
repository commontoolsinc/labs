---
status: historical
created: 2026-08-22
archived: 2026-08-22
reason: "Arrival-wait hardening: the reopened ON-lane group-chat 'cross-session arrival' flakes (census items 1+3, runs 32543810077/32547606642) were never the arrival wait — the test's chained draft→trusted-send events raced cross-stream serve order (unpromised, events.md §2) and the served handler no-oped silently on a pre-draft view. Fix: an event-driven arrived-consequence gate (overlay waitForIntentQuiescence / harness awaitEventConsequences) between chained events, a deterministic delay-injected pin, and settled-text conversions for the staged-publish/spec-gallery browser members (census item 2). No timeout changed."
---

# Arrival-wait hardening: the reopened ON-lane flake cluster

Optimize-on-main pass, 2026-08-22. The reopened group-chat
"cross-session arrival" flakes (the owner's 2026-08-21 ON-flake census,
items 1+3) plus the staged-publish/spec-gallery stage-text timeouts
(census item 2 / the 2026-08-20 attribution ledger). Branch
`claude/server-exec-v2-arrival-wait-hardening`.

## 1. The motivating receipts

`cfc-group-chat-demo-multi-runtime.test.ts`, step "admin lockdown gates
room creation but never message sending", assertion `Timed out waiting
for: bob's post-lockdown message arrives at alice`
(`MultiRuntimeHarness.waitFor`, 30 s), failed IDENTICALLY twice on
2026-08-21/22 in "Pattern Integration Tests / server-execution ON
(7/10)":

- main run **32543810077** (head `58e2657e7`, docs-only; job
  96958763640);
- PR #6186 run **32547606642** (job 96968958739 — the diff exonerated
  by the attribution ritual).

Main's next run (`b775787b6`) was green. These failures POST-date
\#6158's merge, so they survive the OW52 settle fix — whose report's §7
addendum had claimed coverage of exactly this census item on the
mechanism argument "the former poll race is now an event-driven wait at
the settle layer". That claim is corrected below.

## 2. What the failing log actually shows (root cause)

The job 96958763640 log, read against the OW52 machinery's designed
self-identification:

- **Zero `event-consequence quiescence budget exhausted` warnings.**
  \#6158's settle warns loudly whenever a poll round's budget elapses
  with intents outstanding. Its absence means every settle round inside
  the failing 30 s found `pendingIntentCount == 0` promptly — bob's
  send event HAD its terminal consequence, arrived back, early in the
  window. Not a slow serving drain.
- **The failing step's entire 30 s window is silent** — no scheduler
  errors, no conflicts, no CFC-rejection markers.
- **The immediately following step passed in 730 ms**, and it contains
  a bob→alice arrival of its own (the room bob adds once admin reaches
  alice's list). Cross-runtime propagation was healthy seconds after
  the "missing" message.

So the message was not slow — it was **never appended**. The wait was
honest; the write it awaited never happened. Mechanism:

- The test's `sendMessage` helper chains TWO events:
  `setMessageDraft` (stream A) then `sendTrustedMessage` (stream B,
  trusted click). The served send handler reads the draft cell and
  **silently no-ops when it reads it empty**
  (`prepareTrustedMessageSend` returns null on a blank draft — by
  design; same shape in `commitTrustedProfileSave` and
  `prepareTrustedRoomAdd`).
- events.md §2 rules serve ordering: *"per stream, events process in
  commit-seq order. Across streams in one space, wave order (arrival).
  No global ordering claim."* The two events live on different
  streams, so nothing promises the draft's consequence is applied
  before the send is served once both are pending — and under CI load
  (a busy serving loop right after the lockdown toggle's derivation
  storm) both ARE pending together.
- Served against a pre-draft view, the send terminalizes cleanly as a
  no-op: intent consequenced, quiescence clean, nothing logged, nothing
  to arrive, next step healthy. Exactly the observed signature.
- The real UI cannot produce this interleaving: the trusted send
  control is DISABLED until the draft state the clicking session sees
  is non-empty (`sendDisabled` derives from the draft read), which is
  why the browser test's OW47 S-G fix was precisely "wait
  `waitForDisabled(false)` before Bob's click". The multi-runtime
  helpers had no equivalent gate — they fired the trusted action into
  a UI-impossible window. The UI's protection is in fact STRONGER than
  the enablement read: the UI writes the draft through the cf-input
  `$value` BINDING — an authored client commit, transport-ordered
  before the click's event append on the same socket — not through a
  `setMessageDraft` event, so the served handler's read view includes
  the draft regardless of enablement timing; the enablement-read
  framing alone would not cover a hypothetical pattern whose
  precondition is handler-written and whose control enables off the
  speculative echo, and no such flow exists in this pattern.

**Product verdict: not a product regression.** The server served both
events within its ruled contract; the test manufactured an ordering
dependence the spec explicitly declines to promise. (This sharpens,
rather than contradicts, the census's "load-sensitive test-wait race"
framing: the race is BEFORE the awaited arrival — between the chained
events — not in the arrival wait itself. No widening of the arrival
wait could ever have fixed it, which is also why the flake survived
OW52.)

## 3. The honest signal, and why it cannot deadlock or pass vacuously

The gate a test needs between two chained events is the first event's
**terminal consequence having arrived back at the firing session** —
speculation.md §4 step 2's retirement, the outstanding-intent set the
overlay maintains. Once the consequence has arrived back, its commit is
in the space's history, so any LATER-fired event is served against a
view that includes it (the serving replica produced that consequence
itself). This is the same signal the real UI's enablement gate encodes,
and one the harness already trusted for `settle()` (OW52).

Made available in three layers, each event-driven:

- **`SpeculationOverlayDestination.waitForIntentQuiescence()`** (new,
  runner): resolves when the outstanding-intent set EMPTIES, settled by
  the same `#untrackIntent` step that retires the last intent;
  immediate when nothing is outstanding; settled on overlay close.
  First-order only, like the count it mirrors (a server-side cascade
  child is no client's intent). Pinned in
  `speculation-intent-listener.test.ts` with its killing mutation
  (flush on every untrack instead of on empty → the pin's
  mid-retirement flag assertion goes red; verified red under the
  mutation, green reverted).
- **`MultiRuntimeSession.awaitEventConsequences()`** (harness): awaits
  the overlay waiter; instant on the OFF arm (no overlay); backstopped
  by the harness's pre-existing 120 s RPC bound, which names the
  session and command — so a genuinely wedged consequence fails
  LOUDLY at the true blocked seam instead of as a downstream arrival
  lie. The worker's budgeted `eventQuiescence` (settle's arm) keeps
  its exact semantics but now races the same event-driven waiter
  against its budget timer instead of polling `pendingIntentCount` on
  a 25 ms tick.
- **The group-chat helpers** (`saveProfile`, `sendMessage`, `addRoom`)
  gate between the draft event and the trusted action. The arrival
  `waitFor`s are UNTOUCHED — with the race removed they are back to
  being the doctrine-sanctioned cross-runtime convergence polls, and
  their 30 s bound remains the failure bound. **No timeout was raised,
  lowered, added, or removed anywhere in this pass.**

Deadlock: every terminal kind (consequenced, errored, dropped, refused)
untracks, and close flushes waiters, so the gate resolves in every
product state except a truly wedged consequence — where the RPC bound
speaks with a name. Vacuity: the gate waits on the PRECONDITION event,
never on the awaited arrival, so it cannot mask loss — with the gate in
place, suppressing the delivery (the neutered-gate mutation below, or
any real served-write loss) still times the arrival wait out red.

## 4. Deterministic reproduction (delay injection at the racy seam)

Load-statistical repro was not attempted; the seam admits a
deterministic one, per the arc's dismiss-listener precedent. Topology:
two sessions of ONE user (the draft is PerUser, so both see it — two
tabs), the draft-writing session's WebSocket delayed 300 ms
(`wsDelayMs`, the harness's existing shaping shim), the draft fired
with `idle: false` so it is provably in flight when the other session
fires the trusted send.

- **Ungated (the red half, watched): 2/2 failures**, ~43 s each,
  `Timed out waiting for: the chained message arrives back at the
  sender`, quiescence clean, zero errors — byte-for-byte the CI
  signature. (Run as a scratch variant in this worktree against a
  fresh ON toolshed at :8891; deleted after recording.)
- **Gated (`awaitEventConsequences` between the events): 3/3 green**,
  14–18 s.
- **Committed pin**:
  `integration/cfc-group-chat-chained-event-gate-multi-runtime.test.ts`,
  two steps under the delayed topology: (1) the UI-enablement gate
  (sender fires only after ITS OWN read shows the draft) — both arms;
  (2) `awaitEventConsequences` ALONE suffices — ON arm (self-skips
  OFF with a logged line: the primitive is ON-only; OFF runs the
  handler in the firing session, so writer-side quiescence orders
  nothing there).
- **Mutation (vacuity check both directions)**: neutering the worker's
  `awaitEventConsequences` to resolve early → step 2 fails
  deterministically at 30 s with the CI signature while step 1 (its
  own gate) stays green; the overlay pin's flush-on-every-untrack
  mutation likewise goes red. Which-direction: the gate is a pure
  wait — it re-issues nothing and cannot double-apply.

## 5. The family: hardened vs left with receipts

Hardened:

- `cfc-group-chat-demo-multi-runtime.test.ts` — the three chained-event
  helpers gated (covers census items 1 and 3: the harness-sanity and
  admin-lockdown message arrivals, the grant-admin step's room chain —
  and strengthens the negative "bob's rejected add" assert, which an
  empty-draft no-op could previously satisfy while masking a broken
  admin gate).
- `cfc-group-chat-chained-event-gate-multi-runtime.test.ts` — new
  deterministic pin (above).
- `cfc-staged-publish.test.ts` (census item 2) — its four post-click
  plain `waitForText` waits → `waitForSettledText`. The ledgered
  "#stage-pill → saved" 5 m timeouts are the doctrine's named trap
  verbatim: the pill text is the EFFECT of the trusted click's served
  round trip, an integration test holds no UI subscription, and a
  plain DOM watch cannot pump the page's own pending pull work — the
  state sits one settle away from being drawn until the
  stuck-condition net fires (waiting-in-tests.md, "Waiting for a
  click's effect"). The settling wait is the prescribed shape (the
  lunch-poll test already uses it for every cross-browser wait);
  genuinely absent server state still fails it, so no loss is masked.
- `cfc-spec-gallery.test.ts` — same swap for its seven stage-indicator
  waits (the ledger's third member: one occurrence on main's own
  `e04fb3460` run).

Left as-is, with the reason on record:

- `cfc-group-chat-demo-two-browsers.test.ts`'s plain cross-browser
  `waitForText` calls (`#trusted-conversation-preview`,
  `#rooms-panel`): the same latent trap shape, but they sit inside the
  chat-series/propagation TIMING instrumentation (a load observation,
  never a gate, per the sx2 ruling) — converting them changes what the
  series measures (arrival+pump instead of passive render), and the
  file carries no receipts in tonight's cluster. Flagged, not filled.
  Its interaction gates (`waitForDisabled` before every send/add
  click) already encode the enablement contract.
- `cfc-group-chat-demo.test.ts` (single-browser): ON-skip-listed
  (OW31's carriage residual), OFF-safe by in-process ordering; not
  touched.
- Other post-click plain `waitForText` sites across the suite
  (`counter`, `cf-render`, `cf-checkbox`, …): same doctrinal shape,
  zero flake receipts; left for a doctrine-driven sweep of their own
  rather than riding this fix.
- The step's OTHER wait class (derived-state readbacks like
  `currentUserIsAdmin` after a toggle): single-event, no chained
  precondition, correctly served by the sanctioned convergence poll;
  untouched.

Recorded in passing (not this cluster): the failing run's harness
bootstrap logged one `piece-start-commit-failed` ConflictError
(piece-instantiate, stale confirmed read seq 0 vs 9) ~35 s before the
failure, during `openPiece` of a session racing the server's own
derived commits — benign for this cluster (all seven steps' state
flowed), noted for whoever owns the piece-start path.

## 6. Verification

All local against a fresh ON toolshed from source (:8891,
`EXPERIMENTAL_SERVER_EXECUTION=true`, `servingLoop` verified non-null);
OFF = the harness's self-hosted standalone server:

- `speculation-intent-listener.test.ts`: green (3 tests / 20 steps),
  and the FULL runner suite green with the overlay change (1273 tests /
  7302 steps, 10m49s; the lone red in that run was the new pin's own
  immediate-resolve probe racing a bare resolved sentinel — a
  microtask-order probe bug, fixed in the pin, file re-run green).
- `cfc-group-chat-demo-multi-runtime.test.ts`: 7/7 ON (16 s), 7/7 OFF.
- New pin file: 2/2 ON, 2/2 OFF (step 2 self-skip line printed).
- Harness family under the worker change: `convergence-storm` 4/4 ON;
  `cellset-lww` 4/4 ON; `data-file-multi-runtime` 2/2 ON.
- `deno check` clean on every changed file; `check-no-waitfor` green
  (no new polling `waitFor`; the new pin file waits through the
  harness's own primitives).
- Browser halves (`cfc-staged-publish`, `cfc-spec-gallery`): the swap
  is the doctrine's drop-in (same signature, same helper family the
  lunch-poll test uses); a local browser run needs a felt-built ON
  shell this pass did not stand up, so their behavioral verification
  rides the PR's ON/OFF pattern lanes — read those lanes before
  merging, per the merge ritual.

## 7. Register / prior-report reconciliation

- The OW52 report's §7 addendum ("this fix covers them", of census
  items 1+3) is CORRECTED by a dated note pointing here: the settle
  fix covers the mid-drain read race it was built for; tonight's
  receipts show the census flakes were the chained-event serve race,
  which no settle can close (the no-op is terminal before any wait
  begins).
- The register's OW52 row closure STANDS (the storm-loss triage was
  and remains correct); a dated addendum sentence on the row carries
  the same correction.
