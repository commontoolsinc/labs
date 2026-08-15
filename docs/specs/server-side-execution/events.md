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

FORBIDDEN: a processed-events table; per-event acks from clients;
handler-run provenance records.

## 5. Failure semantics

- Handler throws server-side: commit NO consequences; write the existing
  handler-error surface (same shape clients show today) as the derived
  commit for that event, advance `eventWatermark` past it (an error IS
  the consequence — else a poison event wedges the stream), push.
- Client offline at fire time (RULED 2026-08-02): events accumulate
  client-side as unacked authored commits and discharge on reconnect
  in fired order. The queue is PROCESS-LIFETIME (LT9, RE-RULED
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
