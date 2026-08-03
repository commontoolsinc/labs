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
- Handler registration happens when the SpaceServer's runtime instantiates
  the pattern; `addSchedulerEventHandler` is already the hook.

## 1. The event, as data

An event is an **authored append to a stream document**:

```jsonc
// committed by the client session, ordinary authored commit
{
  "stream": <entity link to the stream doc>,
  "eventId": <durable id from event-identity>,     // client-minted
  "payload": <JSON>,                                // see §3
  "firedAt": { "session": <sessionId>, "clientSeq": n }
}
```

Admission (protocol.md §2): append authority on the stream doc + CAS.
Nothing about the event says or implies "I ran something."

## 2. Lifecycle, end to end

```
client                          server (SpaceServer)
------                          --------------------
handler fires
├─ capture payload (§3)
├─ commit event append ────────► subscription delivers commit
├─ speculative echo:            ├─ classify: event-append
│  run handler + graph          ├─ enqueue via queueSchedulerEvent
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

- Server-originated events (`stream.send()` from a served computation, or
  piece-to-piece) enter at "enqueue" with `firedAt.session = server` and
  are otherwise identical. One path, two producers.
- Ordering: per stream, events process in commit-seq order. Across
  streams in one space, wave order (arrival). No global ordering claim
  beyond the space's commit sequence — same as today.
- **Batching is at the COMMIT level only (D-v2-2, ruled 2026-08-02)**:
  the wave commits once, at scheduler idle, with `consequenceOf`
  listing every event processed. Handler-visible semantics are
  UNCHANGED from today's client: the scheduler recomputes a dirty
  computed input on demand before the handler that reads it runs
  (`event-preflight-dependencies.ts`) — the common case being not
  rapid-fire but a lazy computed nothing has pulled yet, which the
  handler must and does see fresh. An earlier proposal to drain all
  handlers ahead of derivations (handlers reading last-wave state) was
  REJECTED by the owner: events drain as part of regular execution —
  the loop is simply not idle until all events are processed. Rapid-
  fire efficiency falls out of pull-based laziness (superseded
  intermediates are never demanded, so never computed), with the single
  derived commit as the only batching.

## 3. Payload capture rule

Handler inputs are **explicit**: the event payload plus cells the handler
reads. Any client-only ephemeral value the handler's semantics need
(viewport, selection, local time-of-fire) MUST be captured into the
payload at fire time by the binding layer. The server-side run reads
payload + cells only. A handler reaching for ambient client state is a
pattern bug; the ts-transformers lint for this is a Phase 3 follow-up,
not a blocker.

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
  replayable.

FORBIDDEN: a processed-events table; per-event acks from clients;
handler-run provenance records.

## 5. Failure semantics

- Handler throws server-side: commit NO consequences; write the existing
  handler-error surface (same shape clients show today) as the derived
  commit for that event, advance `eventWatermark` past it (an error IS
  the consequence — else a poison event wedges the stream), push.
- Client offline at fire time: events queue client-side as unacked
  authored commits and submit on reconnect in fired order (Q1's default;
  owner may refine). The speculative echo stands meanwhile; reconciliation
  is ordinary (speculation.md §4).
- Duplicate submission (client retry after ambiguous network outcome):
  the append is CAS-guarded by `eventId` uniqueness on the stream — a
  duplicate append is rejected at admission, not deduped downstream.

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
transaction. Deleting the client's handler-write commit path is a Phase 3
task, and its absence is what makes admission target+principal-only. If
some test needs a client handler write to commit, the test is asserting
v1 behavior — fix the test.
