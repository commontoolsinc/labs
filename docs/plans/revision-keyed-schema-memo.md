# Revision-keyed schema memo

A cross-evaluation, per-document memo of schema-walk computation on the
memory server, keyed by each document's revision, sitting underneath the
query evaluation cache. It makes the first evaluation after a commit — and
every evaluation of a query shape the evaluation cache has not seen — cost
roughly what changed, instead of the whole corpus.

## Problem

Evaluating a graph query walks every reachable document against its schema
selector, and the walk is essentially the entire cost. On the estuary board
corpus (Aug-18 clone, 113 topics, 6,112 reachable documents, measured
2026-08-28 at the `trackGraph` level): a cold evaluation is ~1.4 s, and it
is still ~1.4 s when every document's decoded form is already cached —
schema narrowing dominates (~1.1 s inside the traverser), not decoding.

The query evaluation cache (`QueryEvaluationCache`,
`packages/memory/v2/query.ts`) removes that cost for one shape of repeat:
the same query, unchanged corpus, between two commits — a hit is ~2.5 ms at
the same measurement level. Any commit rotates it, different query shapes
share nothing through it, and the per-session refresh and extension paths
sit outside it. So the walk cost remains for exactly the asks a busy space
produces continuously: the first evaluation after every commit, overlapping
queries with different roots, `watch.set` re-establishment, and
`watch.refresh`.

## The design in one paragraph

Memoize the per-document schema-walk computation in a per-engine store,
keyed by (branch, scope instance, id, document revision, interned
selector). Validity is by key construction: the revision is part of the
key, so an entry for a superseded revision is simply never matched again —
no invalidation graph, no rotation, no write hooks; retention is LRU plus a
budget. An entry carries the narrowed result and a manifest of the
traversal's direct effects; a hit replays the manifest through the current
walk's own bookkeeping — re-deriving registrations under the current
identity, never replaying another traversal's recorded effects.

## What the engine already provides

- **The revision is known at load time.** Every read resolves a row
  carrying `row.seq` (and `op_index`) — the revision of the document's
  current state (`readState` → `readRowForBranch`,
  `packages/memory/v2/engine.ts`). No watermark bookkeeping needs to be
  added for the consult: the load the walk performs anyway supplies the
  key component.
- **Revision-keyed caching at this seam has working precedent.** The
  engine's `documentCache` already keys each document's decoded form by
  (branch, id, scope key, `row.seq`, `op_index`, …). This memo is the same
  idea one level up: the narrowing computed from that decoded form.
- **A single choke point exists.** All schema narrowing funnels through
  one memo consult in `traverseWithSchema`
  (`packages/runner/src/traverse.ts`), today keyed by document address
  plus schema hash and scoped to a single traversal. The cross-evaluation
  layer is consulted at the same point.
- **The walk visits roots; the traverser crosses documents.** The server
  walk (`GraphQueryWalk`) visits query roots, and the traverser's own
  recursion reaches the rest of the graph, registering reach (tracker
  entries, absent-link misses) as side effects of first computation. The
  memo therefore slots in without restructuring traversal.

## Why entries must carry their effects

A traversal's registrations — which watchers to notify when a document
changes — happen as side effects of computing a subtree, and an
already-covered (document, selector) skips its subtree including those
registrations. The existing memo's own comment states the consequence: an
entry living past its traversal would answer a later traversal that never
recorded its reads. Measured concretely: injecting one evaluation's warm
memo into a fresh evaluation returns in ~17 ms but registers and delivers
23 of 6,112 documents. A cross-evaluation entry is therefore not a bare
value: it must carry what its computation *did*, and a hit must re-derive
those effects in the current walk. Re-derivation is cheap — replaying the
full board reach (8,524 registration pairs) costs ~2 ms.

## Design decisions

1. **Key**: `(branch, scope_key, id, revision, interned selector)`, where
   `revision` is the row's `(seq, op_index)`. The scope component is the
   resolved instance, never the scope name — identity-safe by
   construction (`key-vocabulary.md` §5's vocabulary). For this layer,
   instance keys replace the single-identity tripwire that guards today's
   shared memos (`assertSchemaMemoIdentity`); the tripwire's job — making
   cross-identity sharing loud — is done here by keys that cannot
   collide across instances. The §5 inventory gains this entry when the
   implementation lands.
2. **Entry value**: the narrowed result (parents compose their own
   narrowing from child results) plus a **direct-effects manifest**: the
   registrations this document's own traversal makes, links out with the
   selector each carries, absent-link misses — all in scope-unresolved
   form (scope + id, not instance) — and the direct children with the
   revision each was read at.
3. **Hit protocol**: recursive. Validate children by re-reading their
   revisions (row reads the walk needs anyway to serve snapshots) and
   consulting their entries; replay manifests through the current walk's
   coverage checks and miss recorder, resolving scopes under the current
   identity. A changed document invalidates, through revision mismatch,
   exactly the ancestor chain from it to the root; the rest of the graph
   serves from entries.
4. **Scoped reach**: an entry whose own subtree crosses a user- or
   session-scoped link, or records a scoped miss, is keyed with an
   identity suffix and serves only its identity. Taint climbs only the
   ancestor chain of the scoped link, so the cross-identity recompute is
   bounded to those chains (the board corpus has four, shallow). This
   layer performs no absence probes; cross-identity serving of
   scoped-absent reach stays the evaluation cache's job.
5. **Storage**: per-engine, beside `documentCache`; LRU with an entry and
   weight budget on the evaluation cache's pattern. No rotation — revision
   keys strand superseded entries and LRU retires them.
6. **Recipient-blindness**: sharing narrowing across identities rests on
   the same invariant the evaluation cache documents — evaluation is
   recipient-blind, and a per-recipient filter inside evaluation (CFC
   label enforcement, say) must key or bypass this memo too
   (`key-vocabulary.md` §5).

## Composition

The memo sits **under** the evaluation cache; the two answer different
questions. The evaluation cache answers "may I hand this identity the
whole result computed for another ask" — one clone serves a reconnect
stampede of N clients at ~2.5 ms each, with scope purity and
absent-residue rules deciding who may share. The memo answers "how much of
this walk changed since something last walked it" — it survives commits to
unrelated documents, serves across query shapes, and reaches the refresh
paths. A realistic memo hit on the board corpus is the ~17 ms floor plus
producing 6,112 entity snapshots (~200–300 ms today); a **per-revision
snapshot cache** — the serving-layer sibling of `documentCache`, staged
below — brings that to tens of milliseconds. Whether the evaluation cache
still earns its keep once this layer is warm is a question the evaluation
cache's per-class diagnostics counters answer with production numbers, not
one this plan pre-judges.

## Measured baseline (2026-08-28)

Board clone, `trackGraph` level, five iterations, medians:

| Arm | Meaning | Median |
| --- | --- | --- |
| A | Cold evaluation, fresh engine | ~1.4 s |
| B | Re-evaluation, decoded forms cached, fresh memo | ~1.4 s |
| C | Fully warm injected memo (floor; under-registers) | ~17 ms |
| D | Evaluation-cache hit | ~2.5 ms |
| E | Re-registering all 8,524 reach pairs (replay cost) | ~2 ms |

A realistic memo hit lands between C+E and B: ~250 ms dominated by
snapshot production, or tens of milliseconds with the snapshot-cache
stage.

## Stages

- [ ] **Stage 1 — memo store and capture.** Per-engine store, key,
  manifest capture during traversal, behind an experimental flag
  (registered in `docs/development/EXPERIMENTAL_OPTIONS.md`); no serving
  yet. Pins: capture is effect-complete (manifest replays to the same
  tracker and miss state a fresh walk produces).
- [ ] **Stage 2 — hit protocol.** Recursive validation and replay; scoped
  taint keying; wired into the server walk. Pins: delivery liveness
  through a memo-served walk; a child revision change re-computes exactly
  the ancestor chain; scoped-tainted entries never cross identities;
  full-suite parity between flag-on and flag-off evaluation results.
- [ ] **Stage 3 — per-revision snapshot cache.** Entity snapshots keyed
  by document revision, so memo-served evaluations stop re-assembling
  unchanged documents.
- [ ] **Stage 4 — default-on and measurement.** Estuary A/B with the
  evaluation cache's diagnostics; revisit evaluation-cache retention with
  those numbers.

## Non-goals

- **Scope-frontier stitching** (a shared walk prefix with per-identity
  scoped subtrees stitched at serve time): a later phase that would build
  on this layer's entries; tracked in the Discord design thread, not
  here.
- **Write-time link extraction** (persisting each document's outgoing
  links with their paths at commit time): the storage-side attack on the
  same cost, strongest for wide-open (`schema: true`) selectors, and the
  path to reverse-link lookups. Separate justification, separate plan.

## Open questions

- Manifest shape: is scope-unresolved (scope + id) the right stored form
  for links and misses, or should entries store both forms? (Owner
  review.)
- Whether the narrowed result stored per entry is required for parent
  composition in all traverser paths, or only under `anyOf` selection —
  answered during Stage 1 by the capture implementation.
- Budget defaults for the per-engine store (the evaluation cache ships
  32,768 weight; this store holds smaller entries at far higher count).
