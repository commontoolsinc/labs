---
status: historical
created: 2026-10-16
archived: 2026-10-16
reason: "Measurement of posting the thirtieth message into a FabriChat room before and after messages became pushed elements (commonfabric/labs#8931), with a worker CPU profile of the send and of the room's cold load at thirty messages, October 2026."
---

# Posting the thirtieth message, before and after pushed messages, October 2026

A FabriChat room's messages became objects pushed onto its list in
commonfabric/labs#8931. This records what that did to a send into a room of
thirty messages, and where the time a send and a cold load still take goes.

## Setup

`packages/patterns/integration/fabrichat-room-scale.bench.ts` at 10 and 30
messages with 12 members, each side against a toolshed binary built from its
own tree (`main` at `d766f49be0`, the branch at `dd2fa83fcc`), server
execution off, one laptop, three measured iterations per row. A cold load is
a signed-in page load until the last message renders and every member's badge
shows; a send is a click on the composer's send until the message's row
renders. The reads are the worker's `scheduler.run.complete` telemetry over
the operation: runs, proxy accesses, link resolutions.

| | `main` | pushed messages |
| --- | --- | --- |
| 10: cold load, avg (min … max) | 32.0 s (29.6 … 35.8) | 15.4 s (14.5 … 16.1) |
| 10: send | 2.0 s (1.7 … 2.2) | 1.4 s (1.2 … 1.5) |
| 10: send reads | 69 runs, 750 accesses, 604 hops | 68 runs, 477 accesses, 616 hops |
| 30: cold load | 28.4 s (26.4 … 31.9) | 27.2 s (25.0 … 29.8) |
| 30: send | 2.5 s (2.5 … 2.5) | 1.2 s (1.1 … 1.2) |
| 30: send reads | 69 runs, 1 254 accesses, 804 hops | 68 runs, 757 accesses, 836 hops |

A send into a thirty-message room halves, and its reads stop growing with the
room: on `main` a send's accesses grew from 750 to 1 254 between ten and
thirty messages, with pushed messages from 477 to 757, most of that the new
row's own render. The cold load at thirty is the same on both sides, and the
halving at ten is one run each side and is not explained by the change; treat
it as noise until repeated.

## Where a send's 1.2 s goes

A worker CPU profile of one send at thirty messages (sampling every 0.5 ms,
`CdpWorkerProfiler`), with the worker's logger rows differenced against the
load that preceded it:

- The worker is sampled for 1.8 s, of which 42% is idle: waiting on the main
  thread and storage. The logger agrees: `storage.v2/watchRefresh/watchAddSync`
  takes 1.75 s over nine calls after the write, `runner.loop/workerLag` 1.5 s
  over four, `runtime:idle` 1.1 s over five.
- The scheduler runs 68 actions in 0.52 s, commits in 0.18 s. No pattern frame
  reaches 1 ms of self time; the CPU is the runtime's: CFC label work
  (`canonicalizeCfcLogicalPath`, `mergeCfcLabelViews`, `mergeLabel`,
  `cfcLabelViewInDocument`, about 110 ms together), the value codec and
  freezing (`update`, `utf8SortedKeysOf`, `addToDeepFrozenCache`,
  `#feedPlainObject`, `freeze`, `cloneHelper`), and `sortEntries`.
- IPC round trips the send adds: 5 `cell:subscribe`, 8 `cell:resolveAsCell`,
  13 `cell:getCfcLabel`.

So the pattern's share of a send is gone; what remains is the runtime's cost
per run and the wait for the write to be watched back, which is where a
further cut would come from.

## Where a cold load's 27 s goes

The same profile over the load, from sign-in until the room rendered, 14.6 s
of worker time at 11% idle:

- `runner/start/resumeListChildSync` runs 3 976 times. The room reaches that
  many links at thirty messages and twelve members: each message's author
  profile, each message's reaction list, the participants, and the profiles
  behind them. `maxAccesses` is 2 830 at every size on both sides, which says
  the members' profiles, not the messages, set the floor.
- IPC deliveries wait: `cell:subscribe` has a median of 1.97 s over 131 calls,
  `cell:resolveAsCell` 223 calls, `cell:getCfcLabel` 280. `workerLag` reaches
  5.2 s.
- The CPU is again the runtime's: the codec and freezing, link resolution
  (`resolveLinkTracingDereferences`), schema joins (`joinSchema`,
  `definitionNamed`), CFC label merging. Pattern frames total under 20 ms.

The seeding both benches do costs about 50 s per message write at every size
on both sides, from `piece-start-commit-failed` conflicts as members open the
room at once, and the send-burst bench on `main` dropped a message in this
run (eleven of twelve expected). Neither is the change's.
