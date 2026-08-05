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

**Run 2026-08-03** — six Sonnet trace runners (two traces each),
Fable adjudication. Verdicts: T1, T6, T7, T10 COMPLETE; T2 F(1);
T3 G(3); T4 G(5); T5 G(1); T8 G(1); T9 F(1); T11 F(1) C(2);
T12 G(1)→adjudicated COMPLETE. Adjudication deltas: T12.Q5's GAP
downgraded — "tightening is future work" is an explicit deferral,
which per §1 rule 5 IS the answer (the question's wording invited
the over-report); T9.Q1's counter mismatch and T11.Q1's missing
`actingSession` were CONTRADICTIONS with a determined direction and
are FIXED in the docs alongside this fold; T11.Q7 reconciled
(hook notifies, ACTIVE criteria decide — serving-loop §1). The
run's findings became ledger items **LT1–LT9** (§6) — **all RULED
2026-08-03, same day**, folded into the governing docs in one
batch; the affected cells below carry the ruled answers. Answers
are compressed to essence + citations; a re-run diffs against
these.

### T1 (COMPLETE)
- Q1: `authored`; envelope = S1's session (U1+S1). [protocol §1, §2]
- Q2: `{user:U1, session:S1, clientSeq}`; user+session server-stamped
  from envelope, clientSeq client-minted. [protocol §2; events §1]
- Q3: the event's stamped actor U1/S1, via `firedAt`. [scopes §5]
- Q4: yes — explicit `scope_key = "space"` (space is a key value, not
  an absent default); attribution = acting identity U1+S1. [protocol
  §1; scopes §Anchors, §7 M3]
- Q5: no principal (space scope pre-narrowing); no attribution — like
  the SpaceServer's own writes. [scopes §5; protocol §1, §2]
- Q6: `derived`; envelope = service identity/lease holder; `holder` +
  `derivedThrough: W` metadata + watermark doc := n in-transaction;
  `consequenceOf: [eventId]`. [protocol §1, §4, §7; serving-loop §2, §3]
- Q7: S2 receives the space-keyed rows (both writes here); any row
  keyed to another principal's instance would be ABSENT (not
  redacted); basis rows never push to anyone. [protocol §3]
- Q8: settled when `W ≥ seq(the hop-1 append)`. [protocol §4]

### T2 (FLAGS(1) — resolved by LT8; Q6 carries the resolution)
- Q1: the one well-known effects doc id at `scope_key =
  session:U1:S1`; the SpaceServer names the key, session identity
  consumed from stamped `firedAt`. [protocol §5; builtins §4]
- Q2: `{nonce, kind:"navigate", args:{target}, issuedIn}`; nonce
  minted server-side; exactly-once-per-nonce is the CLIENT's duty.
  [protocol §5]
- Q3: `authored`; envelope S1; the ack's instance RESOLVES from the
  authenticated session — the client names no key. [protocol §5, §1]
- Q4: SpaceServer's OWN write in the next wave's derived commit:
  addressing (`session:U1:S1`) but NO acting principal. [protocol §1, §5]
- Q5: no — logical write = authored commit EXCLUDING effect-channel
  acks. [serving-loop §3; testing §4]
- Q6: on resubscribe the client sees unacked intents and enacts;
  nonces make re-enactment detectable. (LT8 RULED 2026-08-03: the
  reload × optimistic window MAY re-enact — the record is the
  reload-wiped overlay — accepted for reversible effects, which
  every shipped kind is.) [protocol §5; speculation §1, §2]
- Q7: allowed; overlay records the nonce under `origin:
  intent(eventId)`; retires on the consequenced push; divergence =
  silent value replacement. [protocol §5; speculation §1, §2, §4]

### T3 (GAPS(3))
- Q1: `firedAt = {user:U1, session:S1}` INHERITED from H1's acting
  identity. [events §2; protocol §2] (LT7 RULED 2026-08-03: no
  `clientSeq` on server-originated events; stream seq orders.)
- Q2: eventId minted fresh per handler attempt; sound because only
  the committing attempt's cascades escape the wave. [events §4]
- Q3: (LT1 RULED 2026-08-03) the entry rides as a WRITE within the
  wave's own derived commit — eventId + inherited firedAt at write
  level, no separate admission (the lease check admits; one trust
  environment), idempotency via `eventWatermark`; never blocks the
  wave (same-space = own store; cross-space emissions go to the
  outbox post-commit). [events §1, §2; protocol §2, §7]
- Q4: U1/S1 — the event's (inherited) actor. [scopes §5; protocol §2]
- Q5: `session:U1:S1` — consequences land in the acting principal's
  instances. [scopes §5; scopes §Anchors]
- Q6: S1's effects instance — inheritance composes across hops.
  [builtins §4; protocol §5]
- Q7: CFC per action RUN, separately for H1 and H2, provenance in
  each write's payload, attached at seal. [serving-loop §3c, §3d;
  protocol §7]
- Q8: the wave commit carries `consequenceOf: [E1, E2]`; stream 1's
  `eventWatermark` advances in it. [serving-loop §3; events §4]
  (LT1 RULED: stream 2's entry, consequences, and watermark advance
  ride the same wave commit when processed same-wave; a
  budget-exhausted wave leaves the entry as durable input under the
  seq > `eventWatermark` reprocess rule. [events §2])

### T4 (GAPS(5))
- Q1: outbox entry = acting identity (U1+S1) + `capabilityRef` +
  stream link + fresh eventId + payload; `firedAt` is NOT carried —
  it is stamped at B. [protocol §2b, §7; events §4; serving-loop §5]
- Q2: `authored`; checks: metadata carries acting identity +
  capabilityRef → grant validated (never impersonation) → `firedAt`
  stamps from validated identity → CAS/eventId horizon. [protocol §2,
  §2b; events §4] (LT5 RULED 2026-08-03: the envelope is the
  producing SpaceServer's SERVICE identity — same envelope model as
  its derived commits; admissibility from the grant, never the
  envelope.)
- Q3: `{user:U1, session:S1}` from the carried delegation; envelope
  stamping would have produced `user:<serviceDID>` — the
  silent-empty-instance trap. [protocol §2; events §2] (clientSeq:
  none — LT7.)
- Q4: `session:U1:S1` in B's store per the rule [scopes §5]. (LT2
  RULED 2026-08-03: `sessionId` is CLIENT-GLOBAL — the key is
  well-formed in ANY space; foreign servers accept the carried pair
  under the inter-server trust ruling (future: remote attestation);
  retirement sweeps every space's instances. [protocol §5, §2;
  scopes §3])
- Q5: DEFERRED / runtime ERROR (LT3, RULED 2026-08-03) — H_B's
  chain is cross-space and S1 is not a connected session of B (the
  computing space), so the intent write ERRORS before any effects
  doc is touched; no subscription delivers anything, because there
  is nothing to deliver. Future direction recorded: client-vended
  stream target, reversing the flow. [builtins §4]
  (Re-run 2026-08-03 caught the first draft of this cell keeping
  its pre-ruling headline — the write asserted beside the ruling
  that forbids it. The ledger question itself had presupposed the
  write and asked only about delivery; the ruling answered one
  level deeper.)
- Q6: eventId uniqueness above B's `eventWatermark` at admission;
  post-horizon duplicates skip as `skippedIdempotent`. [protocol §2,
  §2b; events §4]
- Q7: (LT4 RULED 2026-08-03) transport failures retry
  (at-least-once); a DETERMINISTIC admission rejection does not —
  it surfaces as a failure notice on the SOURCE event's stream
  entry in A per the error-is-the-consequence shape; E1's own
  committed consequences stand. [protocol §2b; events §5]
- Q8: nothing cross-space is atomic; defined semantics = outbox
  retry + eventId dedupe + target `eventWatermark` exactly-once.
  [protocol §2b]

### T5 (GAPS(1))
- Q1: (a) `firedAt = {session:"server"}`, no user; session write
  ERROR, user write ERROR, navigateTo ERROR. [events §2; scopes §5;
  builtins §4]
- Q2: (b) carries acting user U1, session stays `"server"`; user
  write now succeeds; session write and navigateTo still ERROR.
  [events §2; scopes §5; protocol §2]
- Q3: (c) (LT6 RULED 2026-08-03: inheritance is UNIFORM across run
  kinds) a session-demanded derivation's emitted event carries
  `{user:U1, session:S1}` — the chain is session-bearing; only
  space-/user-instance runs and timers emit sessionless.
  [events §2; scopes §5]
- Q4: error at RUN time (runtime check, not admission/seal); recorded
  via events §5's handler-error surface, watermark advances past it.
  [events §2, §5; builtins §4]

### T6 (COMPLETE)
- Q1: U1, supplied by the demand. [protocol §2; scopes §5]
- Q2: exactly two writes — the broad-slot redirect at `space`
  (SpaceServer-own, addressing only, no principal) and the value at
  `user:U1` (attributed U1); NO sibling writes. [scopes §2; protocol §1]
- Q3: two eager hops (space→user→session, always via user) vs main's
  one hop per narrowing event. [scopes §2]
- Q4: S1 gets redirect + `user:U1` row; S2 gets the redirect only —
  U1's instance row is ABSENT for S2. [protocol §3; scopes §4]
- Q5: U2's run identity = U2 from its own demand; W never waits on
  the UNDEMANDED sibling, and waits on it once demanded, under the
  budget rule. [scopes §2; protocol §4; serving-loop §3]
- Q6: basis rows keyed with `action_scope_key = user:U1`, overwritten
  per (action, instance); the stranded `space`-key rows are DELETED
  in the same wave tx. [serving-loop §3b]
- Q7: the redirect is permanent; later broader runs write THROUGH it;
  widen-back is closed NO. [scopes §2]

### T7 (COMPLETE)
- Q1: two runs (one per demanded user instance); identities U1 and
  U2 from the demands. [scopes §6, §2; protocol §2]
- Q2: memo keys differ by the instance key hashed in; stored as
  `requestHash` beside each result at `(doc, user:U1)` /
  `(doc, user:U2)`. [scopes §6; serving-loop §4; scopes §Anchors]
- Q3: (space, memo key, request, authority handle, identity
  carriage — result-cell address incl. `scope_key` + acting
  identity); the carriage exists because the completion never passes
  sealing and the memo key hashes the instance in unrecoverably.
  [serving-loop §4, §5; README §3.8]
- Q4: `derived`, service envelope; annotations (`scope_key =
  user:U1`, acting identity U1) sourced from the outbox carriage
  captured at the original run's seal. [protocol §1, §2;
  serving-loop §3d, §4]
- Q5: U1 memo-hits (suppressed); U2 memo-misses (re-fires); the
  external call may run twice — at-least-once RULED and accepted;
  fired-marker considered and REJECTED. [serving-loop §4, §6]
- Q6: one outstanding effect per key per space; the second miss
  attaches in-flight. [serving-loop §4]
- Q7: DEFERRED — quota attribution explicitly open. [README §3.8,
  §6; scopes §6]

### T8 (GAPS(1))
- Q1: client-side unacked `authored` event appends, in fired order.
  [events §5; speculation §5] (LT9 RULED 2026-08-03: the queue is
  DURABLE client-side, same persistence class as `sessionId` — a
  reload while offline preserves it.)
- Q2: discharge in fired order (RULED). [events §5; speculation §5]
- Q3: DROP — "a doc the handler must write was deleted meanwhile"
  meets the unrunnable predicate verbatim; a raced consequence
  commit would REQUEUE instead. [events §5; serving-loop §3d]
- Q4: `{status:"dropped", reason}` on the stream entry itself,
  written as E2's consequence in the wave's derived commit,
  advancing the watermark (non-wedging); retires when the stream
  compacts below `eventWatermark`. [events §4, §5; protocol §1]
- Q5: advanced past all three (E2 via the drop rule) = E3's seq.
  [events §4, §5]
- Q6: speculative echo from the overlay while offline; the drop
  notice retires `intent(E2)` entries — the echo un-renders; notice
  is the UI hook. [speculation §4, §5; events §2, §5; README §3.2]

### T9 (FLAGS(1) → fixed) (re-verified after the 2026-08-05 Q1 ruling; Q1 cell updated)
- Q1: superseded derived write DROPPED from the wave commit (sound:
  re-derivable); the drop itself RE-ARMS NOTHING — recompute, if
  any, arrives only via the ordinary dependency path: the concurrent
  commit is next wave's input and recomputes exactly the runs whose
  recorded reads it dirties, with no superseded-write mark; counted
  `supersededWrites`. [serving-loop §3d, RULED 2026-08-05] (The
  counter was missing from §7's stats shape — FIXED with this fold.)
- Q2: non-re-derivable writes REBASE AND RETRY with field-level
  merge; the watermark advance and its consequences move TOGETHER,
  never separately. [serving-loop §3d; events §4]
- Q3: semantic rebase conflict ⇒ REQUEUE (ran, raced) — distinct
  from DROP (cannot run at all) — distinct again from the
  superseded-WRITE drop. [serving-loop §3d; events §5]
- Q4: whole-wave CAS failure FORBIDDEN (livelock). [serving-loop §3d]
- Q5: W advances NOT AT ALL on budget exhaustion; the commit carries
  `derivedThrough` = current W; continuation waves carry the
  cascade. [serving-loop §3]

### T10 (COMPLETE)
- Q1: committed state (incl. `requestHash` memo keys), W,
  `eventWatermark`, the basis index — and nothing else. [serving-loop
  §3b, §6; protocol §4; events §4; README §2]
- Q2: dirty iff a recorded input seq is behind that doc's current
  head; subscribe from the scan head. [serving-loop §3, §6]
- Q3: own derived commits are echo-skipped live, so replay cannot
  re-mark the frontier. [serving-loop §3, §3b, §6]
- Q4: memo hits suppress; misses re-fire; the external call may
  duplicate — at-least-once RULED, fired-marker REJECTED.
  [serving-loop §4, §6]
- Q5: stream head past `eventWatermark` at boot ⇒ reprocess; at-or-
  below skips as `skippedIdempotent`. [serving-loop §1, §6; events §4]
- Q6: the evidence log (payloads, per-run history, certificates,
  replay) is FORBIDDEN; the test: payloads/history ⇒ evidence,
  ids+seqs overwritten per (action, instance) ⇒ basis.
  [serving-loop §3b, §6, §8]

### T11 (FLAGS(1) CONTRADICTIONS(2) → both fixed)
- Q1: `authored`, under the event's acting identity, metadata =
  acting identity + `capabilityRef`, delegated-capability check at
  C. [protocol §2, §2b] (§2b's provisioning sentence omitted
  `actingSession` — CONTRADICTION, FIXED with this fold.)
- Q2: foreign-first, home-after-success, stop-at-first-failure —
  the kept `commitMultiSpace` split relocated to the wave commit
  step. [protocol §2b; serving-loop §3d]
- Q3: DIDs derive from the creation event; determinism (payload +
  cells only) makes replay a CAS no-op. [protocol §2b; events §3]
- Q4: breaks provisioning determinism; enforcement today = none
  (transformer lint trails, non-blocking). [events §3; protocol §2b]
  **FLAG (standing risk, accepted posture)**: replay convergence is
  load-bearing on a property whose only guard is deferred.
- Q5: foreign-landed/home-lost = the orphan window; requeue +
  deterministic re-derivation converge it (CAS no-op at C, home
  commit retries). [protocol §2b; serving-loop §3d]
- Q6: never derived-class — single-deriver per space; C's own
  SpaceServer is its only deriver. [protocol §2b; README §1]
- Q7: C activates on first session or event — the admission hook
  NOTIFIES but the ACTIVE criteria decide, so the provisioning
  write alone leaves C parked. (Was a CONTRADICTION between §2b and
  serving-loop §1's plane (b) — RECONCILED in serving-loop §1 with
  this fold; vetoable.)

### T12 (adjudicated COMPLETE) (re-verified after the 2026-08-05 Q1 ruling; Q4 cell updated)
- Q1: speculate pure structural + handlers + optimistic navigate +
  overlay-local children; own instances ONLY; never effectful nodes
  (read through to last committed result, pending on key change) or
  foreign instances. [speculation §2, §6; scopes §4; README §1, §3.5]
- Q2: commits ONLY the event append; handler writes are overlay-only.
  [speculation §2, §6; events §7]
- Q3: retirement on pushed derived commits, keyed `origin:
  intent(eventId)` matched against `consequenceOf`. [speculation §1, §4]
- Q4: the authored write is ADMITTED (target ACL + CAS only);
  mid-wave, the WAVE's write is the one dropped
  (`supersededWrites`). Recompute is NOT automatic: the drop
  re-arms nothing, and a derivation that blind-writes this doc
  without reading it back is never dirtied by the intruding write,
  so the derived doc holds the authored value until the
  derivation's own upstream inputs next change — "the derived
  output waits for the next input change" (owner, RULED
  2026-08-05). Single-deriver protects against dual DERIVED
  committers by construction; it is NOT an ACL on derived-output
  docs — this scenario is exactly that gap. [protocol §1, §2;
  serving-loop §3d RULED 2026-08-05; README §1]
- Q5: watermark forgery possible and ACCEPTED (owner 2026-08-02,
  no-new-guarantees); "what tightening requires" is an explicit
  deferral — future work. [protocol §1; README §1]
- Q6: ordinary speculation divergence; silent value replacement on
  reconciliation. [README §3.6; speculation §3, §4]

## 5. Findings routing

GAP / FLAG / CONTRADICTION findings from any run go to the PR
rulings ledger as candidate items — traces never edit the
governing docs. A ruling that changes a detail doc updates the
affected reference answers in the SAME PR (README's
docs-move-together rule applies to this file too).

## 6. Run 2026-08-03 items (LT1–LT9) — ALL RULED same day

Each names its trace cell; rulings folded into the governing docs
in the same batch, and the §4 reference cells carry the ruled
answers.

- **LT1 (T3.Q3/Q8; was blocking Phase 3) — RULED: wave-carried.**
  The same-space server-emitted append's durable entry is a WRITE
  within the wave's own derived commit — `eventId` + inherited
  `firedAt` at write level, admitted by the lease check (one trust
  environment), deduped by `eventWatermark`; never blocks the wave
  (events.md §2; protocol.md §2, §7; events.md §1's definition
  narrows to client-fired + delegated appends).
- **LT2 (T4.Q4) — RULED: `sessionId` is CLIENT-GLOBAL.** The same
  value identifies the session in every space; foreign servers
  accept the carried (principal, session) pair as if written
  directly — inter-server trust is assumed, hardening via remote
  attestation anticipated; retirement sweeps all spaces
  (protocol.md §5, §2; scopes.md §3).
- **LT3 (T4.Q5) — RULED: cross-space navigateTo DEFERRED.** The
  intent write requires the acting session CONNECTED to the
  computing space (no connection = no delivery channel); in
  practice the producing handler is an immediate click consequence,
  so the CONTEXT is same-space even when the TARGET is a foreign
  link. Future direction recorded: the client VENDS its own stream
  target, reversing the flow (builtins.md §4).
- **LT4 (T4.Q7) — RULED:** transport failures retry; a
  deterministic admission rejection does not — it surfaces as a
  failure notice on the source event's stream entry
  (error-is-the-consequence; protocol.md §2b).
- **LT5 (T4.Q2) — RULED:** the outbox commit's envelope is the
  producing SpaceServer's SERVICE identity; admissibility from the
  validated grant, never the envelope (protocol.md §2).
- **LT6 (T5.Q3) — RULED: inheritance is UNIFORM across run
  kinds.** A demanded derivation run's identity inherits into its
  emitted events exactly as a handler run's does; session-demanded
  runs emit session-bearing events (events.md §2; scopes.md §5).
- **LT7 (T3.Q1, T4.Q3) — RULED:** server-originated events carry
  no `clientSeq`; stream seq orders them (events.md §2).
- **LT8 (T2.Q6) — RULED: accepted.** The reload ×
  optimistic-enactment window may re-enact a nonce; acceptable for
  reversible effects, which every shipped kind is (protocol.md §5).
- **LT9 (T8.Q1) — RULED:** the offline event queue is DURABLE
  client-side, same persistence class as `sessionId` (events.md
  §5).
