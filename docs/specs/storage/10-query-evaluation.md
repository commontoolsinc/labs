# Query Evaluation Algorithm

## Single Run Evaluation

Function `evaluate(IR, docId, path, linkBudget, refDepth = 0)`:

1. **Check memo** by `EvalKey`; if present, return cached `EvalResult`
2. **Read current JSON value** at `(docId, path)` where `path` is an array of
   strings:
   - Record a `DocLink` touch for the exact link and any constraints that read
     sublinks
3. **Apply local constraints** (`TypeCheck`, `Const`, etc.). Early exit to `No`
   if they fail
4. **For Props on objects**:
   - **Required**: if missing → `No` (touch the missing property link)
   - For each known property in `props`, recursively evaluate child IR at
     subpath; collect deps, touches
   - **AP omitted/false**: do not enumerate or read other properties → no
     dependency on them
   - **AP true**: enumerate other properties; for each, either accept (if AP is
     `true`) or recurse into AP schema
5. **For Items on arrays**: enumerate items as needed (touches for indices read)
6. **For AnyOf / AllOf**:
   - Evaluate branches **in parallel** conceptually, but with memoization it's
     just multiple recursive calls
   - `allOf`: conjoin verdicts; `anyOf`: disjoin verdicts
   - A single `Yes` in `anyOf` can short-circuit further branches at runtime,
     but we still keep the provenance for any branches we _actually started_
7. **Link follow**:
   - If the current value is a link **and** (a) schema is `true`, or (b) we're
     in a context where we are exploring values:
     - If link points to a different space: assume it matches and continue
       (don't follow)
     - If `linkBudget == 0`: return `MaybeExceededDepth` OR treat as leaf
       (configurable)
     - Else, resolve target `(docId, path)`:
       - If `id` is omitted, use current `docId`
       - If `space` is omitted, use current space
       - Then `evaluate(IR, targetId, targetPath, linkBudget-1)` and union its
         touches/deps into the current node
   - If **not** a link, continue locally
8. **Handle $ref nodes**:
   - If current IR node is `Ref(name)`:
     - Check if `refDepth > MAX_REF_DEPTH` (e.g., 100) to prevent infinite
       recursion
     - If exceeded, return `MaybeExceededDepth`
     - Else, resolve the definition IR node and recursively evaluate with
       `refDepth + 1`
9. **Construct and store** `EvalResult` (verdict, touches, linkEdges, deps) in
   memo; also construct provenance edges

**Important**: because we watch only properties/array slots actually required by
IR and AP, the **touch set is minimal**.

## Invalidation & Incremental Maintenance

### On Document Change

Given a change event `Δ = { changedLinks, addedLinks, removedLinks }` for
`docId`:

1. **Find impacted EvalNodes**
   - For each changed `DocLink l`, get
     `impactedEvalNodes = ReverseIndex_DocLinkToEvalNodes[l]`
   - Mark them **dirty**

2. **Topologically re-evaluate** the dirty slice
   - Do a reverse BFS up the provenance graph: mark parents of dirty nodes dirty
     too
   - Process dirty nodes in topological order (children first)
   - For each dirty `EvalKey`, re-run `evaluate` (it will re-use unaffected memo
     entries below it)
   - For each re-evaluated node, compute **delta** of:
     - `verdict` (Yes/No/Maybe)
     - `touches` (add/remove DocLinks)
     - `linkEdges`
   - Update reverse indexes accordingly

3. **Find affected queries**
   - Any query that references a re-evaluated `EvalNode` or whose
     `QueryTouchSet` intersected `changedLinks` is **candidate**
   - For each candidate query, recompute just enough of its **root verdict** and
     **QueryTouchSet**:
     - If nothing changed → no notification
     - If either the **root verdict** changed or the **Touch Set** changed,
       **notify**

4. **Link topology changes**
   - If a link was added/removed:
     - Update `incomingLinks`
     - Any `EvalNode` whose prior touches included the source link may now have
       new/deleted dependencies
     - Those nodes are marked dirty and step (2) handles the propagation

### On New Subscription

1. Compile (or look up) IR for the schema
2. Create `RootEvalKey`; run `evaluate` once
3. Compute `QueryTouchSet` as union of touches from `RootEvalKey`'s reachable
   slice (follow `deps`)
4. Register reverse indexes:
   - For every touched `DocLink`, add `(queryId)`
   - For every involved `EvalNode`, add `(queryId)`

### On Unsubscribe

1. Remove `(queryId)` from reverse indexes
2. Optionally GC: decrement **refcounts** of `EvalNodes` and prune
   memo/provenance subgraphs with zero refcount

## Overlapping Queries: Sharing & Dedup

- **IR hash-consing** gives identical schemas identical `IRNodeId`s
- `EvalKey` includes `IRNodeId`, so evaluating the same `(doc, path)` under the
  same schema is shared across all queries
- Reverse indexes attach **multiple queryIds** to the same `EvalNode` and
  `DocLink` dependencies
- For different schemas that still overlap structurally, you still benefit from
  sub-IR sharing

## Practical Heuristics

- **Branch ordering for anyOf**: evaluate cheaper / more selective branches
  first. Keep **profiling counters** per IR node
- **Touch set compression**: store DocLinks as trie-keys (docId + path segments)
  to dedupe ranges
- **Depth budget strategy**: If you frequently hit `MaybeExceededDepth`,
  consider:
  - A per-query **work queue** that explores one more link layer in idle time
  - Opportunistic deepening when related docs change

## Edge Cases & Correctness

- **Cycles**: handled by `(docId, path, IRNodeId, linkBudget, refDepth)` memo
  key. If re-entered with same or higher `linkBudget` and `refDepth`, return
  cached result immediately
- **"False but touch root"**: register a touch on `(docId, path)` even when
  schema is `False`
- **Missing properties**: touching a missing property means watching its
  **existence bit**
- **Arrays**: watch item indices you read; for AP-like "all items matter", you
  can represent **"all items under current array"** as a wildcard watch and
  expand lazily on change

## Complexity Notes

- Let `C` be number of changed links in a commit, `E` number of EvalNodes they
  feed into (via reverse index)
- Re-evaluation is **O(E + affected subgraph)**; with shared IR/memo and tight
  AP semantics, this is typically much smaller than "re-run all queries"
- Memory is largely in the **memo + provenance graph**; GC via refcounts and LRU
  for cold `EvalNodes`
