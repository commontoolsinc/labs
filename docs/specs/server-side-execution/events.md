# v2 detail: events — the client's computational commit

Normative spec for Phase 3 (D-v2-1). Assumes
[README.md](README.md) §3.6 and [serving-loop.md](serving-loop.md).

## Anchors (verified on main, 2026-08-02 — re-verify before coding)

- Event machinery: `packages/runner/src/scheduler/events.ts`
  (`queueSchedulerEvent`, `addSchedulerEventHandler`,
  `SchedulerEventQueueState`), durable identity in
  `packages/runner/src/scheduler/event-identity.ts`, preflight in
  `event-preflight-dependencies.ts`. The server-side handler run reuses
  this machinery inside the SpaceServer's runtime — do not build a second
  event executor.
- Handler registration rides the SpaceServer's graph-structure load
  for demanded values and queued events (serving-loop.md §1 — no
  piece-start step); `addSchedulerEventHandler` is already the hook.

## 1. The event, as data

An event is an **authored append to a stream document**:

```jsonc
// committed by the client session, ordinary authored commit
{
  "stream": <entity link to the stream doc>,
  "eventId": <durable id from event-identity>,     // client-minted
  "payload": <JSON>,                                // see §3
  "firedAt": {                    // SERVER-STAMPED — see below
    "user": <principal DID>,      //   from the commit envelope
    "session": <sessionId>,       //   from the commit envelope
    "clientSeq": n                //   client-minted; orders one
  }                               //   session's own appends only
}
```

Admission (protocol.md §2): append authority on the stream doc + CAS.
Nothing about the event says or implies "I ran something."

The "authored append" definition covers CLIENT-fired and DELEGATED
(cross-space) events. A server-emitted SAME-SPACE event has the
identical shape — minus `clientSeq`, which is client-minted only
and absent on every server-originated event (§2, LT7) — but
different carriage: it rides as a
stream-entry WRITE within the wave's own derived commit — §2's
same-space carriage rule (LT1, RULED 2026-08-03).

**Field provenance, normatively (T1 + S6).** `eventId` and `firedAt`
are ENVELOPE fields for admission, not payload — admission reads
both (protocol.md §2, §7). `firedAt` is **server-stamped**: the
memory server writes `user` and `session` from the authenticated
commit envelope at admission, and a client-supplied `firedAt` that
disagrees is REJECTED, never corrected. For DELEGATED appends
(protocol.md §2's server-produced authored row) the stamp source is
the VALIDATED acting identity carried in the commit metadata — the
originating chain actor, per §2's inheritance rule — never the
delegating envelope; the value is server-controlled either way.
It carries the USER as well
as the session because scopes.md §5 resolves a handler's scoped
reads and writes against the acting user; deriving the user from the
append later would reintroduce exactly the binding the stamp already
made. `payload` is the only client-authored content field, and
`clientSeq` the only client-minted part of `firedAt`.

The shape is settled as specced — every field above is load-bearing
(RULED 2026-08-02); a later follow-up adds integrity provenance to
events (e.g. attesting an authentic DOM origin).

## 2. Lifecycle, end to end

```
client                          server (SpaceServer)
------                          --------------------
handler fires
├─ capture payload (§3)
├─ commit event append ────────► subscription delivers commit
├─ speculative echo:            ├─ classify: event-append
│  run handler + graph          ├─ enqueue via facade.queueEvent
│  on the overlay               ├─ wave: handler runs AUTHORITATIVELY
│  (speculation.md)             │  (writes = ordinary in-memory writes)
│                               ├─ derivations run to fixpoint
│                               └─ ONE derived commit, carrying
│                                  consequenceOf: [eventId...] and the
◄──────────────────────────────────watermark; push to subscribers
└─ reconcile: overlay entries
   for eventId retire; rendered
   state now authoritative
```

- Server-originated events (`stream.send()` from a handler cascade
  or a served computation, piece-to-piece) enter at "enqueue" and
  are otherwise identical — one path, two producers — but their
  ACTOR is INHERITED, never blanked (owner, 2026-08-03): **an event
  emitted by ANY run carries that run's acting identity — events
  run as the session they originated from.** Uniform across run
  kinds (LT6, RULED 2026-08-03): a handler run's emitted event
  carries the event actor the handler ran as; a DEMANDED derivation
  run's emitted event carries the demand-supplied instance identity
  — a session-instance run's event is session-bearing
  (`firedAt = {user, session}`), a user-instance run's carries the
  user with `session = "server"`, a space-scope run's carries
  neither. A cascade
  rooted in a client event therefore preserves the ROOT
  (user, session) hop by hop, so session-scoped consequences land
  in the ORIGINATING session's instances (scopes.md §5) —
  navigateTo above all, whose intent must address the session that
  actually acted (builtins.md §4). Only an event with NO acting
  session anywhere in its chain — a space- or user-instance
  derivation's `stream.send()`, a
  timer — enters with `firedAt.session = "server"`. Server-
  originated events carry NO `clientSeq` (LT7, RULED 2026-08-03):
  `clientSeq` orders one CLIENT session's own appends and nothing
  else; server-emitted entries are ordered by stream seq alone.
  **The renderer-trust attestation rides the durable entry (fan-out
  stage B, 2026-08-17 — verification-coverage.md OW34; the sister of
  the entry's `runtimeInjectedEventKeys` carriage — the runtime-
  injection provenance the served dispatch re-mints so the closed-
  world gate judges the payload as the firing client's runtime did —
  and re-minted with the same in-process trust argument).** A client-fired event's entry
  carries `rendererTrusted: true` IFF the firing RUNTIME saw the
  process-local renderer-trust mark on the sent event (the mark the
  renderer's dispatch sets and pattern code cannot reach) — the
  runtime writes it, never the pattern, and admission refuses any
  value but `true`; absent means not attested. The served dispatch
  RE-MARKS the entry's payload before the handler runs, so a per-user
  served handler's UI-contract-gated (owner-protected) write records
  the trusted-event policy input the CFC ladder requires — under the
  same in-process trust the client-side gate ran under (the entry was
  committed under the firing client's own admission). A payload that
  merely CLAIMS renderer provenance in its fields is not attested. A
  served cascade forwarding a renderer-trusted event object keeps the
  attestation (the in-process propagation's durable twin).
  **Same-space carriage (LT1, RULED 2026-08-03).** A server-emitted
  append whose target stream lives in the SAME space gets its
  durable stream entry as a WRITE WITHIN the wave's own derived
  commit — never a separate commit, never the outbox. The entry
  carries `eventId` and the inherited `firedAt` as WRITE-LEVEL
  fields (protocol.md §7 sanctions the carriage); there is no
  separate event-append admission — the derived commit's lease
  check admits it, and the stamp needs no validation because the
  stamping party and the admitting party are one trust environment
  (protocol.md §1). Idempotency is the stream's `eventWatermark`
  exactly as for client events: an entry processed in its own wave
  commits together with its consequences and the watermark advance;
  an entry a budget-exhausted wave could not process commits as
  durable input and reprocesses under the seq > `eventWatermark`
  rule (§4, §5). NOTHING here blocks the wave: the same-space entry
  is a write into the space's OWN store, and a cross-space emission
  is handed to the OUTBOX post-commit (serving-loop.md §3) — the
  loop never awaits another space, connected or not. When the target
  stream lives in ANOTHER space, the append travels via the outbox as an
  authored commit (protocol.md §2b)
  — and the acting identity travels WITH it as validated commit
  metadata, so inheritance crosses spaces too (protocol.md §2's
  delegated-append stamping).
  **A SESSIONLESS actor has no session instance**: if a
  no-acting-session handler
  run attempts a SESSION-SCOPED write, there is no instance to write
  — that is a runtime ERROR naming this bullet, not a fallback to
  the space instance and not a silently minted session. It is the
  same rule, for the same reason, as the sessionless `navigateTo`
  error (builtins.md §4); scopes.md §5 states the scope-side half.
  User-scoped writes under a sessionless event are equally an error
  unless the event carries an acting user.
- Ordering: per stream, events process in commit-seq order. Across
  streams in one space, wave order (arrival). No global ordering claim
  beyond the space's commit sequence — same as today.
- **Batching is at the COMMIT level only (D-v2-2, ruled 2026-08-02)**:
  the wave commits once, at scheduler idle, with `consequenceOf`
  listing every event processed. Handler-visible semantics are
  UNCHANGED from today's client: handlers run eagerly, but only after
  preflight makes any dirty state inputs current (D-v2-2) — the
  scheduler recomputes a dirty computed input on demand before the
  handler that reads it runs
  (`event-preflight-dependencies.ts:246-248` — preflight recomputes an
  input that is invalid OR has never run, so the lazy-computed case is
  literally in the code; CT-1795's staleness park is an extra gate on
  top) — the common case being not rapid-fire but a lazy computed
  nothing has pulled yet, which the handler must and does see fresh.
  An earlier proposal to drain all handlers ahead of derivations
  (handlers reading last-wave state) was REJECTED by the owner: events
  drain as part of regular execution —
  the loop is simply not idle until all events are processed. Rapid-
  fire efficiency falls out of pull-based laziness (superseded
  intermediates are never demanded, so never computed), with the single
  derived commit as the only batching.
- Server enqueue goes through the scheduler facade (`facade.queueEvent`
  — the wake-shaping entry point), never raw `queueSchedulerEvent`, so
  server-enqueued events get the same shaping as client ones.
- The inherited backlog collapse (`events.ts:266-321`) would
  last-wins-coalesce DURABLE intents; under the flag, collapse is
  DISABLED for durable-id stream events — backpressure is shaped at the
  binding layer instead (README §3.8). (Ledger L8: the owner may yet
  prefer collapse that lists every collapsed id in `consequenceOf`.)

## 3. Payload capture rule

Handler inputs are **explicit**: the event payload plus cells the handler
reads. Any client-only ephemeral value the handler's semantics need
(viewport, selection, local time-of-fire) MUST be captured into the
payload at fire time by the binding layer. The server-side run reads
payload + cells only. A handler reaching for ambient client state is a
pattern bug; the ts-transformers lint for this is a Phase 3 follow-up,
not a blocker. Handlers whose consequences provision spaces
(`.inSpace`) MUST additionally be deterministic given payload + cells —
no clock, no randomness — because replay convergence depends on
re-deriving the same ids (protocol.md §2b); that lint trails with the
ambient-state one.

## 4. Idempotency (exactly-once consequences)

- The derived commit that carries a handler's consequences records
  `consequenceOf: [eventId...]` in its commit metadata.
- Per stream, the server tracks `eventWatermark` = seq of the last event
  whose consequences committed — a field ON the stream doc, written in
  the same derived commit (never its own commit).
- Reprocessing rule (recovery, serving-loop.md §6): an event replays iff
  its stream seq > `eventWatermark`. At-or-below: skip, count
  `skippedIdempotent`.
- The consequence commit and the watermark advance are atomic (same
  transaction), so there is no window where an event is both consumed and
  replayable. Under a mid-wave conflict they rebase TOGETHER into the
  retried commit, never separately (serving-loop.md §3d).
- **The dedupe horizon**: admission enforces `eventId` uniqueness only
  among stream entries with seq > `eventWatermark` (protocol.md §2);
  duplicates of an event at or below it are rejected by the processing
  watermark instead — the replay rule above skips them, counted
  `skippedIdempotent`. Stream entries at or below `eventWatermark` MAY
  therefore compact (the store-growth lesson: a consumed intent needs
  no eternal stream copy to keep dedupe sound).
- Cascade sends minted inside a handler attempt get fresh ids per
  attempt (`event-identity.ts:5-9`); harmless under exactly-once,
  because only the committing attempt's cascades escape the wave.
- Today's receipt-cell exactly-once (`commitPreconditions`, on by
  default) is SUBSUMED by `eventWatermark` under the flag; the two
  mechanisms MUST NOT be active for the same event
  (runtime-mapping.md N26).
- **The drain's own re-scan (stage C tuning, 2026-08-18):** the drain
  queues a pending entry into the serving scheduler AT MOST ONCE until
  the store has spoken for it — a re-drain skips an entry whose earlier
  drain copy is still queued, held, or running, OR whose consequence
  mark is sealed into a wave the store has not yet committed
  (`events.drainInFlightSkips`); the copy is released by the wave
  outcome (committed or requeued — every abort arm reports its
  event-handler contributions as requeued), by a deferral (no mark; the
  rescan retries), by its final callback when nothing of it reached a
  wave (an aborted run, a name-resolution drop), or by a notice that
  failed to stage — a still-pending entry then re-drains exactly as
  before. Releasing at the copy's SEAL would not do: the mark rides an
  uncommitted wave while the entry is still pending, and a re-drain in
  that window would queue the second copy. This is the mark path's
  at-most-one-copy discipline, made robust to the honest flush deadline
  (serving-loop.md §3): a cycle that ends before its drained event ran
  re-arms the scan, and the next cycle's drain used to queue a second
  copy — a per-cut-cycle multiplier on a NON-IDEMPOTENT handler. Stated
  narrowly: it dedupes the drain against ITSELF only — the drain half
  of the invariant below.
- **One entry, one COMPLETED delivery (RULED 2026-08-18 — owner:
  "agreed with your recommendations", on #5969's double-dispatch
  dossier and the coordinator's concurrence; the cross-producer
  invariant the drain sentence above left owed):** **"One durable
  stream entry is delivered to its handler exactly once as a COMPLETED
  run, regardless of dispatch path or reference count. An entry whose
  in-process (LT1 same-wave) run does not complete within its
  appending wave is dispatched by the drain alone; the serving loop
  purges unrun in-process leftovers at the flush deadline and skips at
  the drain any id already queued or run with a durable entry. A
  derivation-kind emitter's superseded LT1 leftover re-arms nothing and
  its orphan delivery is REFUSED (never delivered without a durable
  entry)."** The two producers the sentence unifies are the
  durable-entry + drain path (the store's unconsequenced entries,
  re-scanned per cycle) and the LT1 same-space in-process copy (§2:
  the emitting handler's tx writes the durable entry AND queues the
  event in-process for its own wave, `streamEntry`-less — "the batch
  owns the mark"). Under OFF there is one in-process queue and one
  handler registration per stream link, so exactly-once holds BY
  CONSTRUCTION; the served path's second producer with no dedupe
  between them was a serving-loop PARITY GAP, not a pattern bug
  (#5969's Flag 1: one eventId consequenced by 2–5 derived commits per
  click on the lunch gate; the two-browsers lockdown toggle is the
  same class through the re-drain variant alone). COMPLETED is the
  operative word: a run whose consequence commit lost a per-doc basis
  CAS is REQUEUED — rolled back to unconsequenced and re-delivered by
  the drain in a later wave (serving-loop.md §3d) — which is one
  completed delivery, not two, so the invariant binds completions,
  never dispatch attempts. Enforcement lives in the serving loop at
  two seams: (α) a PURGE, synchronous at the flush-deadline decision
  (before the scheduler's next turn), of every LT1 in-process leftover
  that has not run — discriminator `served !== undefined &&
  served.streamEntry === undefined`; a plain in-process event on the
  serving runtime carries neither and is never purged — whose durable
  entry is the truth the next drain re-runs WITH a `streamEntry`, so
  the mark lands; and (β) the per-eventId drain SKIP of an entry
  already queued (shaper-HELD events included) or already run in the
  still-open wave, taken ONLY on the strength of a copy that carries a
  mark path (a `streamEntry`-bearing dispatch), never on a
  `streamEntry`-less leftover, which cannot mark. The drain-against-
  itself guard above is (β) for the drain's own copies; (α) and the
  in-wave half of (β) are OWED to the design build stage
  (verification-coverage.md OW35). The third clause decides the
  sub-case the dossier left open: a DERIVATION-kind emitter's LT1
  append riding a doc whose derived write is per-doc supersede-DROPPED
  (serving-loop.md §3d — the drop RE-ARMS NOTHING, RULED 2026-08-05)
  has no durable entry and nothing re-emits it; delivering the
  leftover anyway would be an ORPHAN consequence — one delivery, zero
  entries, the same invariant broken from the other side — so it is
  REFUSED. The cross-space twin already has this shape: a cross-space
  append is a durable outbox row, re-sent on activation and deduped at
  the target's `eventId` horizon (serving-loop.md §5) — the durable row
  is the truth and every delivery path dedupes against it, exactly as
  here. Scope, so it is not misread: the client's speculative echo
  COMMITS NOWHERE (it renders only — speculation.md §1), and the
  AUTHORED event commit and the DERIVED result commit are TWO commits;
  the invariant binds the RESULT side — how many times one durable
  entry's consequences are committed — while the authored append's
  exactly-once is the `eventId` dedupe horizon above. NOT ruled, and
  refused: "make handlers idempotent" — it contradicts OFF parity and
  would make every non-idempotent handler (append / increment / toggle)
  wrong under serving, which this section's exactly-once exists to
  prevent. `events.processed > events.appended` is NOT the signature
  (re-drains inflate `processed`; in-wave LT1 cascades count in
  neither); per-event run counts are.
- **LANDED (stage C build W3, 2026-08-19 — the (α) build the sentence
  above owed; verification-coverage.md OW35 CLOSED):** the serving loop
  enforces the sentence at THREE seats, the two it names plus the
  in-flight residue the purge cannot reach, which its own wording ("does
  not complete within its appending wave") requires — recorded as a
  DATED clarification of the enforcement paragraph, not a change to the
  ruled sentence; RATIFIED as amended — RULED 2026-08-19 (the marker
  and the owner's quote close the AMENDED note below). **(α1) the
  purge:** synchronously at the flush-deadline
  decision, every scheduler-QUEUED LT1 in-process copy (`served !==
  undefined && served.streamEntry === undefined`, not yet dispatched) is
  removed (`events.lt1LeftoversPurged`); no notice lands on the entry
  (the copy carries no failure hook — it could never mark), the entry
  stays pending, the next drain delivers it once WITH a `streamEntry`.
  **(α1b) the late-seal refusal:** an LT1 copy already RUNNING at the
  deadline seals after its appending wave — the wave its EMITTER sealed
  into, carried on the copy as the emitter's transaction and resolved at
  the dispatch stamp — closed; the seal destination refuses it BEFORE it
  enters any wave (`events.lt1LateSealsRefused`), so nothing of it
  reaches the serving replica and the drain's copy, running next, reads
  clean state. This is the lunch gate's vote-toggle double (W0's l1:
  commit 64 held the in-process copy's unmarked add AND the drain copy's
  marked toggle-off, `consequenceOf` deduping to one id) — a case the
  purge alone would not have fixed. **(α2) the drain skip** for an id
  already queued, shaper-held, or run WITH a durable entry in the open
  wave is the trio's in-flight guard (`events.drainInFlightSkips`): the
  guard entry is set BEFORE the scheduler's `queueEvent`, which holds
  shaped events synchronously, so a held copy is "queued" to the guard;
  the drain is the only producer of `streamEntry`-bearing copies, so no
  second in-wave producer exists today. **(α3) the orphan refusal:** the
  wave's requeue closure refuses an LT1 copy's contribution — disposition
  `dropped`, never reported as requeued, nothing re-armed
  (`events.orphanDeliveriesRefused`) — when NO surviving contribution of
  that wave appends its entry: the emitter's sidecar write was superseded
  (a derivation's per-doc drop), the emitter dropped whole or requeued, or
  the emitter's seal never entered the wave; readers of the refused run,
  its own cascade grandchildren, and its same-eventId siblings fold
  through the same closure. The run-count pins
  (`executor-events-down.test.ts`, "(α1)+(α1b)+(α4)", "(α1b)+(α4)",
  "(α3)") count completed runs from the store — the handler's
  non-idempotent effect applied exactly once per durable entry
  and exactly one derived commit naming each event — with the killing
  mutations recorded in the W3 build report.
- **AMENDED by W3's independent review (2026-08-19; B1 / M1 — the
  same-eventId SIBLING shape); RATIFIED as it stands — RULED
  2026-08-19 (the close of this note):** an event can contribute SEVERAL
  transactions to one wave — the handler run plus a separate
  event-handler-stamped tx carrying the same `eventId`, in production
  the served `navigateTo`'s intent tx (builtins.md §4), committed inline
  mid-run. As built, (α1b) and (α3) assumed the LT1 copy's handler tx
  was the event's ONLY same-eventId contribution, and in that corner the
  code was WEAKER than the ruled sentence's letter: when the sibling
  sealed into the appending wave and the handler's own tx did not (an
  async handler still running at the deadline, refused at its late
  seal), the batch marked the entry `consequenced` on the SIBLING's
  survival, so the drain never re-delivered it — zero completed runs, a
  lost delivery (a regression against the W1 base, where the late copy
  committed unmarked one wave later and delivered). FIXED and pinned:
  (i) a seq-less entry is marked consequenced ONLY by the LT1 copy's
  OWN surviving run (`WaveRunContext.lt1 === true`) — a sibling-only
  survival leaves the entry unmarked and the drain delivers it once,
  with a `streamEntry` (the re-run's re-issued intent dedupes on its
  deterministic nonce at apply); (ii) the (α3) orphan refusal folds the
  copy's same-eventId siblings — neither half of an orphan lands, and
  `events.orphanDeliveriesRefused` counts once per EVENT. Pins:
  `executor-events-down.test.ts` "(α1b)+(α4) + a same-eventId SIBLING
  tx" (red on the build tip: the entry marked, `processed` 1, the
  effect 0×) and "(α3) + a same-eventId SIBLING tx" (red on the build
  tip: the intent half landed). RESIDUAL, recorded and not ruled: in
  the late-seal shape the sibling's write lands in the appending wave
  while the handler's consequences land with the drain's run one wave
  later — the event's contributions SPLIT across two commits (the
  appending wave "could not process" the entry, §2 — it commits as
  durable input and reprocesses); the split is idempotent by the
  intent's nonce dedupe, and a store-side per-event commit count reads
  2 for it exactly as it reads 1 for a same-wave double (W0's l1) —
  the handler's effect is the run-count witness, never that count. A
  tightening that also withdraws the timing-orphaned sibling from the
  appending wave (so intent and consequences re-land together) is
  named, not built — owner-visible.

  **RULED 2026-08-19 — the late-seal-refusal clarification RATIFIED
  as it now stands**, in this amended form (the lt1-only survivor
  marking, the orphan refusal's same-eventId sibling fold, the
  late-seal SPLIT residual stated, the tightening named and not
  built), answering the coordinator's ratification question (the
  plan's owner item (7); recommendation: ratify as written). The
  owner, in chat:

  > ack

  — owner (Berni), 2026-08-19. The DATED/AMENDED trail above stays
  as the amendment history — the marker records ratification, it
  does not erase the trail — and the split-residual tightening
  (withdrawing the timing-orphaned sibling so intent and consequences
  re-land together) STAYS a named, not-built follow-on.

FORBIDDEN: a processed-events table; per-event acks from clients;
handler-run provenance records; a handler delivery with no durable
stream entry behind it; requiring pattern handlers to be idempotent as
the double-dispatch remedy (parity with the OFF arm is the serving
loop's duty).

## 5. Failure semantics

- Handler throws server-side: commit NO consequences; write the existing
  handler-error surface (same shape clients show today) as the derived
  commit for that event, advance `eventWatermark` past it (an error IS
  the consequence — else a poison event wedges the stream), push.
- Handler commit refused PRE-STORAGE by CFC enforcement, server-side
  (the deterministic "CFC enforcement rejected commit" class —
  `rejectCommitBeforeStorage`, whose refusal re-running recomputes
  identically): the same rule as the throw above — the refusal IS the
  consequence. The entry carries the refusal message as its `error`,
  `eventWatermark` advances past it, and the unconditional
  dropped-write report still fires; the seal is the served give-up
  arm's discriminated `served.onFailure` (scheduler/events.ts). Every
  OTHER commit refusal of a served event (a terminal commit-rule
  refusal — `RowLabelCommitError` — transport, authorization, a
  handler abort) seals nothing: the entry stays pending and the wave
  cadence re-drains it — served copies opt out of scheduler-side
  backoff because the wave IS their retry cadence (serving-loop.md
  §3d).
- Client offline at fire time (RULED 2026-08-02): events accumulate
  client-side as unacked authored commits and discharge on reconnect
  in fired order — PER STREAM: a stream's sidecar carries only that
  stream's entries and nothing on the wire orders one stream against
  another, so the guarantee is each stream's own fired order (unpaced,
  the queue sends the fired-order head, which serializes the space in
  fired order as a consequence; under README §3.8's OW27 pacing streams
  are independent — a paced stream holds only its own later sends,
  never another stream's; ruled 2026-08-16 with the P7 review's
  finding 5). The queue is PROCESS-LIFETIME (LT9, RE-RULED
  2026-08-15 by the owner, superseding the 2026-08-03 "durable"
  ruling): queued-but-undischarged intents surviving a client RELOAD
  is a NON-GOAL this round — in the owner's words, *"the status quo
  doesn't survive client + server reload either"* — so reload loss is
  accepted; what the queue DOES survive is an in-process replica
  replacement (the manager-shared in-memory store hands a dead
  predecessor's intents to its successor — machinery loss, not reload
  loss). Sessions are per tab: one writer per session by construction,
  no leader election, no shared persisted session, no orphan adoption;
  the recorded future shape, if reload survival is ever wanted, is
  per-tab persistence + orphan adoption. A discharged
  event whose PRECONDITIONS are gone is
  DROPPED — no consequences commit — and the client MUST be signaled
  so the UI can react.

  **The DROP predicate, named once (T3).** An event drops iff its
  handler CANNOT RUN AT ALL against current state: the target stream
  or a doc the handler must write was deleted meanwhile, or the CAS
  base the append was minted against is unrecoverable. The test is
  "no runnable handler", never "the run raced". Do NOT confuse this
  with serving-loop.md §3d's REQUEUE, which is the opposite
  situation: there the event RAN and only its consequence commit lost
  a per-doc basis CAS, so the event is still valid and is rolled back
  to unconsequenced and retried. Drop = the event is unrunnable;
  requeue = the event is fine and the commit was raced. §3d cites
  this predicate rather than restating it.

  **Where the notice lives, and when it retires (T7).** The
  dropped-event notice — `{ status: "dropped", reason }` naming the
  eventId — is a FIELD ON THE STREAM DOC'S OWN ENTRY for that event,
  written as that event's consequence and advancing `eventWatermark`
  past it (the same non-wedging rule as the error case above). No new
  doc, no commit-metadata replay to depend on: the client re-reads
  the stream on reconnect, so the notice survives reconnect by
  construction. It RETIRES with its entry when the stream compacts
  below `eventWatermark` (§4's compaction allowance) — the notice
  never outlives the entry it annotates, and nothing accumulates.

  The UI treatment itself is a follow-up: components that send
  authored commits already handle conflict feedback gracefully
  today, and events reuse that posture. The speculative echo stands
  while offline; reconciliation is ordinary (speculation.md §4), and
  the notice retires the dropped event's overlay entries like any
  consequence.

  **Drops and errors ride `consequenceOf` (RULED 2026-08-18 — the
  stage-C design pass, item 7; landed with W2).** A dropped event's
  notice and an erroring handler's error surface ARE that event's
  consequence: the derived commit that writes them names the event in
  its `consequenceOf` and advances `eventWatermark` past it, exactly
  as a successful handling does — so "every eventId drained this wave
  is in `consequenceOf`" (§4) holds for drops and errors too, and the
  client's step-2 retirement (speculation.md §4) fires for them through
  the same carrier (the entry's own `status` / `error` mark).
- Duplicate submission (client retry after ambiguous network outcome):
  the append is CAS-guarded by `eventId` uniqueness above the dedupe
  horizon (§4) — a duplicate of a not-yet-consequenced event is
  rejected at admission; a duplicate of an already-consequenced one
  falls to the processing watermark and is skipped
  (`skippedIdempotent`).

## 6. UI-binding writes (for contrast, and to stop scope creep)

`$value` bindings and widget edits are authored doc writes under existing
ACL + CAS (README §1). They are NOT events, do not carry eventIds, do not
touch `eventWatermark`, and need no changes in v2. To the serving loop
they are pure dirtiness inputs. Do not "unify" them with events; the
unification is D-v2-1's non-goal — they may migrate someday as a product
choice.

## 7. What the client loses, explicitly

Under the flag, the client handler path commits **only the event**. The
handler's writes apply to the speculation overlay, never to a storage
transaction. The client's handler-write commit path was DELETED with
Phase 3 (D-v2-1): the overlay destination diverts event-handler runs
exactly like derivation runs, and its absence is what makes admission
target+principal-only. If some test needs a client handler write to
commit, the test is asserting v1 behavior — fix the test.
