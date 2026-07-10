---
status: historical
created: 2026-06-09
archived: 2026-07-08
reason: "Working log of the traverse optimization rounds."
---

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

### Iteration 1 — kill hashing on the hot path

Two competing candidates, both with byte-identical oracles AND byte-identical
traversal counters (purely representational changes), full runner suite green.

**Candidate A (canonicalize at the seams)** — ~8×: notebook 9175→1142ms,
shopping-list 18→7ms, legacy 3→2ms. Single file (traverse.ts +300/−28). Memos:
narrowAndCombineSelectorForLink (content+identity-token keys),
schemaAtPathCanonical (gated on isInternedSchema input), combinatorRestSchema,
resolveSchemaRefsCanonical, module-level coverage cache + true-schema index +
non-copying MapSet.values().

**Candidate B (identity-keyed caches)** — 7.8×: notebook 9585→1232ms. 3 files
(traverse.ts, cfc.ts, cfc/schema-refs.ts): memoized the producers directly
(cfc.schemaAtPath module-level WeakMap memo, resolveCfcSchemaRefs memo),
identity-first traverseWithSchema memo with internSchema canonicalize-on-miss,
WeakMap pair caches, splitSchemaLogic memo, MapSet.valuesFor(). Hash self-time
62.5% → 8.2% (46× absolute).

**Convergent findings (both independently):**

1. The four profiled hash sites were symptoms; the deepest root was **producers
   minting fresh schema objects per call** — above all `$ref` resolution (13,384
   $refs in the notebook fixture de-canonicalized entire subtrees per visit),
   plus cfc.schemaAtPath's `{...cursor}` returns and the `{anyOf, ...rest}`
   destructure (337k anyOf branches).
2. **Per-instance caches are a trap**: contexts/traversers/cfc instances are
   created per invocation (12,820 per notebook replay), so per-instance memos
   stay permanently cold (the old coverageSelectorCache had this flaw).
   Module-level WeakMap-rooted memos are the working shape.
3. **WeakMap keyed on the incoming selector is nearly useless** at the
   followPointer seam — the hot caller mints a fresh selector per pointer, so
   identity never repeats. Content+identity-token keys (A) or
   canonicalize-on-miss via internSchema (B) are the fixes.

Risk difference: B's traverseWithSchema memo deep-freezes (interns) every schema
entering the query path including doc-embedded ones; A gates memos on
already-interned inputs (no freezing expansion).

**Adversarial verdicts** (independent reviewer agents, instructed to refute):

- A: SAFE TO LAND — all 8 attack vectors refuted (incl. a 600-trial differential
  fuzz of the true-schema index against the old scan). Three non-blocking
  hardenings recommended.
- B: SAFE TO LAND — 6/7 refuted; 1 confirmed-but-unreachable issue (NUL-join key
  collision, PoC'd, needs a literal `\0` in a document key).

**Winner: A** (equivalent speed, single file, no freezing expansion, cleaner
verdict). Landed with all recommended hardenings applied: link-hop memo gated on
`isMemoizableSchemaInput` (immutable identities only), injective length-prefixed
`pathKey()` encoding replacing `"\0"` joins in the new memo keys, frozen marker
constants.

**Post-hardening verification**: notebook 1069ms median (**8.5×** vs 9.0s
baseline), shopping-list 7ms, legacy 2ms; counters byte-identical (schemaCalls
278,072 / memoHits 13,280 unchanged); replay oracle green without golden
regeneration; full runner suite 550 passed; memory package 165 passed.

**Goal status: exceeded (target was 2×; achieved 8.5×).**

Rebase note: after PR #3939 merged and main picked up the value-hash codec
refactor (#3941), the fresh-main baseline measured 10.1s median (hashing got
slightly more expensive), and this change measured 1.21s on top of it — **8.4×
on current main**, oracle still green against unchanged goldens.

### Iteration 2 — server side (toolshed)

Setup: local toolshed (memory v2 server) on offset ports with
`CF_TRAVERSE_CAPTURE` + `--inspect`; load = runner integration tests plus 7-8
rounds of `patterns/integration/reload/default-app-notebook`; sampling via the
new `profile-attach.ts`. New checked-in fixture: `toolshed-reload` (20k server
traversals, 1,922 docs, 1,036 selectors).

**Finding 1 — toolshed is not CPU-bound: 92.6% idle under an aggressive reload
loop.** Of the ~7% busy CPU: deep-freeze registration at `decodeMemoryBoundary`
~19% (every node of every wire message is registered in the frozen cache),
hashing ~13%, wire codec (JsonEncodingContext parse/encode) ~12%, GC ~8%,
traverse proper ~7%, subscription state cloning ~2%. Server-side optimization
buys latency tails/headroom, not throughput.

**Finding 2 — replay-fidelity bug fixed:** live storage deep-freezes every doc
at the wire-decode boundary, but the replay corpus served mutable parsed JSON,
so frozen-identity fast paths could never engage in replay.
`FixtureObjectManager` now deep-freezes corpus values; this alone cut
toolshed-reload replay 652→217ms and goldens are unchanged (freezing is
value-neutral).

**Finding 3 — interned-only memo gates bypassed every seam memo on the server**
(wire-decoded doc schemas are frozen but never interned). Relaxed
`isMemoizableSchemaInput` and the three sibling gates to accept deep-frozen
inputs (frozen ⇒ identity cannot go stale; same safety argument). Correct and
now engaged server-side, but…

**Finding 4 — negative result (recorded so it isn't retried): the gate
relaxation yields ~0% live improvement.** A/B attach-profiles (280s/8 rounds vs
240s/7 rounds, per-second normalized) show identical deep-freeze/hash/codec
rates. True-caller attribution of the residual server hash time: trackVisitedDoc
17%, combineSchema pair keys 11%, codec encode 10%, toDocumentSelector 3%. The
reload workload actively CREATES docs, so most remaining hashes are first-touch
hashes of genuinely novel selectors/schemas — caches can only amortize repeats,
not cold misses.

**Post-merge review simplification (#3948 feedback):** `schemaToken()` was
redundant — an interned (or frozen, after first touch) schema's structural hash
is already WeakMap-cached by value-hash, so `hashSchema()` is an O(1) memo-key
part with no separate token bookkeeping (and structural keys let
distinct-but-equal frozen schemas share memo entries, which tokens could not).
A/B: ~1.6–2.3% slower on the replay medians — in the noise, as predicted by the
reviewer; main's #3956 (frozen-cache-first hash lookup) narrows it further.
Lesson recorded: before inventing identity machinery, check whether the existing
content-hash cache already provides it.

**Stop-rule triggered** (<3% twice: gate relaxation ~0%, and no cheaper
candidate identified within traverse scope). Documented next targets if anyone
wants the remaining ~7%-of-busy: deep-freeze registration cost at
`decodeMemoryBoundary` (register-roots-only / cheaper cache — data-model blast
radius), codec encode hashing, `cloneTrackedGraphState`.

### Iteration 3 — tail latency

Motivation: traverse no longer dominates mean time but shows up in tails. New
instrumentation: `replayFixture(..., { collectLatency: true })` produces
per-invocation p50/p90/p99/p99.9/max plus the slowest invocations with their
counters; the bench prints it under `BENCH_DIAGNOSTICS=1`.

**Tail diagnosis:** p50 ≈ 5µs but p99 was 5ms+ and max 25ms — a 1000× tail,
identical shape on client and server fixtures: anyOf-heavy vnode docs evaluating
up to 8,424 branches per traversal. The worst case was the same doc × selector
paying 25ms twice (client invocations cannot amortize across calls).

**Fixes (oracle byte-identical, counters preserved exactly):**

1. `prepareAnyOf` — branch sort (two hasAsCell passes per node!), rest+option
   merges, and `canBranchMatch`'s static derivations ($ref resolution, type
   normalization, required-applicability) precomputed once per schema identity;
   the per-node prefilter is now a few field reads.
2. Per-visit `docVisits`/`uniquePaths` diagnostics in `traverseWithSchema` built
   a string per visit but only feed the slow-traverse log — now gated behind
   `CF_TRAVERSE_DIAGNOSTICS=1`.
3. ~~`createDataCellURI` memoization~~ — **reverted after CI caught a real
   regression** (folksonomy-aggregator +26%, reproduced locally 1180→1490ms).
   The memo (keyed on frozen value identity + base address/schema) wins on
   replay fixtures where values repeat across invocations, but live dynamic
   patterns mint FRESH deep-frozen values per evaluation: the memo never hits,
   so `isDeepFrozen` subtree walks + key hashing are pure added cost. Negative
   result recorded: identity memos need identity REUSE, not just identity
   stability — fresh-per-evaluation frozen objects have neither. (The CI perf
   check's subtest-level timing was RIGHT after two earlier shard-level flags
   were noise; always A/B the named test locally.) The real fix is upstream: the
   code's own TODO says query traversal should not route through data-URI
   synthesis at all.

**Results (final, fixes 1+2 only):** notebook max 25.2→18.6ms (−26%), p99
5.17→3.70ms (−28%), mean −18%; toolshed-reload max 7.9→6.3ms, p99.9 3.3→2.7ms;
shopping-list unchanged (no anyOf tail); folksonomy (dynamic-schema live
pattern) at main parity. The prepared-anyOf path is additionally gated on
`isInternedSchema(resolved)` — interned identity guarantees reuse;
frozen-but-fresh schemas take the legacy loop verbatim.

**Post-fix profile of the worst invocation is flat**: top item is
`traverseWithSchema` per-call overhead (~0.7µs × 6.3k calls, largely V8 inline
attribution), then the pointer-hop/coverage cluster (narrowAndCombine 4.5%,
include 4.1%, pathStartsWith 3.7%, internPathSelector 2.3%) — a multi-site ~13%
if ever needed. Stopped here per diminishing returns.

### Remaining known hotspots (client side, from iteration 1)

From the post-A profile (flat, ~1.4s total) and the server-fixture profile:

- `addressKey` string churn in dagMemo (8.1% on the DAG-heavy server fixture) +
  traverseDAG per-step address spreads.
- anyOf discriminator index (337k branch evaluations still run canBranchMatch
  per node; precompile per interned schema).
- Diminishing returns expected (<15% each on the notebook metric); next
  iteration only if the loop's <3%-twice stop rule isn't triggered.
