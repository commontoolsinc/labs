# v2 verification: scenario traces — evaluate the spec on inputs

**Verification instrument, NON-NORMATIVE.** The detail docs govern;
a trace never overrides them. What a trace does is force the
composition question the doc-by-doc organization hides: twelve
canonical end-to-end journeys, each traced hop by hop, with every
load-bearing value — identity, `scope_key`, commit class, envelope,
stamp source — written down explicitly WITH A CITATION. A cell that
cannot be filled from the docs alone is a GAP. A cell that fills
with a wrong-feeling value is a FLAG. Two docs disagreeing is a
CONTRADICTION. All three route to the PR rulings ledger; the
governing docs stand until a ruling lands.

Origin (2026-08-03): three doc-scoped review rounds missed that
events.md §2 blanketed ALL server-originated events — cascades
included — with `firedAt.session = "server"`, which would have
sessionless-errored any navigateTo more than one hop from the
click. The owner caught it by tracing one concrete journey (T3
below). This suite exists so that class of bug is caught by
procedure, not luck.

## 1. Execution protocol (binding on trace runs)

Trace runs are designed to be executed by SMALLER-MODEL agents;
the rigor lives in these rules, not in the runner's judgment:

1. **Cite or GAP — never infer.** Every filled cell carries a
   citation (doc + section, e.g. `protocol §2`). If no passage
   answers the question, write `GAP:` plus the precise question a
   ruling must answer. Do NOT fill a gap by analogy with
   neighboring text — that is exactly how the `session = "server"`
   bug was once codified (a review patterned an unstated stamping
   rule off nearby text that was itself wrong).
2. **FLAG, don't fix.** If a cell fills cleanly but the value looks
   wrong for the product (an intent addressed to a session that
   cannot enact it; a value one principal wrote appearing in
   another's push), write the value, its citation, AND
   `FLAG: <why it looks wrong>`. Never adjust the answer to what
   seems intended.
3. **CONTRADICTION when citations disagree.** If two passages give
   different answers, record both citations and stop — do not pick.
4. **Positive evidence only.** "All clean" without per-cell
   citations is an invalid run. The deliverable is the filled
   cells; absence of findings is not evidence of anything.
5. **Deferrals are answers.** If a doc explicitly defers something
   (e.g. quota attribution), the correct cell is the deferral plus
   its citation — not an invented answer, not a GAP.
6. **Scope of reading**: the nine detail docs plus README and the
   plan. Code anchors may be consulted to disambiguate a citation
   but never to answer a question the docs do not — the spec must
   stand alone (a question the docs cannot answer is a GAP even if
   the code answers it).

**Output format per trace**: for each question, one block —
`T<n>.Q<m>: <answer> [<citations>]` or the GAP/FLAG/CONTRADICTION
form — followed by a per-trace verdict line:
`T<n>: COMPLETE | GAPS(k) FLAGS(j) CONTRADICTIONS(i)`.

**Re-run cadence**: after every ruling batch that edits a detail
doc, re-derive the affected traces and diff against the reference
answers below. A changed reference answer is expected exactly when
a ruling meant to change it; any other drift is a finding.

## 2. The standing cast

Used by every journey. `U1`, `U2` — users (principals). `S1` — a
live session of U1; `S2` — a live session of U2. Space `A` is home
unless said otherwise; `B` is a second co-hosted space. The flag is
ON (Phase 2+ posture; per-journey notes say when a later phase's
surface is in play).

## 3. The journeys

### T1 — Baseline: one click, space-scoped consequences

Purpose: the envelope→annotation flow with no complications.
Setup: a piece in A with a handler writing space-scoped state; a
derivation downstream of that state. S1 and S2 both subscribe.
Hops: (1) S1 fires the handler; client commits the event append.
(2) Admission. (3) Wave: handler runs. (4) Downstream derivation
runs. (5) Wave commit. (6) Push to S1 and S2.

- T1.Q1 — Hop 1 commit: class, and envelope identity.
- T1.Q2 — `firedAt` after admission: full value, and the source of
  each field.
- T1.Q3 — Hop 3 run identity: what does the handler run as, and
  what supplies it?
- T1.Q4 — The handler's space-scoped write inside the wave commit:
  does it carry an explicit `scope_key`? Which one, or what rule
  covers the space-scope default? What attribution annotation does
  it carry?
- T1.Q5 — Hop 4 derivation run identity (no narrowing yet): what
  identity, what attribution on its write?
- T1.Q6 — Hop 5 wave commit: class, envelope identity, watermark
  fields, `consequenceOf` contents.
- T1.Q7 — Hop 6: exactly which rows does S2 receive? Which rows
  would S2 NOT receive, and by what rule?
- T1.Q8 — When does S1 count as "settled" for this click?

### T2 — navigateTo, one hop: the effect channel end to end

Purpose: the client-enacted effect lifecycle (Phase 4 surface).
Setup: as T1, but the handler's consequence computes a navigateTo.
Hops: (1) click → event append. (2) Wave: handler + served
navigateTo half. (3) Intent write. (4) Wave commit + push. (5) S1
enacts, commits the ack. (6) Next wave retires the entry.

- T2.Q1 — The intent write: exactly which doc INSTANCE (doc id
  rule + `scope_key`), and who names that key?
- T2.Q2 — The intent's shape: fields, and where the nonce
  discipline lives.
- T2.Q3 — Hop 5 ack commit: class, envelope, and how the ack's
  target instance is addressed (does the CLIENT name a key?).
- T2.Q4 — Hop 6 retirement write: whose write is it, what identity
  annotations does it carry (acting principal? addressing?), and
  under what citation?
- T2.Q5 — Amplification accounting: does the ack count as a
  logical write in the ≤2 gate? Citation.
- T2.Q6 — S1 reloads between intent and ack: what happens, exactly
  once by what mechanism?
- T2.Q7 — Optimistic enactment from speculation: allowed? How does
  it reconcile?

### T3 — Cascade, two hops: inheritance on home turf

Purpose: the bug's home. Actor identity across a same-space
handler cascade (Phase 3 surface).
Setup: H1's consequence emits `stream.send()` to a second stream in
A; H2 (that stream's handler) writes SESSION-scoped state and
computes a navigateTo.
Hops: (1) S1 click → event E1 append. (2) Wave: H1 runs, emits E2.
(3) E2 enters processing. (4) H2 runs. (5) H2's session-scoped
write + navigateTo intent. (6) Wave commit.

- T3.Q1 — E2's `firedAt`: full value and source rule.
- T3.Q2 — E2's `eventId`: minted when, fresh or stable per attempt,
  and why that is sound.
- T3.Q3 — E2's durable carriage: does E2 get a stream-doc entry?
  In WHICH commit (class, producer), with what metadata? (If the
  docs do not say how a same-space server-emitted append is
  committed, that is a GAP — state it precisely.)
- T3.Q4 — H2's run identity.
- T3.Q5 — H2's session-scoped write: exactly which instance
  (`scope_key`), by what rule?
- T3.Q6 — H2's navigateTo: which session's effects instance
  receives the intent? Citation for why this composes at two hops.
- T3.Q7 — CFC evaluation for H1 and H2: at what unit, and where
  does each run's provenance ride?
- T3.Q8 — `consequenceOf` and `eventWatermark` for E1 and E2:
  which commit(s) advance what?

### T4 — Cross-space event: inheritance across the boundary

Purpose: identity carriage through the outbox (Phase 5 surface).
Setup: H_A in space A appends to a stream in space B (the piece
holds the append capability). H_B writes session-scoped state in B
and computes a navigateTo.
Hops: (1) S1 click in A → E1. (2) A's wave: H_A runs, emits the
foreign append. (3) Outbox carries it. (4) B's admission. (5) B's
wave: H_B runs; session write + navigateTo. (6) B's wave commit +
push.

- T4.Q1 — The outbox entry for the append: exact contents.
- T4.Q2 — The append commit at B: class, envelope identity,
  metadata fields, and each admission check in order.
- T4.Q3 — `firedAt` stamped at B: value and source. What would
  stamping from the arriving commit's envelope have produced, and
  what rule forbids it?
- T4.Q4 — H_B's session-scoped write: which instance? Note
  precisely what the docs say `sessionId` is scoped to — if the
  docs do not establish that S1 is a meaningful session identifier
  IN SPACE B, state the GAP.
- T4.Q5 — H_B's navigateTo intent: which effects instance, in
  which space — and by what subscription does S1's client learn of
  it? (Same caution as Q4: cite or GAP.)
- T4.Q6 — Retry: the outbox re-sends after a crash; what dedupes
  the second append, at what horizon?
- T4.Q7 — B's admission rejects the capability grant: what happens
  to E1's consequences in A, and what does the client see?
- T4.Q8 — Atomicity: what, exactly, is NOT atomic across A and B,
  and what defined semantics replace it?

### T5 — Sessionless chains: the errors that must stay errors

Purpose: the narrowed meaning of `session = "server"`.
Setup: (a) a space-scope derivation's `stream.send()` emits E_d;
its handler H_d attempts a session-scoped write, a user-scoped
write, and a navigateTo. (b) The same, but the emitting derivation
runs as a DEMANDED user instance (U1). (c) The same, but the
emitting derivation runs as a demanded SESSION instance (U1, S1).

- T5.Q1 — Case (a): E_d's `firedAt`. H_d's session write, user
  write, navigateTo: allowed or error, each with citation.
- T5.Q2 — Case (b): E_d's `firedAt` — does it carry U1? Citation.
  Which of H_d's three writes now succeed?
- T5.Q3 — Case (c): does the demanded SESSION instance's identity
  make E_d's chain session-bearing — i.e. does actor inheritance
  extend to a derivation run's demand-supplied identity, or only
  to handler runs? Cite the exact text; if the docs only say
  "emitted by a handler run", state the GAP precisely rather than
  extrapolating.
- T5.Q4 — For the error cases: error at what moment (fire, run,
  seal, admission), and what surface records it?

### T6 — Narrowing and fan-out: instances materialize on demand

Purpose: scope discovery, redirects, sibling demand, push filtering.
Setup: a node starts space-scoped; U1's demanded run reads
user-scoped state and discovers user narrowing. Later U2's client
demands the node. S1, S2 subscribe throughout.
Hops: (1) U1's run discovers narrowing. (2) The discovering wave's
writes. (3) Push after that wave. (4) U2's demand arrives. (5)
U2's instance run + wave. (6) Basis-index effects.

- T6.Q1 — Hop 1 run identity, and what supplied it.
- T6.Q2 — Hop 2: enumerate EVERY write the discovering wave makes
  for this node, each with its address (`scope_key`), producer
  attribution, and citation. Which writes does it NOT make?
- T6.Q3 — The redirect chain shape for a space→session discovery:
  how many hops are written eagerly, and how does that differ from
  main?
- T6.Q4 — Hop 3: what do S1 and S2 each receive? May S2 see U1's
  instance rows?
- T6.Q5 — Hop 4/5: what identity does U2's instance run assume;
  does W wait for it before U2 demands it?
- T6.Q6 — Hop 6: the basis rows for the discovering run — keyed
  how, and what happens to rows recorded under the OLD (broader)
  instance key?
- T6.Q7 — A later broader-scoped run writes to the narrowed slot:
  what happens to the redirect?

### T7 — Effectful node, two users: memo, outbox, completion

Purpose: per-instance effect identity and the completion commit —
the one derived commit that never passes sealing.
Setup: a USER-scoped `generateText` node; U1's and U2's instances
both demanded. One request each leaves the outbox; U1's completes
normally; the host crashes after U2's request left but before its
completion commit.

- T7.Q1 — Run cardinality and each run's identity. Citations.
- T7.Q2 — The two memo keys: what makes them distinct? Where is
  each stored?
- T7.Q3 — The outbox entries: full contents, including what
  carries each run's instance and identity to the completion.
- T7.Q4 — U1's completion commit: class, envelope, and the
  annotations on the result write — sourced from where, given that
  sealing never sees this commit?
- T7.Q5 — The crash: on recovery, what re-fires U2's effect and
  what prevents re-firing U1's? At-least-once: what duplicate is
  possible and why is it accepted?
- T7.Q6 — In-flight dedupe: a second miss on U2's key mid-flight —
  what happens?
- T7.Q7 — Whose quota is each run charged against?

### T8 — Offline discharge: order, drops, notices

Purpose: the offline event queue and the drop predicate (Phase 3).
Setup: S1 goes offline; fires E1, E2, E3. Before reconnect,
another client deletes the doc E2's handler must write. S1
reconnects.

- T8.Q1 — Where do E1–E3 live while offline, and what are they
  (class, durability)?
- T8.Q2 — Discharge on reconnect: order rule.
- T8.Q3 — E2: drop or requeue? State the predicate VERBATIM-close
  and why E2 meets it; contrast with the case that would requeue
  instead.
- T8.Q4 — The dropped-event notice: exact location, shape, who
  writes it, in which commit, and when it retires.
- T8.Q5 — `eventWatermark` after processing E1–E3.
- T8.Q6 — What did S1's UI show for E2's effects while offline,
  and what reconciles it after the drop signal?

### T9 — Mid-wave conflict: drop, rebase, requeue

Purpose: the three conflict notions that share one section.
Setup: a wave is computing over input batch [s..n]. Mid-wave, an
authored commit lands touching (a) a doc a pure derivation in the
wave writes, and (b) the stream doc whose `eventWatermark` the
wave advances.

- T9.Q1 — Write (a): what happens to the wave's derived write for
  that doc, why is that sound, and what counter records it?
- T9.Q2 — Write (b): what happens to the watermark advance and the
  handler consequences — one mechanism, stated precisely. What
  moves together, and what may never move separately?
- T9.Q3 — The rebase conflicts semantically: what happens to the
  affected events? Distinguish REQUEUE from events.md §5's DROP —
  predicate for each.
- T9.Q4 — Whole-wave CAS failure: allowed? Citation.
- T9.Q5 — Does W advance for this wave if the cascade has not
  quiesced within budget? What does the commit carry then?

### T10 — Crash and recovery: the index-guided re-mark

Purpose: recovery is re-marking, never replay.
Setup: the host crashes mid-wave (after some effect requests left,
before the wave commit). A deploy brings up a new host.

- T10.Q1 — What survives the crash as correctness-bearing state?
  Complete list, each with citation.
- T10.Q2 — Activation on the new host: the re-mark rule, exactly —
  what makes a node dirty, and against what head?
- T10.Q3 — Why can commit replay NOT substitute for the index?
- T10.Q4 — Which effects re-fire and which are suppressed? What
  external duplicate is possible, and what ruling accepted it?
- T10.Q5 — Undelivered events at boot: detected how, reprocessed
  under what idempotency rule?
- T10.Q6 — What per-run state is FORBIDDEN to persist for
  recovery, and what test distinguishes the basis index from it?

### T11 — `.inSpace` provisioning: the second sanctioned crossing

Purpose: foreign-first commit order and replay convergence.
Setup: S1's click in A runs a handler that provisions a new space
C via `.inSpace()` (profile-create shape), then links C from A.

- T11.Q1 — The provisioning writes into C: class, acting identity,
  carried metadata, and the admission path at C.
- T11.Q2 — Commit order across C and A, and what enforces
  stop-at-first-failure.
- T11.Q3 — C's DID: derived from what, and why does a replayed
  handler converge on the SAME space?
- T11.Q4 — The handler uses `Date.now()` in the provisioning path:
  what rule does it break, and what enforces it (now vs later)?
- T11.Q5 — Foreign provisioning landed, home commit lost the CAS:
  state of the world, and how it converges.
- T11.Q6 — Could the provisioning commits be derived-class into C?
  Why not — which invariant?
- T11.Q7 — When does C's SpaceServer first activate?

### T12 — Speculation and the racing writer

Purpose: overlay identity limits and the threat-model outcome.
Setup: S1 speculates a handler + downstream graph locally while
the authoritative path runs. Separately, a client holding write
authority authors directly into a doc the SpaceServer derives
into (the watermark doc too).

- T12.Q1 — What may S1 speculate, and which instances may the
  overlay hold? What can it NOT speculate, and what does it read
  instead at effectful nodes?
- T12.Q2 — What does the speculative handler run COMMIT? What does
  it never commit?
- T12.Q3 — Reconciliation: what retires the overlay entries, keyed
  by what?
- T12.Q4 — The authored write into the derived-output doc: admitted
  or rejected? What happens next wave? What does this mean the
  single-deriver invariant does and does NOT protect against?
- T12.Q5 — The forged watermark write: possible? Accepted? Under
  what ruling, and what would tightening require?
- T12.Q6 — Speculative divergence (clock/randomness in the
  handler): what class of problem is this, and how does it
  resolve?

## 4. Reference answers

Pending the first adjudicated pass (run 2026-08-03, six
smaller-model trace agents + owner-tier adjudication). Verified
answers get folded in here per trace, each cell keeping its
citation; subsequent runs diff against them per §1's re-run
cadence.

## 5. Findings routing

GAP / FLAG / CONTRADICTION findings from any run go to the PR
rulings ledger as candidate items — traces never edit the
governing docs. A ruling that changes a detail doc updates the
affected reference answers in the SAME PR (README's
docs-move-together rule applies to this file too).
