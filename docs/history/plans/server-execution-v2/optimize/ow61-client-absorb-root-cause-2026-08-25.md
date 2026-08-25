---
status: historical
created: 2026-08-25
archived: 2026-08-25
reason: "Investigation record: OW61's client-side cid delivery loss was localized, reproduced, fixed, and checked in an ensure-ON CI lane."
---

# OW61 client absorb root cause (2026-08-25)

This record closes the client-side half of OW61. The server-side investigation
established that the server shipped each referenced `cid:` schema document in
the same frame or an earlier frame of the same session. This investigation
located the point where an earlier client frame disappeared, built a
deterministic runner-level reproduction, and checked the fix in the ensure-ON
pattern lane where the defect reproduced consistently.

## Exact mechanism

An unsolicited `session/effect` can arrive after the first watch request is on
the wire but before its response returns. When this was the first frame for the
session, `SpaceSession.handleEffect()` created the session's `WatchView` with
`WatchView.fromSync(effect)`. That applied the frame to the view's aggregate
entity snapshot with emission disabled. It did not put the raw `SessionSync`
on `WatchView`'s sync queue.

The first `watch.add` response then found that the view already existed,
applied its response sync to the same aggregate view with emission disabled,
and returned only the response sync to `SpaceReplica.refreshWatchSet()`. The
replica applied that response and subscribed to `WatchView.subscribeSync()`
afterward. The earlier effect was neither returned nor queued, so it never
reached `SpaceReplica.applySessionSync()` or the replica document store.

This was invisible to graph-view consumers because the aggregate `WatchView`
did retain the effect. It was fatal to the runner replica, which consumes raw
sync frames to maintain its own store. Once the server had put the frame on the
wire, its per-session cache correctly treated the schema documents as
delivered and elided them from later frames. A later document referring to one
of those schemas therefore reached the replica without a stored dependency and
was quarantined.

## Per-session continuous-integration measurement

The earlier socket probe kept its observations on `globalThis`, so one browser
realm's replicas could be mistaken for one another. PR #6285 replaced that
with a session-local probe: the raw socket payload was attributed to the exact
`SpaceSession` that received it, and replica-apply logs carried the same
session id. The pattern ON lane ran shard 1 with the space-root ensure enabled.

| Measurement | Before fix | After fix |
| --- | ---: | ---: |
| Run / job | 32884386274 / 97922038750 | 32885176299 / 97924256826 |
| `cid:`-bearing socket effects | 19 | 23 |
| Effects arriving before the first watch response | 7 | 6 |
| Raw/decoded `cid:` id mismatches | 0 | 0 |
| Pre-watch effects carrying `ayhc5ov` | 7 | 6 |
| Pre-watch effects without a same-session, same-sequence replica apply | 7 | 0 |
| Pre-watch effects applied through the ordered prefix | 0 | 6 |
| `schema-doc-quarantine` | 118 | 0 |
| Shard result | failure | success |

The run-to-run frame counts are workload timing, not a comparison invariant.
The discriminator is structural: before the fix every pre-watch frame vanished
between its receiving session and that replica's apply path; after the fix
every such frame appeared at the same session and sequence as an ordered-prefix
apply. The raw payload carried all 19 decoded `cid:` ids in each observed
`ayhc5ov` frame, so the established cascade was not another replica's socket
traffic and was not caused by an id disappearing in boundary decoding or
schema-table expansion.

## Deterministic pin and mutation check

`packages/runner/test/memory-v2-pre-watch-effect.test.ts` uses a scripted
transport to deliver a valid content-addressed schema document as a
`session/effect` before responding to the first `session.watch.add`. The watch
response carries a document whose link schema refers to that hash.

Before the fix, the test emitted the same broken-ref quarantine as the CI
lane, and neither the schema document nor its referrer was available in the
replica. After the fix, both are stored. An explicit ordering assertion proves
that the transport delivered the effect before the response, preventing a
vacuous green.

The mutation check removed only the new ordered-prefix apply in
`SpaceReplica.refreshWatchSet()`. The test returned to the broken-ref
quarantine and failed at the missing schema-document assertion. Restoring that
loop made it green again.

The pin exercises the memory client's encode/decode, reserved-schema
expansion, message dispatch, `SpaceSession`, `WatchView`, the runner's
`SpaceReplica` validator, and the replica document store. Its transport is a
scripted in-process server; it does not exercise a real socket, the memory
server's query/closure builders, or a browser. The existing
`executor-space-root-ensure.test.ts` case that deliberately filters every
`cid:` upsert remains the positive control for a loss after session delivery:
it still emits its four expected quarantines with the fix present.

## Fix

`SpaceSession` retains syncs that arrive before the first watch response in
wire order and returns them as `WatchMutationResult.precedingSyncs`. The runner
applies that ordered prefix to its replica before it applies the response sync,
then begins the live sync subscription. Multiple effects in the window stay in
arrival order.

No server frame construction or session-cache rule changes. In particular,
the fix does not resend content-addressed schema documents: the server remains
free to elide a `cid:` document after it has sent that session the document
once.

## Relationship to PR #6258

PR #6258 was written while OW61 was still framed as server under-delivery. Its
park, pull, and full-resync machinery recovers after the client has already
quarantined a document. It does not prevent this pre-watch frame loss. The
ordered handoff fixes the loss before quarantine, and the ensure-ON after run
needed none of that recovery: its quarantine count was zero. The broader #6258
recovery policy therefore needs an independent justification; it is not the
root-cause fix for OW61.
