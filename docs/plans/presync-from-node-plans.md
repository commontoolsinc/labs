# Pre-syncing from node plans

A piece's runs read through the schemas the transformer narrowed to what each
lift and handler body touches. The pre-sync that pulls documents before those
runs follows wider schemas, walks the pattern graph a second time with code of
its own, and then holds every first run on a space-wide timer rather than on
the loads it asked for. This plan makes one derivation per node serve both
instantiation and the pre-sync, on resumes and fresh starts alike, and gates
each node's first run on the loads that derivation named.

The audit this plan follows from is
[`../history/packages/runner/presync-audit-2026-09-09.md`](../history/packages/runner/presync-audit-2026-09-09.md).
Its findings are summarized below where the plan acts on them; the audit holds
the evidence.

## Vocabulary

A **node** is one entry of a pattern's graph: a JavaScript node (a lift or a
handler), a raw node (a builtin such as `map` or `fetchJson`), a passthrough
node, or a pattern node (a nested pattern instance). Each node has **input
bindings** and **output bindings**: aliases into the piece's argument
document, its result document, and its derived internal cells.

A node's **module schema** is what the node reads its inputs under at run
time. For a lift or handler it is the argument schema the transformer
narrowed to the body's reads and injected into the module. For a raw node it
is the builtin's registered input schema. For a pattern node it is the child
pattern's argument schema.

A **node plan** is the derivation this plan introduces: from a node, an
argument link, a result cell, and the pattern, the bound inputs as an
immutable cell, the module schema those inputs are read under, the bound
outputs, the resolved write targets, and, for a pattern node, the child
result cell under the child's result schema.

To **name** a document is to sync it directly, so that the replica holds it
before anything reads it. Since #7193 the store delivers a document's
`pattern`, `argument`, `result`, and `internal` metadata as data on the
document and follows none of those links, so a document a run reads is local
only if something named it or a selector reached it.

## Where the runner stands

Five places bind a node's inputs and outputs to documents. `#bindNodeIO`
serves JavaScript nodes, `#buildRawNodeInputs` serves raw nodes and was
already factored out so the resume pre-sync could derive a list
coordinator's inputs without instantiating it, the passthrough node and the
pattern node each bind inline, and the resume pre-sync's node walk binds
every node once more with a copy of the same calls. The walk syncs each
write-redirect link under the link's own schema, which is a slice of the
pattern's authored argument schema, and pushes the argument document as a
link-target root under the whole authored schema. Neither is the module
schema, so the pre-sync pulls what the authored type reaches rather than what
the bodies read.

A fresh start gets less. `runSynced` walks the caller's argument raw and skips
the node walk, because the `argument` meta link it keys on does not exist
until setup writes it. `run()` pre-syncs nothing for a fresh piece.

Pattern nodes get their child's derived internal cells named through the
owned-cell walk and nothing else: the child result document is never named,
the child's nodes are never walked, and the child's inputs are bound under the
child's whole authored argument schema.

Every action resumed from storage then holds its first run until the space's
`synced()` resolves or two seconds pass. The constant's own comment records
that this is an anti-churn optimization rather than a gate: a run whose input
had not landed reads absent, computes a different value, writes it, and
conflicts when the durable value arrives. The precise wait exists for events
only: an event parks on the specific in-flight loads its closure reads, and
since #7189 a client dispatch whose argument read cold re-runs parked on the
loads its own reads registered. Computations have no such park.

## Design

### One plan per node

`#nodePlan(node, argumentLink, resultCell, pattern, tx)` returns:

- `inputsCell`, the immutable cell `#instantiateJavaScriptActionNode` and
  `#buildRawNodeInputs` already build from the bound input bindings;
- `readSchema`, the module schema the node reads `inputsCell` under, with a
  handler's `$event` slot excluded;
- `outputs`, the bound output bindings, and `writes`, their write-redirect
  links, each carrying the output binding's schema;
- for a pattern node, `childResultCell` under the child's result schema and
  the bound child pattern, derived as `#collectResumeOwnedCells` and
  `#instantiatePatternNode` derive them today.

Instantiation consumes the plan: `#bindNodeIO`, `#buildRawNodeInputs`, the
passthrough node, and `#instantiatePatternNode` each take their bound values
from it instead of binding on their own. The pre-sync consumes the same plan.
Whatever a node reads at run time, it reads through `inputsCell` under
`readSchema`, so a pre-sync that walks exactly that pair pulls exactly the
run's read set and nothing the authored schema reaches beyond it.

### The pre-sync walks the plan

`#syncArgumentLinkTargets` already walks a root value in lockstep with a
schema, crossing each link the way a read crosses it. The pre-sync gives it
one root per node, `{cell: inputsCell, schema: readSchema}`, in place of the
per-link syncs, the per-link roots, and the whole-argument root. An immutable
cell is a data-URI document that is local by construction, so crossing out of
it costs no hop: the two-hop budget starts counting at the first stored
document, where it starts today.

Outputs are named under the output binding's schema for every node kind. For
a JavaScript or raw node that is the write target, a derived internal cell or
a result path, under the module's declared result schema. For a pattern node
it is the child result cell under the child's result schema, which today is
not named at all. A pattern node's inputs are not walked at the parent level:
the child's own nodes read through the child's argument document, and the
recursion below walks them under their own module schemas.

The argument document itself stays named, schema-less, as #7193 made it:
setup reads it whole to write the caller's argument over the stored slots.
Naming a document schema-less pulls its bytes and follows nothing, so this
keeps the document local without widening what is walked.

### Children are walked after they are local

A child's node plans need the child's `argument` meta link, which is data on
the child result document. The pre-sync therefore runs in two waves per
level: name every child result cell in the first, then plan and walk each
child's nodes in the second, recursing. Each level names its own argument
document and derived internal cells, as the top level does. List coordinators
keep `#syncResumeListChildren`, whose children are derived from the
coordinator plan rather than from a pattern node, and each child it names is
then walked the same way.

### A fresh start binds against a local stand-in

Binding needs an argument link, and a fresh piece has no argument document
until setup writes one. The pre-sync mints an immutable cell holding the
caller's argument and binds every node plan against its link. The plans then
walk as on a resume: `inputsCell` links into the stand-in, the stand-in holds
the caller's links, and the walk crosses them under the module schema. This
gives `runSynced` and `run()` the same per-node pre-sync a resume gets, with
no separate mechanism and no derived read surface over the argument. The
audit's recommendation to derive such a surface is superseded by this.

### Each first run waits on what its plan named

The pre-sync returns, per node, the promise of the loads its plan named. On
resume `#startCore` hands each node its promise, and the scheduler holds that
action's initial run until it settles, in place of the space-wide timed hold.
A load that fails settles the promise too, so the hold never waits on
something that will not arrive and needs no timeout. Sub-pieces get the same
treatment from their own level of the walk; a map's element runs get theirs
from the list-children pass. Map's own resume guards, the journaled probe
reads that defer a reconcile while its container or list is still streaming,
stay: they are re-triggered by arrival, not by time.

With the loads named exactly and the run held on exactly those loads, a
resumed lift over unchanged inputs recomputes the value the store holds and
the diff elides the write. That is the no-op the resume path is meant to
produce, and it no longer depends on a two-second race.

### The named-family gate asks the plans

`#familyAbsent` and `#swapReadsAbsent` decide whether a run or a swap over a
stored piece must name its family first. They probe presence with a raw
four-hop scan of the argument under a 256-probe budget. With plans available
the question has an exact answer: the documents the plans' walks would name.
The gate keeps its structure and its hold, and reads the plan's set instead
of scanning.

## Stages

Each stage lands on its own and leaves the tree green. The order is the
dependency order; stages 2 and 3 can proceed in parallel once stage 1 has
landed.

### Stage 0. Prerequisite

- [ ] #7193 lands: the store delivers metadata as data and follows only
      `cfc`. Its runner changes (naming the argument document in the node
      walk, `syncStoredPieceCells`, the `#familyAbsent` and `#swapReadsAbsent`
      gates) are what stages 2 and 5 build on.

### Stage 1. One plan per node

- [ ] Add `#nodePlan` and route `#bindNodeIO`, `#buildRawNodeInputs`, the
      passthrough node, and `#instantiatePatternNode` through it. The pattern
      node keeps its two binds (the value bind with the manifest, the
      identity bind without) inside the plan; the plan exposes both.
- [ ] Route `presyncInputs` through the plan with the event folded in, so a
      handler's dispatch pre-sync and its start pre-sync derive from one
      place.
- [ ] Test: for each node kind, the plan's `reads` and `writes` equal what the
      instantiation path subscribed the action with before the change. The
      existing instantiation and scheduler suites are the regression net;
      this stage changes no behavior.

Exit: no binding call outside `#nodePlan` except `sendValueToBinding`, which
writes rather than plans.

### Stage 2. The resume pre-sync walks the plans

- [ ] Replace the node walk in `#syncCellsForRunningPatternInner` with one
      root per node plan, walked by `#syncArgumentLinkTargets`; make crossing
      out of a data-URI document cost no hop.
- [ ] Name each plan's outputs under the output binding's schema, the child
      result cell included.
- [ ] Remove the whole-argument root under `pattern.argumentSchema`. Keep the
      schema-less naming of the argument document.
- [ ] Test, red first: a pattern whose authored argument type declares a link
      no lift body reads. Under the current walk the target is pulled; under
      the plan walk it stays cold, and the piece's first runs commit without
      conflict. `resume-argument-link-target-presync.test.ts` is the file.
- [ ] Test: a target a lift body reads through two stored hops arrives, so
      the hop budget was not shortened by the immutable root.
- [ ] Measure on the topics board and the default app: `resumeCellSync` count
      and `resumeArgumentLinkTargetSync` total from the runner timing stats,
      before and after, and the count of `piece-start-commit-recovering`
      warnings on a cold resume. `docs/development/debugging/profiling.md`
      names the rows.

Exit: no resume pre-sync path reads a schema wider than a module schema or an
output binding's schema, and the measurements are recorded in the pull
request.

### Stage 3. Children and fresh starts

- [ ] Recurse the walk into pattern nodes: first wave names child result
      cells, second wave plans and walks child nodes, each level naming its
      argument document and derived internal cells. `#collectResumeOwnedCells`
      folds into this walk rather than running beside it.
- [ ] Give `runSynced` and `run()` the plan walk against an immutable
      stand-in for the caller's argument.
- [ ] Test, red first: a nested pattern whose child lift reads a link the
      parent never reads. On resume the target is local before the child's
      first run; today it is not, and the run conflicts.
- [ ] Test, red first: a fresh `runSynced` of a pattern whose lift reads
      through a link in the caller's argument commits its first run without
      conflict.

Exit: a resume and a fresh start name the same set for the same pattern and
argument, the stand-in aside.

### Stage 4. First runs wait on named loads

- [ ] Have the pre-sync return per-node load promises and thread them through
      `#startCore` to the scheduler as the initial-run hold, for the top
      level, for sub-pieces from their own wave, and for list children from
      the list-children pass.
- [ ] Retire `awaitSyncBeforeInitialRun`'s space-wide `synced()` wait and
      `INITIAL_RUN_SYNC_HOLD_TIMEOUT_MS`. The option name can stay as the
      carrier of the per-node promise, or be renamed; the plan does not care
      which. `defersInitialRunUntilSynced` and map's `resumeBatchAwaitSync`
      keep their meaning as "this run is a resume".
- [ ] Test, red first: a resumed lift whose named load is deliberately
      delayed past two seconds does not run cold. Under the timed hold it
      runs and writes a conflicting value; under the load-gated hold it waits
      and its write is elided.
- [ ] Test: a named load that fails releases the hold rather than leaving the
      action parked.

Exit: no resumed action's first run is released by a timer.

### Stage 5. The gates ask the plans

- [ ] Replace the raw four-hop scan in `#familyAbsent` with the set the
      plans' walks would name, and `#swapReadsAbsent` likewise. Keep the
      probe budget only if the plan set can be large; measure the set's size
      on the topics board first.
- [ ] Test: the existing `piece-named-before-start.test.ts` cases pass
      unchanged, and a case where the raw scan over-held (a link in the
      argument no body reads) no longer holds.

Exit: `NAMING_PROBE_BUDGET` is either gone or justified by a measurement in
the pull request.

### Stage 6. Documents

- [ ] `docs/common/concepts/pattern.md` describes the resume pre-sync of
      `[UI]`; restate it in plan terms.
- [ ] `docs/development/debugging/profiling.md` names the `runner/start/*`
      timing rows; rename or add rows as the waves change.
- [ ] `docs/specs/server-side-execution/serving-loop.md` §3b says
      computations self-heal through the change channel and so need no
      pending-load park; stage 4 changes that for first runs on resume, and
      the section says so.
- [ ] Archive this plan to `docs/history/plans/` when stage 5 lands.

## What this plan does not do

- It does not add an argument pointer or an input hash to derived internal
  cells. The plan derives a node's read set from the graph, which is the
  information such a pointer would carry, without a new durable field. An
  input-hash memo that skips a lift body is a separate optimization for lifts
  whose bodies are expensive, and is not needed for the no-op this plan is
  after.
- It does not change what the store delivers. #7193 settles that: metadata
  is data, and the runner names what it reads.
- It does not raise the two-hop budget. Stage 2 keeps the budget as it stands
  and records the measurement that would justify changing it.
- It does not remove the `FabricInstance` stops in the walks. They are
  recorded gaps with their own TODOs; the plan walk inherits them.

## Risks

- **A plan that binds differently from instantiation.** Stage 1's equality
  test is the guard, and stage 1 lands before any pre-sync change so a
  binding regression shows up on its own.
- **A cold target the module schema does not declare.** A body that reads
  more than the transformer saw, through `unknown` or a `true` schema, falls
  back to the raw scan as today, with the same hop budget. Stage 2's
  measurement watches the `piece-start-commit-recovering` count for a rise.
- **A hold that never releases.** Stage 4's promise settles on failure as
  well as success, and the test for a failed load is what pins that.
- **Wider pull requests than the stages suggest.** `runner.ts` is where all
  of this lives, and the binding sites are scattered through it. Each stage
  is one pull request; a stage that grows past that splits by node kind.
