# The served vote's remaining cost: the main thread's fan-out

A vote in the lunch poll, served by the serving loop with five clients
rendering the poll, takes about five seconds to reach every client's view on
the box the records were taken on, and about three with the loop off. The
records that got here say where the rest went and what has been taken out:
the per-viewer fan-out of derivations
([the served-vote record](../history/development/performance/2026-10-11-served-vote-per-viewer-runs.md)),
the serving loop's own waits
([the serving-cycle record](../history/development/performance/2026-10-11-serving-cycle-local-quiescence.md)),
and the worker's port round trips, the publish and the commit, which the
served-vote record's last section measures gone from the cycle with the burst
unmoved. The [work census](../history/development/performance/2026-10-21-served-vote-work-census.md)
then counted what one burst causes and named seven removals, and stage 3
below tracks them: the growing flush deadline and the serving pass that runs
every ready event before one derivation pass have taken out most of the
per-wave and per-event machinery, and view-scoped replication now plans less
and walks less. What is left is the memory server's root evaluations, once
per session per flush pass with a tuple evaluated under every schema a
reader declared; each client re-running what the server ran; and, with
view-scoped replication on, the plan's size and its planning tail on the main
thread. This plan is for whoever picks that up on the branch, with everything
they need that the records do not carry.

## Where things stand

Read, in this order, before changing anything:

1. `AGENTS.md`, `docs/development/DEVELOPMENT.md`,
   `docs/development/code-comment-style.md`, and the `perf-investigation`
   skill at `skills/perf-investigation/SKILL.md`.
2. The three records above, the served-vote one last and in full.
3. The registry entries for `SERVER_EXECUTION_STORE_READ_THROUGH`,
   `SERVER_EXECUTION_WORKER` and `SERVER_EXECUTION_OVERLAP_COMMIT` in
   `docs/development/EXPERIMENTAL_OPTIONS.md`, and
   [the serving loop off the request thread](serving-loop-worker.md), whose
   stage 6, the worker's default flip, is still pending.

What is on by default and what is not:

- The serving loop itself (`EXPERIMENTAL_SERVER_EXECUTION`) is off by default;
  every served-arm measurement here sets it on, and the loop-off arm leaves it
  off.
- The worker (`SERVER_EXECUTION_WORKER`), the store read-through
  (`SERVER_EXECUTION_STORE_READ_THROUGH`) and the overlapped commit
  (`SERVER_EXECUTION_OVERLAP_COMMIT`) are all off by default. The arm the
  records call "worker, read-through" sets the first two; the overlap is a
  worker-arm lever that stays off until the fan-out floor moves, for the
  reason the served-vote record gives: it halves the cycle and does not move
  the burst, and on the main-thread arm it lengthens it.
- The view interests are held on the worker unconditionally
  (`packages/runner/src/executor/view-interests.ts`, keyed on the server's
  `viewsChanged` and `sessionChanged` observer events); nothing switches that.
- The lunch poll's tally rows no longer carry the viewer
  (`packages/patterns/lunch-poll/main.tsx`), and
  `docs/common/patterns/multi-user-patterns.md` carries the rule.

## What is established

The served-vote record's tables are the source; the figures that decide what
to do next are these, all at five voters and five options, 25 votes a burst,
every client rendering the poll, measured until every client's own vote list
holds the round's rows:

| arm | burst |
| --- | --- |
| loop off | 3.0 s |
| worker, read-through, before the port levers | 4.3 s |
| worker, read-through, interests held | 5.2 s, 5.0 s |
| worker, read-through, interests held, overlap on | 5.5 s, 5.2 s |
| main thread, read-through | 6.5 s |

The box varied by about a third between iterations of one run on the day the
last four rows were taken, so the three worker rows are one number. On the
served arms the loop's cycle fell from 294 ms to 143 ms across the two levers
while the burst stayed, and a 300 ms flush deadline that brings the waves per
burst from 38 back to 11 leaves the burst where it is too. The burst is not
paying for the loop's cadence or for the number of commits. It is paying for
what the main thread does per commit per viewing session:

- `memory/refresh/phase/walk` and the `memory/refresh/walk/<phase>` rows: the
  re-walk of a session's tracked documents under its schema, 74 ms a walk on
  client arm with rendered views in the original capture. The later
  [frequency investigation](../history/development/performance/2026-10-19-served-vote-fan-out.md)
  found many small traversals inside these walks. The 100–400 ms
  `slow-traverse` warnings alone do not establish which realm or phase paid
  them. Attribute root evaluations and their frequency before choosing a
  traversal optimization.
- `send/encode`: the frame encode behind each walk, 1.2 s of a burst on the
  loop-off arm's main thread.
- `memory/flush/refresh` against `memory/flush/queue`: the flush passes these
  run in, 102 ms median, filling 44% of the burst on the worker arm's main
  thread, each pass covering every dirty space and every session owed a
  frame.
- On the loop-off arm, five clients deriving the same documents add 648
  rejected commits and 905 rolled-back writes a burst, and the main thread
  walks and encodes for all five.

## The next lever

The memory server's per-session walk and encode, now with no serving-loop
wait in front of it. The code:

- `Server.flushSessions()` in `packages/memory/v2/server.ts` is the pass; the
  per-session refresh and its `walk` phase sit under it, around the
  `"memory", "refresh", "phase", "walk"` row, and the graph re-evaluation it
  calls is `packages/memory/v2/query.ts`, whose `refreshTiming` records the
  `memory/refresh/walk/<phase>` rows.
- The encode is `packages/memory/v2/message-compression.ts` (`send/encode`).
- The inbound side's `memory/frame/queue` and `memory/frame/handle` rows say
  what a client's own frames wait behind.

Measure before designing. Four questions, each answerable with the probe
recipe below, decide which change to make:

1. **Inside a walk, what is the schema traversal and what is the document
   read?** The `slow-traverse` counters already split it per document; the
   `memory/refresh/walk/<phase>` rows split a session's refresh by phase.
   Sum them over a burst per arm.
2. **How much of the work is the same across sessions?** Five sessions hold
   the same view of the same documents under different identities. The
   initial `trackGraph` evaluation cache in `packages/memory/v2/query.ts`
   can share space-pure results across identities. Incremental refresh does
   not use that cache. Count repeated document/path/schema tuples during
   refresh, then compare their versions, scoped reach and evaluation context
   before calling those repetitions shareable. Count distinct frame payloads
   against frames encoded separately.
3. **Does a commit re-walk what it did not touch?** Compare the documents a
   pass re-walks with the commit's own writes; the refresh has an
   incremental path (`refreshed.updates`, `changedMisses`), and the question
   is how much of a pass runs outside it.
4. **What does the encode cost without compression?** Time `send/encode`
   with the compression capability off for the sessions in the harness, so
   the compression and the serialization are read apart.

Candidate changes, each a hypothesis until a question above says it is the
one:

- **Share the space-pure part of an identity-keyed walk.** An evaluation that
  touched one scoped instance is keyed to its identity whole, so five sessions
  of the poll re-walk the same space-scoped documents five times when only the
  scoped tail differs between them. Splitting the evaluation so the
  space-pure reach is shared across identities under the existing rule and
  only the scoped tail is evaluated per identity would keep the identity-bound
  invariant (no cross-identity reuse of anything that resolved a scoped
  instance, and nothing recipient-shaped inside the shared part) while taking
  the shared part out of the per-session cost. Verified by question 2's
  counts and a space-scoped traversal count that stops growing with the
  session count.
- **Narrow the re-walk to the commit.** Make the incremental path the only
  path for a commit that touched a bounded set of documents. Verified by
  question 3 and by `traverseSchema` per pass falling with the size of the
  commit rather than the size of the tracked set.
- **Encode once per payload.** Sessions owed the same documents share the
  compressed bytes; verified by question 2's payload ratio and `send/encode`
  per pass.
- **Take the schema cost out of the schema.** The poll's view schema costs
  6,600 `anyOf` branches a walk; a traversal fast path for discriminated
  unions, or a narrower emitted schema from the transformer for the view,
  moves every arm. Verified by question 1 and by `anyOfBranches` per walk.
- **The client arm's duplicate derivations** (five clients deriving the same
  space-scoped documents, four refused) are a separate lever on the loop-off
  arm alone, and the served arms do not pay them.

Whichever change lands, the acceptance is the burst with rendered clients on
the worker arm and the loop-off arm, and the seed, each run twice, with the
serving-side rows beside them, written up as a dated record under
`docs/history/development/performance/` with an entry in
`docs/history/INDEX.md`, the way the records above are.

## How to measure

The burst is `packages/patterns/integration/lunch-poll-vote-burst.bench.ts`.
From `packages/patterns`, one arm at a time, the box otherwise idle:

```sh
CF_LUNCH_POLL_VOTERS=5 CF_LUNCH_POLL_OPTIONS=5 \
EXPERIMENTAL_SERVER_EXECUTION=true SERVER_EXECUTION_WORKER=true \
SERVER_EXECUTION_STORE_READ_THROUGH=true SERVER_EXECUTION_OVERLAP_COMMIT=false \
deno bench -A --no-check integration/lunch-poll-vote-burst.bench.ts
```

`EXPERIMENTAL_SERVER_EXECUTION=false` is the loop-off arm;
`SERVER_EXECUTION_WORKER=false` the main-thread arm;
`SERVER_EXECUTION_FLUSH_DEADLINE_MS` the cadence. The bench prints, per
iteration, a `one burst cost N rejected commit(s) and M rolled-back write(s)`
line from the clients and a `one burst on the serving side` line with the
loop's wave count, the waves cut by the deadline, the watermark's lag, and
the `executor/wave/*`, scheduler and storage rows with their counts and
averages, then the benchmark table with the mean and the range over three
iterations. Read the range: on a four-core container the iterations of one
run differ by about a third, so an arm is measured twice and two arms are
compared within one sitting, never one sitting against another.

The seed is the topics board's, against a toolshed started from source. In
`packages/toolshed`:

```sh
PORT=8400 API_URL=http://localhost:8400 MEMORY_DIR=file:///tmp/seed-mem/ \
ENV=development EXPERIMENTAL_SERVER_EXECUTION=true \
SERVER_EXECUTION_WORKER=true SERVER_EXECUTION_STORE_READ_THROUGH=true \
LOG_LEVEL=warn OTEL_ENABLED=false deno run --unstable-otel -A index.ts
```

and once `/_health` answers, from the repository root:

```sh
deno run -A packages/patterns/integration/topic-board-seed.ts \
  --api-url=http://localhost:8400/ --passphrase="seed measure" \
  --topics=30 --demand=index --crossrefs=2 --citing-topics=3 --body-words=120 \
  --out=/tmp/board.json
```

`GET /api/health/stats` before and after gives the memory server's
`timingStats` (the `memory/*` rows live here on every arm) and the serving
loop's counters under `servingLoop`. With the loop in the worker, the loop's
own timing rows are the worker realm's, which
`GET /api/health/serving-loop-realm` answers with (`timingStats` there) and
`stats` does not hold; read both before and after. The 30-topic seed read 42 s
on the worker arm with the read-through before the port levers and 34 s after.

Spans and a CPU profile come from a throwaway probe, which stays uncommitted
because the workload stays uninstrumented
(`docs/specs/server-side-execution/testing.md` §1). The probe hosts the
bench's own harness in the test process: `MultiRuntimeHarness` from
`packages/patterns/integration/multi-runtime-harness.ts` with the
`lunch-poll-keyed-votes` fixture, `input: { renderPoll: true }`,
`watchPaths: []`, every session with `renderView: true`, a burst driven the
way the bench drives one and ended with `waitForRows`, and each session's
`timingMeasures()` and the host process's `performance.getEntriesByType("measure")`
written out with `CF_TIMING_MEASURES=1` set. The scripts under
`skills/perf-investigation/scripts/` read a capture back:
`aggregate-measures.ts` by key prefix, `attribute-measures.ts --key=<key>
--detail` for who called a key and how heavily, `wall-time.ts` for what was
open while nothing instrumented ran. A CPU profile of the same process comes
from `node:inspector`'s `Profiler` around the burst, rendered with
`renderProfileReport` from `packages/integration/cdp-profiler.ts`; the
`CF_PROF_CPU=1` arm of `skills/perf-investigation/scripts/profile-cf.ts` is
the pattern to copy. Measures taken with `CF_TIMING_MEASURES` on inflate the
loop-off arm several times over, so the bench is the number and the probe is
the attribution, never the other way round.

## How the overlap is validated

The overlap is off by default, so the suites run inline unless a test sets
the policy. The branch validated it by forcing it on for every executor
suite: change the one expression in `SpaceServer.#waveCycle` from
`overlapWaveCommit === true` to `overlapWaveCommit !== false`, run the
`packages/runner` executor suites (`test/executor-*.test.ts`,
`test/serving-worker.test.ts`, `test/executor/*.test.ts`), and put the
expression back. Everything passes under both forms at the branch head; the
two places the forced run changed, the drain's in-flight guard recording its
wave and the guard reading a sibling's seal, are in the served-vote record.
A change to the cycle, the finish or the park is run both ways before it is
pushed. Run these suites with `--preload=test/clock-preload.ts` from
`packages/runner`, as the package's `deno-test` task does. A bare
`deno test` leaves the global `clock` undefined in the executor and
parked-runtime tests; that failure does not establish a container defect.

Before a push: repo-wide `deno fmt --check`, `deno lint`, `deno task check`,
`deno task check-docs-history-index` and `deno task check-skill-facts`, the
`packages/runner` executor suites, `packages/memory`'s `v2-view-interest`,
`v2-demand-changed-principal` and `v2-server-miss-interest` tests,
`packages/toolshed/lib/server-execution.test.ts` and
`packages/piece/test/served-lifecycle.test.ts`.

## Open items

- The watermark under the worker ends the seed 116 to 144 commits behind
  the head where the main thread's ends one behind, as the worker record
  notes; it is unaddressed and it is the known difference between the two
  arms, ahead of the worker's default flip.
- The seed still reads the view interests 34 times over 81 cycles, once per
  watch set that carried views, which is the server's `viewsChanged`
  doing what it says; a seed that registers no views would read once.
- `executor/wave/commit-wait` does not reach the bench's serving-side summary
  line, which names its rows; adding it there would show the overlap's
  residual wait without a probe.
- The overlap's default is off and the decision rule is the served-vote
  record's: it is a worker-arm lever when the fan-out floor moves.
- A root evaluation's schema hash names the schema and not the reader that
  declared it, so the 44 schemas one path is tracked under cannot yet be
  mapped to the pattern's reads; a dump of a session's tracked selectors with
  their schemas is what the census's first two removals need before they
  are built.

## Stages

1. [x] Answer the four measurement questions on the worker arm and the
       loop-off arm, with the probe, and write the answers into a
       [record](../history/development/performance/2026-10-19-served-vote-fan-out.md).
2. [x] Explain execution frequency before selecting another optimization.
       The [work census](../history/development/performance/2026-10-21-served-vote-work-census.md)
       counts one burst on all three arms and names the multipliers: the
       per-session walk (×4 on every server-side count), a path tracked
       under up to 44 schemas (92% of root evaluations), selectors that fail
       the same way every burst (a quarter to a third of traversals), a
       vote's cascade cut into 2.7 waves (each a flush pass, five walks and
       five frames), and, under serving, every client re-running every
       served action (about half of a client's runs). It ends with seven
       removals and the invariant each keeps.
3. [ ] Build the seven removals the census selects, each measured against
       the census's counts before its headline: a removal that does not move
       its count did not remove the work. Each lands behind nothing where it
       is a pure cost reduction and behind a registry entry where it changes
       what a session receives. View-scoped replication is not one of the
       seven; it is measured here because it changes what each session's
       walks cover, the rendered roots and the planner's selection rather
       than everything the client subscribed to, which the first three
       removals also cheapen. It keeps the per-session walk: under it the
       burst's root evaluations halve and its walks do not fall.
   - [x] The serving loop's wave coalescing: a flush deadline that grows
         after a cut settle, capped by `SERVER_EXECUTION_FLUSH_DEADLINE_MAX_MS`.
         The [wave-costs record](../history/development/performance/2026-10-22-served-vote-wave-costs.md)
         reads what a cut wave costs and measures the cap: 68 waves to 8 on
         the main thread, passes, walks, frames and client runs falling with
         them, the serving scheduler's runs not. Still open on it: counting
         the seed with a cap, and choosing the default cap.
   - [x] The server deciding what each session receives
         (`EXPERIMENTAL_WEB_VIEW_SCOPED_REPLICATION`), measured and read
         ([record](../history/development/performance/2026-10-22-view-scoped-replication-vote-burst.md)):
         25.9 s against 4.8 s, from a plan per view per wave re-walking the
         UI and a full re-evaluation per changed plan; the planner plans a
         cut wave over its last walk and an unchanged delivery rides the
         next frame, for 9.1 s on the main thread and 5.4 s in the worker,
         against 4.8 s and 4.7 s with the flag off on this workload, where
         every viewer sees everything.
   - [x] The serving pass running every ready event before one derivation
         pass, a head the preflight parked on its own loads retried within
         the pass: 51 scheduler passes to 4 and a 6.2 s probe burst to 3.3 s
         with the flag off
         ([record](../history/development/performance/2026-10-22-served-vote-batching-and-planner-reads.md)).
   - [x] Of what the view-scoped record left: a grown delivery extends the
         session's support graph in place, the committed documents reach the
         sessions before the planner walks, three costs a cell read repeated
         are gone (the view-reference hash of the renderer schema, a
         decomposer refusal rebuilt per read, equality by hashing), and the
         walk keeps what it found at each cell between walks, for a plan of
         220 to 266 ms where it was 442 ms; the benchmark's worker arm with
         the flag on reads level with the loop off (same record).
   - [ ] What that record leaves: the plan's size (548 roots, the same 548 as
         inputs, 1,058 producer bases, to each session at each quiescent
         settlement), a plan per session, and the planning tail on the main
         thread.
   - [ ] One root evaluation per (document, path) per walk with its schemas
         validated against it, and a memo for a selector that failed against
         a document version (the memory server, every arm).
   - [ ] The space-pure part of a root evaluation shared across the
         sessions of one batch (the memory server, every arm).
   - [ ] The client integrating a served value as a result rather than a
         trigger (the client, under serving).
   - [ ] The bookkeeping-only commits that skip the walk.
   - [ ] On the OFF arm, a watch add answered without waiting for a flush
         pass to end.
4. [ ] Measure the burst on both arms and the seed, twice each, and record
       them beside the serving-side rows.
5. [ ] Revisit the overlap's default under the worker once the floor has
       moved, and the worker plan's stage 6.
