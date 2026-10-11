# The serving loop off the request thread

The serving loop runs inside the toolshed process, on the same thread as the
memory server's frame handling and the HTTP routes. A wave's settle step is a
run of synchronous scheduler actions, so while it runs every client round trip
to that toolshed waits: a schema watch add measured at 53 ms with the loop
absent costs 263 ms with it present, and a client that waits on nothing the
server computes is still paced by the server through the latency of each
message
([the 2026-10-11 record](../history/development/performance/2026-10-11-server-execution-send-wait-and-session-fan-out.md)).
[`serving-loop.md`](../specs/server-side-execution/serving-loop.md) §1 draws
the `ExecutorHost` inside the toolshed process and leaves its thread unsaid;
[the README](../specs/server-side-execution/README.md) §3.8 asks for per-space
budgets, and the one that exists is the 100 ms flush deadline, a timer that
cannot cut a synchronous action.

This plan moves the host, and with it every serving runtime, into a Web Worker
of the toolshed process. The memory server, the routes, and the store's one
writer stay on the main thread. The worker reads the store through its own
SQLite connections and reaches the server for everything else over a
`MessagePort`.

## What crosses the boundary, and what does not

The host touches the memory server and the store at a bounded set of points.
Each is placed below; the placement is the design.

**Reads of the store stay reads, on the worker's own connection.** The loop
reads `serverSeq`, the pending stream-event documents, commits since a
sequence, document heads, retirable effect instances, and, under the store
read-through posture, documents, all through `Engine.*` on an engine object.
Every one of those is a SQLite query, and the engine's decoded-document cache
is keyed by revision identity, so a second connection to the same WAL-mode
file reads every committed revision and can serve nothing stale. The worker
opens one engine per space it serves, read-through included, at the URL
`resolveSpaceStoreUrl` gives for the server's store. The lease rows the loop
writes (`execution-lease.ts`, through the same engine object) are the one
write that stays on the worker's connection: small, serialized by SQLite's
lock with the engine's 5 s busy timeout, and read by the main thread's
admission from SQLite each time.

**Wave commits cross to the main thread.** `EngineWaveCommitSink` applies a
wave's one derived commit inside the engine transaction that also writes its
basis rows, re-verifies its documents, attaches the wave's sqlite cell
databases through the memory server, and reports the commit to the server
(`noteExecutorCommit`) for dirtiness and fan-out. The store keeps one writer
with one view of its own commits: the worker sends the `WaveSpaceCommit` (data
throughout: operations, preconditions, confirmed reads, annotations, basis
rows, consequence ids, delegated carriage, outbox appends) and the main thread
applies it with the sink it already has, returning the result. The
served-ACL-change commit crosses the same way.

**The serving runtime's storage plane crosses as frames.** The serving
runtime's `StorageManager` connects to the memory server through
`LoopbackStorageManager`, a `Transport` that hands frames to
`Server.connect()` in-process. The worker uses the same manager over a
`Transport` that posts each frame on the port; the main thread owns one
`Server.connect()` per worker-side transport and posts the server's frames
back. The protocol, the signed `session.open`, and the service principal are
unchanged, which is what keeps the read-row admission's holder matching intact.

**The server's observer crosses as events, its queries as requests.** The
main thread installs the `ServerExecutionObserver` and forwards `commitAdmitted`,
`sessionOpened` and `demandChanged` to the worker. The worker asks the main
thread for `hasLiveSessionsForSpace`, `hasLiveSessionFor`, `sessionReadCeiling`,
`demandForSpace`, `idle`, `flushSessions`, and `noteLeaseReacquired`. The
demand mirror compares rows, so a `SessionDemand` that arrives as a fresh
object costs a row comparison where an identical object cost nothing; a
generation number per session can restore that later if the comparison shows
in the demand pass's time.

**Lifecycle verbs run in the worker, from a descriptor.** A verb reaches the
host today as closures over a `PiecesController`. The route sends the verb's
name and its request instead, and the worker builds the closures from the same
functions in `@commonfabric/piece`'s served lifecycle. The receipt comes back
as data.

**Stats cross on every cycle.** The worker posts the host's `ServingLoopStats`
at the end of each wave cycle and on request; the main thread registers a
stats provider that returns the latest copy, so `/api/health/stats` keeps its
shape.

**The runtime's other needs are already remote.** Pattern sources come from
`/api/patterns` over HTTP, which the main thread answers; the compiled-module
byte cache is per worker; external effects (`fetch`, LLM calls, the outbox)
run where the runtime runs. A Worker started without a permission descriptor
inherits the process's permissions, FFI for SQLite included.

## Ordering and failure

The port is one ordered channel each way. A frame the server sent before
answering an `idle()` request arrives at the worker's transport before the
answer, which is what the settle loop's frame-delivery coupling relies on; the
same holds for a `commitAdmitted` event that follows a wave commit's result.

A worker that dies takes every serving runtime with it. The main thread's
bridge treats its exit as a park of every space with the failure-park backoff
the host already applies, and starts a fresh worker; the lease rows lapse on
their TTL and the successor acquires them, which is the recovery
`serving-loop.md` §6 already specifies for a lost tenure. A main thread that
closes closes the port, and the worker's host closes as it does today.

## What does not change

The loop, the wave, the demand pass, the outbox, the lease, the sink, and the
protocol are untouched. What changes is who holds the engine object the loop
reads, which thread the sink runs on, and how the host reaches the server. The
in-process arrangement stays available: it is what every existing test runs,
and the flag below selects between the two.

## Stages

1. [x] **The serving plane as an interface.** The host and the space server
   take a `HostMemoryServer` in place of the memory server: the methods listed
   above, the engine opener, and the wave commit sink factory. The in-process
   server satisfies it as it is and behaves as today. No behavior changes;
   the existing executor tests pass unchanged.
2. [ ] **The port protocol.** A worker-side `ServingPlane` over a `MessagePort`
   and the main-thread bridge that serves it: request and reply framing with
   ids, observer events, loopback frame multiplexing by transport id, wave
   commits applied through a main-thread sink, stats relay. A unit test runs
   a host in a Worker against a file-backed serving memory server and settles
   an authored commit through it.
3. [ ] **Toolshed wiring under `SERVER_EXECUTION_WORKER`.** The bootstrap
   starts the worker and the bridge when the variable is `true`, in-process
   otherwise; lifecycle verbs go through descriptors on both paths; the
   health route reads the relayed stats. The flag is registered in
   [`EXPERIMENTAL_OPTIONS.md`](../development/EXPERIMENTAL_OPTIONS.md).
4. [ ] **The ON-arm suites under the worker.** The pattern integration tests
   that run against a toolshed pass with the worker on; the serving memory
   server used by in-process tests gains a worker mode over a temporary file
   store, and the executor suites that can run under it do.
5. [ ] **Measure.** The vote probe and the Topics seed under the worker against
   the in-process loop on the same box: client watch-add latency, the
   per-vote and per-topic client cost, and the serving loop's own wave
   timings, which should not move.
6. [ ] **Spec and default.** `serving-loop.md` §1's component diagram names the
   worker; after a soak the worker becomes the default and the in-process
   path goes, with the flag.
