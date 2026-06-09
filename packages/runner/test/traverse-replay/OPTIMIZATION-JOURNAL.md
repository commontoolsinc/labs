# Traverse optimization journal

Working log for the traverse optimization loop. Every attempt gets an entry —
including rejected ones — so tactics aren't re-tried blind. Measurement machine:
Apple M3 Max, Deno 2.8.1.

## Goal

**≥2× reduction in full notebook-test replay wall time** (baseline ~9.0s median
→ target ≤4.5s), with:

- byte-identical oracles on all fixtures (`deno task test` replay test green
  without golden regeneration),
- no fixture regressing,
- counter movement explaining every wall-time claim.

## Baseline (2026-06-09, Phase 0 HEAD)

| fixture            | full replay | schemaCalls | anyOf   | memoHits |
| ------------------ | ----------- | ----------- | ------- | -------- |
| notebook-test      | ~9.0s       | 278,072     | 337,441 | 13,280   |
| shopping-list-test | ~14ms       | 2,223       | 80      | 87       |
| piece-query-legacy | ~3ms        | 63          | 0       | 22       |

## Profile (notebook-test ×2, sampling 100µs)

**~70% of CPU is structural hashing** (`op_node_hash_update` 44.5%, value-hash
feed* ~13%, hash.ts ~5.6%, LRU lookups 5.8%). Traversal logic itself ~11%.
Attribution of hash-machinery time to call sites:

| share | site                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------ |
| 42.8% | MapSet selector hashing (`(v) => hashStringOf(v)`, traverse.ts:309) via `trackVisitedDoc` per pointer follow |
| 25.8% | `hashSchema(schema)` in the `traverseWithSchema` memo key                                                    |
| 18.5% | `internSchemaPairAsKey` keys for `combineSchema`/`mergeSchemaFlags`/`mergeSchemaOption` caches               |
| 8.4%  | `internSchemaReturningSchemaAndHash` interning freshly minted merged schemas                                 |

Root cause: `value-hash`'s `frozenObjectHashCache` (WeakMap) only engages for
deep-frozen objects, and the hot path mints **fresh** selector/schema objects
per pointer follow (`narrowSchema` returns a new `{path, schema}`, then
`combineOptionalSchema` mints a new schema). Identity never repeats, so every
fresh object pays one full SHA tree-walk; with ~64k pointer follows per replay
round this dominates everything.

Tooling: `profile-driver.ts` / `profile-target.ts` in this directory (CDP
sampling profiler + self-time/attribution reports, no external tools).

## Iterations

### Iteration 1 — kill hashing on the hot path (in progress)

Tactic A: canonicalize at the seams — identity caches so repeated (selector ×
path × link-schema) combos return the same interned object; downstream hashing
then hits the frozen-WeakMap automatically.

Tactic B: identity-keyed cache structures — replace the four hash-built string
keys with nested identity-keyed maps (WeakMap layers); hash only at cache-miss
boundaries, accepting possible memo-hit-rate changes.
