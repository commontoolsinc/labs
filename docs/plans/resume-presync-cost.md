# Cutting the resume pre-sync's cost

Opening a piece with nested instances — a chat room with twenty message rows,
a board with a hundred topics — spends most of its time in the pre-sync that
names what each node reads before the piece runs, and almost none of it in
the pattern's own code. Measured on a fabrichat room on Estuary, the pre-sync
was over half of 49 CPU seconds, the server at most 14 s of its own, and the
client starved its own socket for minutes at a time while it planned. The
record is
[`../history/development/performance/2026-10-fabrichat-room-load.md`](../history/development/performance/2026-10-fabrichat-room-load.md).

This plan removes the work that measurement showed to be repeated or
unnecessary, and keeps the pre-sync's guarantees: every document a first run
reads is local before it runs, across spaces, and a child's start names what
its parent's did not. It continues
[`presync-from-node-plans.md`](presync-from-node-plans.md), whose vocabulary
(node, node plan, name) it uses, and leaves that plan's owed stages where they
are.

## Where the cost comes from

Four things multiply, and each is a stage below.

**Every child start names its family again, for a document no store holds.**
The root's start plans and syncs every nested instance, level by level, and
that is right. Each child then reaches `runner.run()` on its own once its
parent's coordinator runs, and `#patternToNameBeforeRun` decides whether to
name the child's family — a full pre-sync of its subtree — by probing
whether anything its run reads is absent from the replica. A derived cell
the parent hands down as an argument and nothing has computed, a per-session
display flag say, has no document anywhere; the root's waves asked the store
for it and were told so. The probe reads value presence alone, so the
document counts as absent, the child holds, and its name-sync delivers
nothing. Instrumented on the room: 79 holds, every one at that stage, none
for the probe budget, every absent document a `computed:` cell, the same
few recurring across the rows that received them.

**A plan's inputs cell recomposes every schema.** `#bindNodeIO` hands the
bound inputs to `getImmutableCell()`, which rewrites each link's
content-addressed schema reference into its recomposed form before minting
the `data:` id. The rewrite stays: a traversal accepts a reference-form
schema only where the space it is reading persists that schema's closure,
and no write has stored the links a plan binds, so a link inside the inputs
cell carries its schema inline (`packages/runner/src/link-utils.ts`). What
costs is that recomposition built a fresh object graph per call, so the
interned-schema cache never hit and every call deep-froze and hashed the
same closure again.

**The cross-space pass materializes to discover.** `#syncCrossSpaceReads`
does a full schema-validated `get()` of every plan's inputs, in every round,
to find a link into another space that the server's per-space walk could not
follow. Most plans hold no such link, and the ones that do are found by
walking links, not by building values.

**Planning never yields.** The planning loops run on one microtask chain.
`#syncFamilyCell` sends a watch frame as a side effect, so the loop keeps
sending while nothing reads the socket; the server answers each frame within
a second and the client reads the answer minutes later. The serving scheduler
has a cooperative macrotask yield for exactly this shape
(`packages/runner/src/scheduler/cooperative-yield.ts`); the resume path has none.

## Stages

Each stage lands on its own, with its test red first. The measurement in
stage 0 is what every later stage reports against.

### Stage 0. Count the plans

- [x] A runner unit test that resumes a three-level tree — a list of rows
      each holding a nested badge — against an in-process memory server,
      demands every row, and counts the pre-sync's node plans against the
      `(instance, node)` pairs the tree holds
      (`packages/runner/test/resume-presync-plan-count.test.ts`). The count
      reaches the test through `Runner.accessForTestingOnly.presyncPlanRecorder`.
      The ratio is one: the root's waves plan each pair once, and a child
      whose family is whole does not name it again. What the field load pays
      is the next stage's hold, which this shape does not provoke because
      the root's own run computes the derived argument before the rows
      start.
- [ ] A benchmark in `packages/runner/test/` that resumes the same shape at
      sizes 10, 20, and 40 rows and reports wall time, `#nodePlan` calls,
      and watch roots requested, with the fixture outside the timed window
      (`docs/development/BENCHMARKS.md`, "Time only the operation the name promises").
- [x] The field check: `cf piece render` of the Estuary room, under
      `CF_MEMORY_FRAME_LOG`, read with
      `skills/perf-investigation/scripts/summarize-frame-log.ts`. The
      numbers to carry are CPU seconds, `start/syncCellsForRunningPattern`
      count, watch frames, roots requested, and bytes out; the record above
      has the baseline (80 name-syncs, 49 CPU seconds).

Exit: a number per stage that a pull request can quote.

### Stage 1. An immutable cell's inline schemas come from a memo

- [x] `inlineExternalSchemaRefsInValue()` keeps the inline form each
      reference recomposed to, by reference, for the registry epoch
      (`inlinedSchemaByRef`, cleared with the registry). Recomposition
      built a fresh closure per link per plan, so every call deep-froze and
      hashed the same few schemas again; a reference names one content, so
      the form it recomposed to once is the form it has.
- [x] Tests: the inline form is the same object on a second call for the
      same reference (`packages/runner/test/link-utils.test.ts`); an
      immutable cell carries each link's schema inline and a read through it
      resolves the linked value (`packages/runner/test/runtime.test.ts`).

Exit: a schema is recomposed once per reference per registry epoch.

### Stage 2. The gate probes what a name-sync could deliver

- [x] `#familyAbsent`'s argument walks probe the documents the argument
      links to and continue only through a redirect's hop, as its contract
      says, rather than into the content of every linked document four
      deep. The content of a value document is what the piece's nodes read
      through it under their plans' schemas, and the pre-sync names it that
      way; a link inside it is not one the argument holds, and the hold's
      name-sync names nothing for it. The field holds were all of this
      shape — 79 of 79, one to three hops below the row's argument, never
      delivered, never requested as a root: the room's derived cells first,
      then its handler streams, then fields of profiles in other spaces,
      each surfacing as the previous one was excluded.
- [x] Two direct links the walk still reaches are excluded by kind: a
      derived cell (`computed:` scheme), whose document its computation
      produces and whose absence the store's walk cannot report, and a
      stream, whose document holds no value and whose sends are events; a
      piece's own streams are still probed with its owned cells.
- [x] Tests, red first, in
      `packages/runner/test/piece-named-before-start.test.ts`: a piece
      whose family is local runs without holding when its caller's argument
      links to a derived cell nothing has computed, to another piece's
      stream, or to a local document whose content links to an absent one.
- [x] The field check: `start/syncCellsForRunningPattern` on the room from
      80 to 32, `resumeCellSync` spans from 4,877 to 502, the rendering
      unchanged.
- [x] The holds left after that were on per-user instances (`scope: user`)
      of documents — a viewer's per-user cells the chips receive — which no
      store holds for a viewer who has not written one, and which a
      name-sync could not deliver. The gate no longer walks the argument of
      an instance the resume pre-sync planned under the same pattern
      (`Runner.#presyncNamedInstances`, the first part of
      `docs/plans/presync-from-node-plans.md` stage 5): the pre-sync's
      plans are the plans a name-sync would build. A tree whose rows
      receive a link to a document nothing has written resumes with one
      name-sync (`packages/runner/test/resume-presync-plan-count.test.ts`).
- [x] The field check again: `start/syncCellsForRunningPattern` on the
      room from 32 to 2, `resumeCellSync` spans from 502 to 204,
      `resumeCrossSpaceRead` spans from 2,586 to 101, and the render's user
      CPU from 37–45 s to 17 s on the same machine at the same load, the
      rendering unchanged. The pre-sync no longer appears among the
      profile's top inclusive frames; pattern compilation and the render's
      sinks do.

Exit: a child's start names its family only when something a name-sync
could deliver is missing.

### Stage 3. The cross-space pass reads a plan again only when it must

- [x] Each plan reads in a transaction of its own, so the loads a read
      kicks are attributable to that plan; a round reads again only the
      plans whose previous read left a load pending, and a plan whose read
      completed is done. The pass had read every plan in every round, so a
      family with one crossing plan among _n_ paid 2*n* reads where it
      needs *n*+1. Each read is a `start/resumeCrossSpaceRead` span.
- [x] Test, red first: four lifts of which one reads through a link into a
      second space cost five reads
      (`packages/runner/test/resume-node-plan-presync.test.ts`).
- [x] The server reports the links its walk follows out of the space in
      the frame that answers the watch (`crossings` on the session sync
      payload, `docs/specs/memory-v2/04-protocol.md`, advertised as
      `syncCrossingsV1`), each as the target-rooted path and schema the
      read needed, the way the walk already shapes a same-space miss. The
      storage manager kicks a load for each from the target space and lists
      it while in flight, and the pre-sync awaits those loads by document,
      through their own frames' crossings in turn, instead of reading its
      plans to find them (`followsCrossings`); against an older server it
      reads as before. The first round had materialized every plan under
      its read schema to find the crossings: on the room, 101
      `resumeCrossSpaceRead` spans after stage 2's second part, 2,586
      before it, and `validateAndTransform` under `#syncCrossSpaceReads`
      a quarter of the profile then.
- [ ] The field check: `resumeCrossSpaceRead` absent from the room's
      profile, the far documents local, the rendering unchanged. The
      deployed server has to advertise the capability first.

Exit: the cross-space pass costs in proportion to the links that cross.

### Stage 4. Planning yields to the socket

- [x] The root wave and the instance waves issue their syncs through
      `#kickResumeWave`, which yields one macrotask turn between cells once
      a slice of continuous issuing is spent (`CooperativeYield`, held by
      the runner on every posture). Issuing a sync is where the synchronous
      work sits — each walks its data-URI links before sending — and no
      transaction is open there: a wave is kicked only after its planning
      transaction is aborted. The list-children pass kicks inside its
      planning transaction and keeps its shape.
- [x] Test, red first: with a zero slice, a timer due before the resume
      starts fires before the wave's last sync is issued
      (`packages/runner/test/resume-presync-plan-count.test.ts`).
- [ ] The frame log on the field check shows no receive silence longer than
      the longest server operation.

Exit: a load's watch responses are read as they arrive.

### Stage 5. Documents

- [x] `docs/development/debugging/profiling.md` names the
      `runner/start/*` rows; it now says what `resumeCrossSpaceRead` and
      `syncCellsForRunningPattern` count.
- [x] `docs/plans/presync-from-node-plans.md` describes the cross-space
      pass; it now
      says a round reads only the plans whose reads left a load pending.
- [x] `docs/specs/memory-v2/04-protocol.md` says nothing about `data:`
      documents carrying schemas inline, and stays silent; the comment at
      `packages/runner/src/link-utils.ts` that did is gone with stage 1.

### Stage 6. The first run and the render

Measured on rooms of thirty and of a hundred and twenty message rows seeded
on a local toolshed
([`../history/development/performance/2026-10-11-fabrichat-room-load-local.md`](../history/development/performance/2026-10-11-fabrichat-room-load-local.md)),
where the pre-sync was no longer the whole cost.

- [x] The scheduler's topological sort indexes the work set's readers by
      the document they read, so a writer's ordering edges cost the readers
      of what it writes rather than the whole set
      (`packages/runner/src/scheduler/topology.ts`).
- [x] The sort's cycle break chooses from a heap it keeps current under the
      break's preference, in place of a filter and a sort of every unvisited
      action at every break. A load of the thirty-row room sorts a work set
      of 3,900 actions with 1,991 breaks in one settle, and that pass had
      cost 4 to 5 s, nearly all of it the comparator
      (`packages/runner/src/scheduler/topology.ts`).
- [x] No computation of the room or of a message row is a declared writer
      of the room's `messages`, so none orders against another through the
      list. The room derives what a row shows of the list as a whole once,
      each row reads its own message's part, and the helpers a computation
      hands the list take it as a `Cell`, which declares no write
      (`packages/patterns/fabrichat/room.tsx`, `message-row.tsx`,
      `room-records.tsx`).
- [ ] The cycle break prefers the lowest remaining in-degree, which picks an
      action downstream of the cycle before the cycle's own members: a
      render effect with one unmet input against a computation with 179.
      1,812 of the room's 1,991 breaks were such picks, each running an
      effect before the computation it reads, which then runs again.
      The specification names the parent preference and registration order
      (`../specs/scheduler-v2/README.md` §7.4); the in-degree preference is
      the implementation's, and limiting the break's choice to the actions
      that are on a cycle is a change to the run order.
- [x] CFC commit preparation indexes a transaction's write-policy inputs by
      the document they name, once per transaction, so the two checks a
      written path makes read the inputs about its document
      (`packages/runner/src/cfc/prepare.ts`).
- [x] The storage manager keeps each data URI's hash and decoded value in a
      weight-bounded memo, and does not sync a link that declares a stream:
      its document holds no value a read uses, and the sync had sent one
      root carrying the stream's event schema per stream to receive an
      absence record (`packages/runner/src/storage/v2.ts`).
- [x] An inline array element's snapshot id is kept by the value's identity
      and the link it was read through, so resolving the element as a cell
      encodes it once per document version rather than once per resolve
      (`packages/runner/src/cell.ts`).
- [x] Measured: the thirty-row room's first load from 71 to 30 s to the
      messages and its second load from 42 to 16 s, on the same machine
      within the hour.
- [x] A handler plan's `$event` slot is read as a stream, the inputs walk
      skips a position the reader declares a stream, and the owned-cells
      wave syncs a stream cell whole: three paths had loaded each handler's
      stream under its event schema, one root carrying that schema per
      stream, for an absence record. A reload of the thirty-row room sends
      6.1 MB of watch frames instead of 10 MB.
- [x] A link schema written into an ordinary document is stored as a
      reference when the reference is the shorter wire form; a trivial
      schema, one decomposition refuses, and a bare handle stamp stay
      inline (`docs/specs/content-addressed-schemas.md`). A nested
      instance's argument document had carried one inline closure per
      captured input, 27 KB of a 64 KB operation per message row in the
      first-run commit, which is now 40 KB.
- [x] The server's oversized-message refusal is a terminal rejection, so a
      commit refused for its size is not sent again unchanged.
- [x] A message row's argument document carried two label entries per
      message in the room, 60 of its 85: the row received a link to the
      whole list at `array`, which its callback never declared, because the
      list built-ins read an unnamed key of an object schema as declared,
      and the link write persisted the list's label view under the slot.
      The built-ins now pass a row only the arguments its schema names and
      drop a stored slot the schema leaves unused on replay, so the label
      maps grow with the message count once, not twice.
- [ ] The remaining label map of a row is its 25 fixed entries, about
      9 KB, of which the `LinkReference` atoms are the largest share: each
      spells its source and its target in full, and on an in-place link
      entry both restate the link stored beside it. Shrinking that is a
      change to the atom's registered shape, which the Contextual Flow
      Control specification owns.
- [ ] A load of a materialized room still commits for a fifth of its time,
      writing a reader's own instance of every session-scoped derivation
      in a commit of its own: 429 commits of about 400 bytes on the
      thirty-row room.
- [ ] The first-run commit of a hundred-row room is one transaction, and
      at 24.7 MB it stood for more slots than the server admits.
- [ ] Each plan's inputs document is still minted per plan; the memo
      removes the repeat hashing and decoding, not the minting.

Exit: a room of a hundred rows opens in the browser.

## Out of scope, noted

The 3.2 MB watch frame is mostly two 5 KB selectors repeated 296 times. A
selector table per frame — each distinct selector once, roots naming it by
hash, as the frame log already records them — would cut the bytes out by an
order of magnitude. It is a protocol change under
`docs/specs/memory-v2/04-protocol.md` and a separate plan.

The compiled program is 1.7 MB per cold worker and evaluates in 0.9 s, with
no cache in the browser; shrinking the compiled output and caching compiled
closures in the browser are each their own work.
