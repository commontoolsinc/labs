# Topics computation cost and live upgrade

## Objective

Reduce repeated collection work in Topicboard and individual Topics while
preserving their authored data, public behavior, identities, and bounded demand
shapes. Use maintained collection indexes and named aggregates where
measurements justify them. Ship improvements in independently reviewable
changes, then rehearse and coordinate an upgrade of existing pieces.

This plan authorizes no live writes by itself. Implementation, synthetic demos,
and isolated copy rehearsals can proceed before a deployment window is chosen.

The implementation surfaces are
[the board](../../packages/patterns/topics/main.tsx) and
[the topic](../../packages/patterns/topics/topic.tsx). Contracts are documented
in [collection indexes](../features/collection-indexes.md),
[aggregates](../features/collection-aggregates.md), and
[read accounting](../features/read-accounting.md). Authoring examples and
operation-selection guidance live in
[reactive collections](../common/concepts/reactive-collections.md).

## Expected improvements and limits

The board's `crossrefTable` materializes narrow mention lists once, then scans
source lists for each destination. Each topic's `backlinksOf` scans the
resulting table to find its own row. Topic rendering separately derives active
comments, active links, presence booleans, and link-resolution inputs.
`lastActivityOf` scans comments and links, including edits and retractions.

Let N be board topic occurrences, E be total mention occurrences, C be comments
in a topic, and L be links in a topic. These are work hypotheses to test, not
latency predictions or unconditional complexity guarantees.

| Candidate                                                   | Expected benefit                                                                                                                           | Remaining cost or risk                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared keyed backlink-row lookup                            | Remove each demanding topic's repeated search through N cross-reference rows. With N consumers, eliminate a potential N-by-N lookup stage. | The pivot producer remains. Index maintenance and consumer demand can add graph work; putting an index inside every topic would duplicate maintenance. |
| Reuse active counts/views                                   | Avoid duplicate C- and L-sized filtering for presence and link resolution.                                                                 | Likely a modest constant-factor benefit; sharing a broader view can increase demand.                                                                   |
| Maintain source-to-destination edges grouped by destination | On a local mention edit, update affected edges and destination buckets instead of rescanning all source lists for every destination.       | Building all edges afresh retains producer cost. Ordering, duplicate occurrences, membership reconciliation, and large buckets require work.           |
| Maintained comment count                                    | Reduce repeated predicate work for large threads when one independently linked comment changes.                                            | Shared captures or broad source edits can invalidate many predicates; small threads may not benefit.                                                   |
| Maintained activity maxima                                  | Reduce full comment/link timestamp scans on localized activity edits.                                                                      | Must include edit and removal timestamps; score production and public Cell typing can dominate the benefit.                                            |

A reduction in reads can coexist with increased startup cost, graph size,
storage, or latency. Do not promise a percentage speedup before matched
measurements. Client replication and network narrowing are separate work; index
buckets returning links do not establish smaller network demand.

## Compatibility requirements

Keep titles, bodies, authors, comments, links, attachments, names, and piece
identities intact. Keep the board's original topic links for card rendering and
its compact `mentionableIndex` and narrow headless `index` projections. Preserve
the persistent short-name allocator and its never-reuse contract. Sorting cards
is still a global operation; this plan introduces no incremental sort or top-K.

Backlinks must retain canonical identity semantics, including aliases and scope.
Self-mentions are excluded. Repeated mentions from one source occurrence yield
one inbound occurrence; duplicate board source occurrences require their own
cardinality tests. Inbound order follows the board's source order, whereas index
buckets use occurrence-identity order. Preserve visible ordering unless a
separate product decision explicitly changes it. Missing matches yield empty
lists. Unresolved sources must not create invalid-address rows or permanently
disappear.

For activity, retracted comments and removed links still contribute their edit
and removal timestamps. Removing them from the aggregate could move activity
backward. Preserve optional-field defaults and compatibility with stored topic
generations. Preserve linked record identity for editing handlers.

## Execution tracker

Check off a stage only with linked implementation, tests, and measurement
evidence. Record a rejected prototype's results as a dated report under
`docs/history/`; update this live plan with the resulting pending scope. A
conditional stage may close with an evidence-backed decision not to adopt it.

- [ ] **T0 — Establish the baseline and demonstration.** Extend the existing
      [scale](../../packages/patterns/integration/topic-board-scale.bench.ts)
      and
      [navigation](../../packages/patterns/integration/topic-board-navigation.bench.ts)
      workloads. Separate pivot production, per-topic lookup, activity, and
      rendering costs. Capture a reproducible baseline and a browser demo with
      board, topic, backlink, and comment actions. Exit: the measurement matrix
      below runs with explicit demand and recorded environment/source versions.
- [ ] **T1 — Share individual-topic derivations.** Reuse `commentCount` for
      `hasComments`; evaluate sharing the active-link view with `hasLinks` and
      link resolution. Preserve narrow compatibility schemas and stable links.
      Exit: behavior tests pass, repeated work falls, and sharing does not
      unintentionally broaden board demand. Can proceed independently of T2.
- [ ] **T2 — Prototype one shared backlink-row index.** Index the existing
      cross-reference rows by topic identity once at the board level. Compare
      direct lookup with each topic scanning the table. First prove how an index
      handle can cross the board/topic schema boundary without duplicating its
      producer. Retain existing public results through a compatibility bridge
      where needed; do not assume adding a required field is rollout-safe. Exit:
      reduced lookup-stage scaling, bounded maintenance cost, and a written
      old/new board-topic compatibility matrix. Depends on T0.
- [ ] **T3 — Maintain the mention relation.** Prototype stable per-source edge
      production, per-source-occurrence mention deduplication, and shared
      grouping by destination. Preserve backlink order and original source
      links. Measure edge production separately from bucket lookup. Compare
      against the T2 candidate, not only the original implementation. Exit:
      same-count retargets update only the required relation work where
      supported, complete-workload costs justify adoption, or a report explains
      deferral. Depends on T0 and the T2 schema-boundary decision; T1 need not
      block it.
- [ ] **T4 — Evaluate large-thread aggregates.** Compare a maintained active
      comment count and activity maxima with the T1 implementation. Use explicit
      Cell receivers and measure score/predicate production; do not rely on
      unsupported ordinary-array `.map(...).sum()` chains. Exit: adopt only the
      candidates with justified end-to-end tradeoffs. Depends on T0 and T1.
- [ ] **T5 — Harden accepted changes and prepare release artifacts.** Add
      regression read budgets, run all relevant authored/package/integration
      tests, preserve compatibility baselines, and update maintained docs.
      Produce matched before/after demos and reports. Each implementation PR
      needs an antagonistic review and a clean Cubic review on its final head
      before merge. Exit: all accepted T1–T4 changes are merged, remaining
      proposals are explicitly deferred, and exact deployable source packages
      are recorded.
- [ ] **T6 — Rehearse real stored generations.** Inventory and copy the intended
      board space, verify linked-space coverage, run the two-pass upgrade
      procedure below, and write a concrete rollout/rollback manifest. Exit: two
      clean passes with semantic and authored-content evidence. Depends on T5;
      acquisition and inventory can begin earlier without blocking synthetic
      work.
- [ ] **T7 — Coordinate and execute live rollout.** Obtain the owner's target
      list and deployment window, confirm runtime prerequisites, upgrade in the
      rehearsed order, and verify each stage before proceeding. Exit: every
      target has a recorded source revision and acceptance result, or an
      explicit partial-rollout/rollback disposition. Depends on T6 and live
      authorization.
- [ ] **T8 — Publish outcomes and archive the plan.** Publish measured benefits
      with workload limits, the authoring guidance, and the final deployment
      status. Transfer genuine fast-follows to separate plans and archive this
      plan following [the documentation lifecycle](../README.md).

## Measurement and acceptance

Use synthetic boards at 32, 128, and 512 topics initially, with low-degree and
high-degree mention graphs; vary E independently of N. Exercise a single large
inbound bucket as well as distributed links. Test threads at 10, 100, and 1,000
comments, varying L separately. Keep a small everyday board in the matrix to
expose startup and maintenance overhead that scaling tests can hide.

Demand three distinct workloads: the board alone, the board with one topic open,
and all backlink outputs for a scaling probe. Do not describe the last workload
as normal UI behavior. Measure cold initialization, warm updates, and reopen or
reconnect separately. Hold runtime, source package, data, demand, and feature
flags constant between comparison arms; alternate repeated timing runs and
report their distribution rather than a single favorable sample.

Test mention insertion/removal, same-count destination retargeting, duplicate
and self-mentions, aliases/scoped references, topic reorder/removal, rename-only
and body-only edits, comment append/edit/retraction, link removal, and unrelated
sibling edits. Include unresolved linked inputs, cold recovery, and two-client
observation. Existing naming, rejection, render-shape, view-identity, and
multi-user tests are part of acceptance, not replaced by benchmarks.

Record completed body and transaction-attempt reads with their distinct
boundaries, executions, graph nodes/edges, elapsed time, and available storage
or memory measurements. Count producer and consumer work separately but decide
on the complete settled operation. Network claims require bytes/subscription
measurements in addition to read accounting.

T0 must set numeric baseline-derived acceptance limits before tuning candidates.
Use total and per-run read budgets with explicit output/UI demand, then exercise
a scan-regression negative control to prove the budget detects the intended
regression. An accepted candidate must preserve semantics, improve its targeted
scaling/work measure, and stay within the recorded startup, graph, and latency
limits. If measurement noise prevents a latency conclusion, say so; if a cost
exceeds its limit, revise or defer the candidate rather than silently moving the
limit. A new tradeoff needs a documented decision and rationale.

## Stored-state and deployment procedure

Repository merge does not update existing pieces. `cf piece setsrc` updates an
existing piece in place; `piece new` would create a different piece. A board and
its existing topic children are separate targets. Updating imported source in a
board's package does not upgrade those existing children.

1. Inventory target piece IDs, source revisions, stored input/result contracts,
   linked spaces, and active generations. Inspect the deployed parent's stored
   demand, not just its current repository source. Record whether each
   improvement changes only derived computation, a public result, or persisted
   state.
2. Confirm the target runtime/compiler supports the operators. Reconcile with
   the Topics pattern's stored-state upgrade mechanism before a stored-state
   change. During T6, document the deployed version contract and migration steps
   in the [Topics documentation](../../packages/patterns/topics/README.md), or
   establish that mechanism and its repository documentation before relying on
   it. Pure derivation changes need not require a stored-state migration. If
   persisted state must change, specify version handling, idempotency, legacy
   writers, and rollback limits explicitly rather than forcing a schema
   override.
3. Acquire a consistent snapshot through the owner/operator and follow the
   [space-clone rehearsal procedure](../development/space-clone-rehearsal.md).
   Identify absent cross-space inputs and obtain appropriate rehearsal coverage;
   do not treat their missing values as representative production data. A local
   copy validates stored data and runtime behavior; use the
   [staging procedure](../development/staging-space-copy.md) when deployment
   topology or shell behavior needs qualification.
4. Run every authored test and retain the exact complete source package. Run
   `setsrc --check` against the clone, then apply with every test root and data
   attachment included. Tests attached to deployment are packaged/type-checked,
   not executed there. Classify refusals, including missing linked data; a clean
   compatibility check is not an apply or semantic acceptance result.
5. Choose upgrade order from the old/new board-topic compatibility matrix.
   Usually children precede the board, but an old board unable to read a new
   child needs a bridge or parent-first sequence. Check old/old, old/new,
   new/old, and new/new combinations that can occur during rollout or rollback.
   Keep each transition serial and inspect its result before the next.
6. Verify authored content independently of `space verify --expect-migration`:
   that command detects removal, not in-place clobbering. Check board
   membership, ordering, names, backlinks, titles/bodies, attribution,
   comment/link records, handlers, and settled background churn. Stop the clone
   server, reset, restart, and repeat from the pristine snapshot for a second
   clean pass.
7. Before live execution, record target order, exact package hashes, retained
   source revisions, expected schema/data changes, acceptance commands, snapshot
   location, and rollback actions. Coordinate legacy writers and client refresh
   if a schema/state transition requires them. Source restoration does not undo
   stored-data migration. Whole-space snapshot restoration can discard later
   human edits; specify a recovery window and preservation procedure before
   relying on it. A local clone reset command is not a live rollback procedure.
8. Obtain live authorization for the concrete manifest. Start with the smallest
   rehearsed compatible target set, verify it, then continue serially. Record
   failures and successful targets durably. Stop dependent updates on
   unexplained missing data, altered content, unresolved compatibility failures,
   or failed semantic checks; do not bypass them to complete a batch. Keep
   independent investigation and remediation work moving.

## Decisions to collect without blocking implementation

T0–T5 can proceed with synthetic/local data and the conservative semantic
requirements above. Before T6, obtain the intended board URL(s), authorized
snapshot acquisition path, and coverage for linked spaces. Before T7, agree on
the live window, target set, operator, and recovery constraints. Raise a product
question only if evidence suggests changing visible ordering, duplicate
behavior, or another preserved contract; keep the existing semantics while it is
pending.

Do not include handler laziness, replication changes, a new naming allocator, or
unrelated author migrations solely to enlarge this performance release. Their
independent plans can proceed without blocking the compatible improvements here.
