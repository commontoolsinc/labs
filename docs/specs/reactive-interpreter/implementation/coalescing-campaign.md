# Coalescing campaign — drive real engagement to green

GOAL (Berni, 2026-06-24, AFK autonomous): the integration suite GREEN **with the
interpreter actually engaged on most patterns** (coalescing = interpret pure
regions, keep handlers/collections/effects as boundary nodes). Fallback only for
genuinely rare array-ish ops — nothing core (handlers, maps, computeds, lifts,
ifElse/when, derived) must fall back. Measure REAL engagement (`interpreted_ok` on
the realistic integration suite), never green-via-fallback (see
[[proxy-metric-decoupling]]).

## Measurement
`cd packages/generated-patterns && CF_EXPERIMENTAL_INTERPRETER=1 RI_CENSUS_DUMP=1 LOG_LEVEL=error deno test -A --parallel ./integration/patterns/*.test.ts`
then aggregate per-scenario `interpreted_ok>0` and `fallback_by_reason`.
Hard invariant every increment: flag-off `packages/runner` `deno task test` is GREEN
(0 failed). The pass COUNT moved up over the campaign as suites were added: 658/0
through INC1, then **695/0** from INC2 onward once `test/reactive-interpreter/*.test.ts`
was discovered by the runner task + CI shards (see INC2 CI-discovery fix).

## Baseline (after spike 357f25d06, harness trust = untrusted)
- engaged: 5 / 144. fallbacks: unresolved_leaf 123 (trust gate ~26 + structural scan ~85 + schema-context), unrecognized_alias 26, launched_child 14, ineligible_opkind 10.
- DIAGNOSIS: trust gate is a HARNESS ARTIFACT — disabling it → engaged 31/144. Production patterns carry verified identities → trusted → engage. Structural leaf scan is the next throttle. Collections excluded by the spike (effect-only gate) = the dominant real-world construct + biggest footprint win.

## Increments (update each pass)
- INC1 (DONE — FINAL GATE 2026-06-25): trust-faithful harness + structural-scan precision + partition dispatch (one interpreter node per pure SEGMENT, handler/effect boundaries kept, collections excluded) → most patterns now interpret their pure regions. **Engagement 5/144 → 106/147** (`interpreted_ok>0`; 146 distinct scenario labels, `counterAggregator` appears in two files). Final gate, all measured on this branch:
  - `deno check` + `deno lint` (`runner.ts`, `reactive-interpreter/*.ts`): clean. `deno fmt`: no diff.
  - integration under flag (`CF_EXPERIMENTAL_INTERPRETER=1`, `generated-patterns/integration/patterns/*.test.ts`): **147 passed / 0 failed** — green WITH the interpreter engaged, not green-via-fallback.
  - flag-off `packages/runner` `deno task test`: **658 / 0** (HARD invariant held).
  - flag-ON `packages/runner` `deno task test`: **657 / 1**. The single red is `test/patterns-lift.test.ts` → "Pattern Runner - Lift … should handle patterns returned by lifted functions" — a unit test pinning the old single-node behavior for a lift that RETURNS a pattern (launched_child territory); expected campaign migration, NOT a regression and NOT a blocker.
  - fallback_by_reason across the 147 census scenarios (sum of counts / #scenarios touched): `unrecognized_alias` 26 in 22, `unresolved_leaf` 17 in 13, `ineligible_opkind` 16 in 11, `launched_child` 14 in 5; `eval_threw`/`scoped`/`cross_space`/`argument_writeback` all 0. 41 scenarios not engaged, 45 with ≥1 fallback.
  - Fixed in INC1 (see INC1b sub-bullets for the partition-correctness detail): trust-faithful integration harness (production-like verified leaves; the untrusted-harness trust gate was a measurement artifact, baseline 5→31 trust-off), structural leaf-scan precision (resolve pure leaves, still fall back on pattern/async/`Cell.for`), and the three partition/emission bugs (topoOrder internal-alias deps, producer-less internal-cell seeding, `$generated` partialCause aliasing).
  - Gated/deferred (NOT regressed — left as boundary nodes so they fall back cleanly, engagement stays monotonic): collections (the spike's effect-only gate excludes them) and lift-returns-pattern / launched-child cases. Nothing core (handlers, maps-as-boundary, computeds, lifts, ifElse/when, derived) falls back.
  - DOMINANT remaining throttle = **collections excluded** (`ineligible_opkind` 16 + the `unrecognized_alias`/`launched_child` clusters that hang off collection rows) → this is exactly INC2. After collections, the residual is `unrecognized_alias` (cross-segment named reads) → INC3.
- INC1b (DONE — partition correctness pass): the prior passes engaged the interpreter on most handler-bearing patterns, turning the suite red WITH partitions (66/147 failing). Drove back to GREEN by fixing partition/emission bugs, NOT by widening fallback. Result: **integration 147/0 under the flag, engagement 105/144** (vs 5/144 baseline, 31/144 trust-gate-off), flag-off runner 658/0. Bugs fixed:
  1. **topoOrder ignored `internal`-alias deps** (`interpret.ts`). The ROG topo sort only followed `opOut` refs; two leaves both reading the same upstream op via a NAMED internal alias (e.g. `str` interpolating `${branchKind}` and `${branchVariant}`, each a computed materialized under an internal cell) were ordered by declared appearance only. A consumer placed before its sibling producer resolved the producer to `undefined` (`counter-conditional-ifelse`: `disabled (undefined)`). Fix: thread `internalToOp` into `topoOrder`, resolve `internal`→producer when that producer is in the op set (seeded externals stay out of the order). Recovered 26 scenarios (66→40 failing).
  2. **producer-less internal cells were never seeded** (`interpret.ts` + `runner.ts`). A segment reading a `cell(…)` written ONLY by a handler boundary (handler writes via `$ctx`, EMPTY `outputs`, so the F4 output-name gate never sees it) or a bare `derivedInternalCells` default got `undefined` — and a downstream lift reading `undefined` is run-gated out, yielding `undefined` not the lift's default (`counterNoOpEvents.updateCount`: undefined vs 0). Fix: `EvalContext.seedByName` (op-id seed can't key a producer-less cell) + dispatch wires each such cell as a `$in[name]` alias carrying its schema (so an untouched `cell(0)` surfaces its default) seeded by name. Recovered ~27 scenarios (40→20 failing), but introduced a follow-on bug (#3).
  3. **`$generated` partialCause aliased by the normalized string key** (`runner.ts`). `outputInternalName` normalizes a `{$generated:N}` partialCause to the string `"$generated:N"` (used as the ROG `internal` name / map key). The fix-#2 alias used that string as the alias `partialCause`, which the binding layer rejects with `Unknown derived internal cell with partial cause "$generated:0"` (`nested-counters`, `list-manager`, `counter-dynamic-step`, …). Fix: keep the ORIGINAL `partialCause` payload (string OR `{$generated:N}` object) in `internalCellAliasByName` and alias by that, never the normalized key. Drove the suite to 147/0.
- No shapes had to be gated/retreated — every failure was a real partition-wiring bug with an in-scope fix. The three fixes only ADD correct seeding/ordering; they never return null/bumpAndThrow, so engagement is monotonic (cannot fall vs the start of the phase).
- INC1c (DONE — unrecognized_alias cluster, commit c0a09f2e0): the 26-bump `unrecognized_alias` cluster (22 scenarios) was pure (non-collection) patterns reaching the partition path but falling back because alias extraction only recognized two `partialCause` forms (a `string` + `{$generated:N}`). The builder also emits general JSON causes (the `[label, counterId]` tuple, stream causes), so a cross-segment NAMED read never resolved → whole pattern fell back. Fix: shared `partialCauseToInternalName` normalization used in BOTH `aliasToValueRef` and `outputInternalName` so a result/input internal ref lines up with its producing node's output cell; exclude the transformer's `["__patternResult", <field>]` result-cell marker. **Engagement 105/144 → 117/146**, integration 147/0, flag-off 658/0.
- INC1d (DONE — launched_child + context-leaf TRIAGE, this pass): the goal was to classify the `launched_child` (14) and `unresolved_leaf` (29) clusters as CORE (must-interpret) vs genuine rare/exotic EXCEPTIONS, engage the core, and justify the exceptions. Census attribution (per-cluster, source-read, gate-instrumented):
  - **launched_child (14 bumps, 5 scenarios) = ACCEPTABLE EXCEPTION (the launcher contract), but the PARENT'S pure region is CORE and now engages.** Every `launched_child` bump fires at one of 4 launcher seams (`startAfterSuccessfulCommit` 1826, receipt 4323, deferred-handler-result 4417, `writeJavaScriptActionResult` 4549 — confirmed by seam-tagged instrumentation: replicator/dynamic-handler-list/nested-parameterized/nested-computed via 4549, handler-spawn via 4323). The CHILD pattern's result cell is consumed by a launcher (receipt / navigateTo deref / firstResolvedOutput Redirect) the collapsed `$ri-result` alias does not honor → KEEP as a sound legacy boundary (documented). This is genuine dynamic child instantiation (`lift` returns `entries.map(() => childPattern(...))`, or a handler's `this.run`). **What WAS core: the launched-child-via-lift LIFT is reported as an UNRESOLVED leaf (`liveLeafCanInstantiatePattern`), which previously fell the WHOLE PARENT back.** Now it is kept as an `unresolved-leaf` BOUNDARY (the original legacy node, verbatim — it launches its children exactly as today) while the parent's pure region interprets. Result: `counterNestedParameterized` / `counterReplicator` / `counterWithDynamicHandlerList` / `counterWithNestedComputedTotals` PARENTS now engage (`parent_iok≥1`) AND still launch children (launched_child unchanged at 14).
  - **unresolved_leaf (was 29) — three sub-kinds (instrumented `RI_UL_REASON`): `schema-needs-cell-context` 27 (asCell/asStream lift INPUT — calls `.get()`/`.sample()` on a live handle), `untrusted-live-fn` 13 (ONLY in the 3 nested-pattern scenarios = the launched-CHILD's internal leaf re-resolution, a symptom of the launched-child contract, not a separate gap), `can-instantiate-pattern` 3 (pattern-returning lifts). The asCell/asStream and Cell.for leaves are GENUINELY context-requiring (a leaf needing a live cell handle is not pure compute) = the documented EXCEPTION — verified precise (`schemaNeedsCellContext` is asCell/asStream-only, skips `default`; not a precision miss). But the PURE REGION AROUND such a leaf is CORE.** The lever: the partition machinery ALREADY classifies an unresolved leaf as a BOUNDARY (`boundaryKindOf` → `"unresolved-leaf"`); the runner just fell the whole pattern back at the `unresolvedLeafOps.length>0` gate BEFORE attempting the partition. Now the runner passes the real `unresolvedLeafOps` to the partition and allows `unresolved-leaf` boundaries (alongside `effect`). **Engagement 117 → 131 (+14 scenarios)**; `unresolved_leaf` 29 → 12.
  - Soundness fixes the engagement required (correctness-first, all fail-CLOSED): (1) the **F4 write-back-cycle gate** now applies ONLY to `effect` boundaries — a handler's output is a side-effect write (reading it back IS a cycle), but an unresolved-leaf boundary's output is a NORMAL dataflow output (a downstream `bnd→seg` read is sound, e.g. a `detail` str reading a context `summary` lift's `.trend`); (2) **`asCell`/`asStream` ARGUMENT with an unresolved-leaf boundary** falls back — the segment's deep-resolved `$arg` surfaces such a field as a HANDLE object (truthy), so an `ifElse(enabledCell, …)` control predicate mis-evaluates (`counterWithConditionalBranch`: enabled-arg → always "Enabled"); gated to the unresolved-leaf path so the effect-only engagement is unchanged (monotonic); (3) **cross-segment `opOut` materialization** — an unresolved-leaf boundary pushes its downstream pure ops into a later layer, splitting them from upstream pure (synthetic) constructs that feed them by a nameless `opOut` ref; each such cross-segment op gets a synthetic `$ri-op-<id>` derived internal cell (producer segment writes it by op id, consumer seeds it; appended to the manifest, NO result-tree projection so the output is identical to legacy). This (3) is what took the engagement from +3 to +14 (the `derived-*`/`research-citation`/`incident-response` context-leaf scenarios). The synthetic descriptor shape is `{partialCause}` (matching `pattern.derivedInternalCells`), NOT `{$alias}` (the binding-layer `getDerivedInternalCell` keys on `partialCause`).
  - Remaining `unresolved_leaf` 12 (`iok=0`) — all GENUINE exceptions, attributed by gate: `counterWithConditionalBranch` (asCell-ARG `ifElse(enabledCell,…)`); `counterWithAlternateInitialStates` / `budgetPlanner` / `counterWithTypedHandlerRecord` / `supportTicketTriagePattern` (fan-out and/or bnd→bnd — the EXISTING spike deferrals that apply to effect-only patterns too, INC3 scope); `cell-unknown-capture` (a `Cell<unknown>` capture diagnostic — the single pure seg only FEEDS the context leaf, nothing reads its output → no segment to materialize); `counterWithHandlerSpawn` (launched_child). NONE is a core gap.
  - GATES (this branch): integration under flag **147/0** (engaged 131/146, never green-via-fallback); flag-off `packages/runner` **658/0** (HARD invariant); flag-ON `packages/runner` **657/1** (the SAME pre-existing `patterns-lift.test.ts` "patterns returned by lifted functions" red — verified by `git stash` it is red at the INC1c baseline too; expected campaign migration, NOT a regression); reactive-interpreter unit tests **37/0**; `deno check`/`lint`/`fmt` clean on `runner.ts`/`extract.ts`/`partition.ts`. Every new path is additive + fail-closed, so engagement is monotonic and flag-off is untouched.
- INC2 (DONE — FINAL GATE 2026-06-25): the non-collection engagement campaign. Two engagement passes (`unrecognized_alias` cross-segment named reads, commit c0a09f2e0 — recorded above as INC1c; `launched_child` + context-leaf triage, commit 610dd6f01 — recorded above as INC1d) plus a CI-discovery fix (commit 30a57d251), all gated and measured together on this branch:
  - **Engagement 105/144 → 132/147** (`interpreted_ok>0`, measured on the realistic integration suite, NOT green-via-fallback). 132 engaged / 147 scenarios; of the engaged, 124 are fully clean (zero fallback events) and 8 engage their pure region while a boundary node falls back cleanly. 15 not engaged — all `ineligible_opkind` (collections, INC3) or genuine `unresolved_leaf` exceptions, NONE a core gap.
  - fallback_by_reason (summed across the 147 census scenarios): `ineligible_opkind` 18 (collections — DEFERRED to INC3), `launched_child` 14 (the launcher contract — DOCUMENTED acceptable exception, see INC1d), `unresolved_leaf` 12 (asCell/asStream context leaves + asCell-arg control predicate + fan-out/bnd→bnd spike deferrals — DOCUMENTED acceptable exceptions, see INC1d). `unrecognized_alias` **26 → 0** (fully engaged this increment), and `eval_threw`/`scoped`/`cross_space`/`argument_writeback` all 0.
  - What was ENGAGED (core, now interpreting): (1) the entire `unrecognized_alias` cluster — pure non-collection patterns whose cross-segment NAMED reads (general JSON `partialCause` forms beyond `string`/`{$generated:N}` — the `[label,counterId]` tuple, stream causes) previously failed alias resolution and fell the WHOLE pattern back; now resolved via shared `partialCauseToInternalName` normalization. (2) the PURE REGION of every `launched_child` parent — the launched-child-via-lift LIFT is now kept as an `unresolved-leaf` BOUNDARY (verbatim legacy node, still launches its children) while the parent's pure region interprets, so `counterNestedParameterized`/`counterReplicator`/`counterWithDynamicHandlerList`/`counterWithNestedComputedTotals` parents engage. (3) the pure region AROUND every context-requiring leaf — the runner now passes real `unresolvedLeafOps` to the partition and allows `unresolved-leaf` boundaries (alongside `effect`), with cross-segment `opOut` materialization, fail-closed asCell-arg gating, and effect-only F4 write-back gating.
  - DOCUMENTED acceptable exceptions (boundary nodes that fall back cleanly, NOT core gaps): **context-leaf** (`asCell`/`asStream` lift INPUT / `Cell.for` — a leaf that needs a live cell handle to call `.get()`/`.sample()` is not pure compute; verified precise, the pure region around it still interprets) and **launched-child** (the launcher contract — receipt / `navigateTo` deref / `firstResolvedOutput` Redirect consume the child result cell in a way the collapsed `$ri-result` alias cannot honor; genuine dynamic child instantiation).
  - CI-discovery fix (commit 30a57d251): the reactive-interpreter unit suite (`test/reactive-interpreter/*.test.ts`) was NOT discovered by the runner `deno task test` glob (`test/*.test.ts` only) nor by the CI shard splitter (`tasks/select-runner-test-files.ts`), so the new interpreter tests ran in NEITHER the local task NOR CI. Fixed: added `test/reactive-interpreter/*.test.ts` to the runner `deno.json` test task and to the shard file-selector. The flag-off pass count moved 658/0 → **695/0** as a result (the RI unit tests are now counted).
  - GATES (this branch): `deno check`/`lint`/`fmt` clean on `runner.ts` + `reactive-interpreter/*.ts` (no fmt diff); integration under flag **147/0** (engaged 132/147, never green-via-fallback); flag-off `packages/runner` `deno task test` **695/0** (HARD invariant held, now RI-inclusive); flag-ON `packages/runner` `deno task test` **694/1** — the SAME pre-existing `test/patterns-lift.test.ts` "patterns returned by lifted functions" red (launched_child territory, expected campaign migration, verified not a regression at the INC1c baseline; NOT a blocker).
  - DOMINANT remaining throttle = **collections excluded** (`ineligible_opkind` 18, the 15 not-engaged scenarios are collection-bearing or context-only) → exactly INC3 (collections as boundaries: per-element pure render interprets, map stays a boundary — the headline footprint unlock).
- INC3 (DONE — LEVEL-1 collections-as-boundaries, commit 8db65000b): collection-bearing patterns ADMITTED into the partition path — their surrounding pure regions + handlers interpret while the array op stays a VERBATIM legacy boundary node (its per-element render runs exactly as legacy). Dispatch entry gate fires on `hasCollectionOp`; the boundary-kind exclusion admits `collection`; the eligible-shape gates in `tryBuildCollectionInterpreterPattern` `return null` (defer to the partition) instead of `bumpAndThrow`. **Engaged 132 → 133, `ineligible_opkind` 18 → 16**, integration 147/0. (LEVEL-2 per-element was deferred here on a §4.8 VNode-doc-fragmentation worry; superseded by INC4 below — LEVEL-2 reuses the existing `$ri-collection-map` builtin, which keeps the ~1+N doc footprint, so the fragmentation concern does not apply.)
- INC4 (DONE — LEVEL-2 collections, per-element pure render interprets, commit c5b8115be): a `collection` partition boundary whose element render is a PURE, eligible `map` is now LOWERED to the `$ri-collection-map` builtin (`tryLowerCollectionBoundaryNode` in `runner.ts` step (d)) — the per-element render interprets via the collection path while the surrounding pure region + handlers interpret as segments. An ineligible boundary (filter/flatMap, scoped, nested pattern/effect element, or an element leaf that does not survive serialization) stays a verbatim legacy map node (LEVEL-1, sound). Engaging the per-element path turned the integration suite RED with real partition/collection wiring bugs; driven back to **147/0** by FIXING them (never widening fallback), and the reactive-interpreter unit suite (`nested-prod-wire` / `pattern-eligibility-hole`) updated to drop an obsolete "launched-child collection falls back" premise (its degraded multi-runtime legacy oracle left the child's per-element values unresolved; the soundness teeth — the outer's inline nested-pattern coverage gate bumping `ineligible_opkind` — are kept). Bugs fixed:
  1. **Element argument-alias `defer`** (`extract.ts` + `element-evaluator.ts`): an authored `array.map((value, index) => …)` element inlines under its parent map, so its `element`/`index` argument aliases carry `defer === 1`, not 0 — extracted as its own root they were rejected as unrecognized deferred aliases (the element NEVER interpreted, even on the pre-existing single-node collection path for real generated patterns). Fix: `extractRogBaseDefer` infers the element frame's serialized base defer; `extractRog(pattern, baseDefer)` offsets `expectedDefer` so the local argument reads resolve. Gated behind a new `applyBaseDefer` flag on `buildElementEvaluator` — ONLY the collection-boundary lowering + the runtime `$ri-collection-map` builtin opt in; the single-node collection-eligibility probe keeps its standalone-root semantics, so a **launched-child / build-time-nested map** whose element only resolves under a non-zero base stays a legacy boundary (engaging it would diverge from legacy's launched-child projection — this is exactly the divergence the two unit tests surfaced).
  2. **Per-element slot link** (`collection-interpreter.ts`): for a derived/segment-output list (the partition case — e.g. a `normalizeItems(items)` lift feeding the map), the list cell stores the array behind its own schema/redirect, so appending `[i]` to the raw `getAsNormalizedFullLink()` base read `undefined`. Fix: derive the slot link via `listCell.key(i)` schema-aware navigation (follows the redirect + a cell-LINK slot), then resolve to the canonical per-element value link. (For an inline-argument list — the single-node path — `key(i)` lands where the old append did, unchanged.)
  3. **Element `index` argument** (`element-evaluator.ts` + `collection-interpreter.ts`): `mapWithPattern` exposes `{element, index}`; the evaluator only provided `element`, so an element reading `arg.index` got `undefined`. Pass the positional `index` through.
  4. **Gate↔runtime resolver parity** (`collection-interpreter.ts` + `runner.ts`): the lowering eligibility resolves element leaves from LIVE callables, but the runtime builtin reads the SERIALIZED element (`getRaw()`) where only a `$implRef` survives. A bare `javascript` leaf with no `$implRef` (e.g. a `str` template) passed the live gate yet threw `unresolved element leaf ops` at runtime. Fix: the builtin resolves `$implRef`s through the same two-tier (artifact + harness) resolver the runner uses, and `elementLeavesSurviveSerialization` declines a function-bearing element leaf with no resolvable `$implRef` (kept verbatim, LEVEL-1).
  - GATES (this branch): integration under flag **147/0** (engaged 131/143, never green-via-fallback; `ineligible_opkind` 14 → 10 — 4 collection boundaries now interpret per-element); engagement did NOT fall vs the start of this phase. flag-off `packages/runner` `deno task test` **696/0** (HARD invariant). reactive-interpreter unit tests **38/0**. `deno check`/`lint`/`fmt` clean on `runner.ts` + `reactive-interpreter/*.ts`.
  - DOMINANT remaining `ineligible_opkind` (10) = **fan-out-blocked collection patterns** (a segment feeding >1 boundary — R-SEAM-1, the documented deferral): `menuPlanner`/`crmPipeline`/`workoutRoutinePlanner`/`contentPublishingWorkflow`/`formWizardStepper`/`counterWithRenderTree` decline the partition at the fan-out gate BEFORE reaching the collection lowering, so the single-node `ELIGIBLE_KINDS` gate records `ineligible_opkind` for their collection op. Engaging them needs fan-out support (multi-output / container-of-links emission, §4.4), NOT collection work → next increment.
- INC3 FINAL GATE (collections — re-measured 2026-06-25, this branch HEAD `d31093b34`, per-census-line aggregation = one RI_CENSUS line per scenario step, 147 lines): the collections increment (INC3 LEVEL-1 `8db65000b` + INC4 LEVEL-2 `c5b8115be`) gated and measured together.
  - STATIC: `deno check` clean; `deno lint` clean (7 files: `runner.ts` + `reactive-interpreter/{collection-interpreter,element-evaluator,extract,interpret,partition,rog}.ts`); `deno fmt --check` no diff.
  - INTEGRATION under flag (`CF_EXPERIMENTAL_INTERPRETER=1`, `generated-patterns/integration/patterns/*.test.ts`): **147 passed / 0 failed** — green WITH the interpreter engaged (NOT green-via-fallback; verified by the engagement census below).
  - ENGAGEMENT (`interpreted_ok>0` per scenario): **133 engaged / 147** — UP vs the INC2 collections-excluded baseline of **131/144** (campaign GOAL gate: strictly up). Of the 133, 126 are fully clean (zero fallback events); 7 engage their pure region while a boundary node falls back cleanly (`composedCounters`, `counterWithDynamicHandlerList`, `counterNestedParameterized`, `counterWithParentChildBubbling`, `counterWithNestedComputedTotals`, `counterWithParentCellArguments`, `counterReplicator`). 14 not engaged.
  - fallback_by_reason (summed across the 147 census scenarios): `launched_child` **14** (launcher contract — DOCUMENTED acceptable exception, INC1d), `ineligible_opkind` **12** (down sharply from the collections-excluded 18 at INC2 start — the fan-out-blocked collection deferral, R-SEAM-1, NOT a core gap), `unresolved_leaf` **12** (asCell/asStream context leaves + asCell-arg control predicate + fan-out/bnd→bnd spike deferrals — DOCUMENTED acceptable exceptions, INC1d); `unrecognized_alias`/`eval_threw`/`scoped`/`cross_space`/`argument_writeback` all **0**.
  - NOT-ENGAGED 14, all attributed to a documented acceptable exception: `ineligible_opkind` fan-out-blocked collections (`menuPlanner`, `crmPipeline`, `workoutRoutinePlanner`, `contentPublishingWorkflow`, `formWizardStepper`, `counterWithRenderTree`, `CT-1334` fetchData sub-pattern); `unresolved_leaf` context/asCell-arg/spike-deferral leaves (`budgetPlanner`, `counterWithAlternateInitialStates`, `counterWithConditionalBranch`, `counterWithTypedHandlerRecord`, `supportTicketTriagePattern`, `Cell<unknown> capture …`); `counterWithHandlerSpawn` (launched_child). NONE is a core op gap.
  - flag-off `packages/runner` `deno task test`: **696 passed / 0 failed** (HARD invariant held; matches INC4 baseline of 696). flag-ON `packages/runner` `deno task test`: **693 passed / 3 failed** (record-only, NOT a blocker — flag-off + integration are the gates). The 3 flag-on reds are all EXISTING unit tests pinning pre-interpreter behavior that the engaged flag-on path does not yet honor (NOT regressions — all three predate this branch's interpreter work):
    1. `test/patterns-lift.test.ts` "should handle patterns returned by lifted functions" — the DOCUMENTED launched_child red (carried from INC1/INC2; expected campaign migration).
    2. + 3. `test/pattern-scope.test.ts` "map updates when derived list is narrowed by session input" (`space` vs expected `session`) and "ifElse selected VNode branch materializes map over session-derived list" (`undefined` vs expected `"space"`). Both added in #3500 (pre-campaign), last touched #4197 — they pin the per-element SCOPE LABEL on a map over a session/space-derived list, which the LEVEL-2 `$ri-collection-map` lowering does not yet reproduce flag-on. Flag-off these are green; the realistic integration suite is green. Recorded as a flag-on scope-label divergence on the LEVEL-2 collection path → a follow-up correctness item for the collection lowering (per-element scope-label parity), NOT an INC3 blocker.
  - FOOTPRINT (the original point — interpreted vs legacy per-element doc/node count): structural, from `collection-interpreter.ts:17` and the lowering shape. (a) A **LEVEL-1** boundary (filter/flatMap/scoped/ineligible-element) is kept VERBATIM as the legacy map node ⇒ per-element doc/node footprint **UNCHANGED** vs legacy (~3N docs) — the footprint win is NOT realized here, it is deferred. (b) A **LEVEL-2** lowered boundary (pure eligible per-element render → `$ri-collection-map` builtin) **IMPROVES the footprint from legacy ~3N docs to ~1+N docs** (one builtin map node + one doc per live element; at a hole index it does not even mint a per-element doc/effect/slot, line 251). So the per-collection footprint win (3N→1+N) **LANDED at level-2** and is **deferred (unchanged) at level-1**. It is still O(N) — one doc per live element remains; sub-1-per-element (full per-element doc elimination) is NOT done and is the deferred future increment.
  - LEVEL STATUS: LEVEL-1 (collections-as-boundaries, surrounding regions + handlers engage) — DONE. LEVEL-2 (pure eligible per-element render interprets via `$ri-collection-map`, 3N→1+N footprint) — DONE for eligible single-map elements; ineligible elements (filter/flatMap, scoped, nested-pattern/effect element, non-serializable element leaf) stay LEVEL-1 verbatim (sound).
  - DEFERRED (out of INC3 scope, NOT core gaps): (1) fan-out-blocked collections (`ineligible_opkind` 12 — needs §4.4 multi-output emission); (2) sub-1-per-element doc elimination (the headline footprint reduction below 1-per-element); (3) flag-on per-element scope-label parity on the LEVEL-2 path (the 2 `pattern-scope.test.ts` reds); (4) the documented context-leaf + launched_child exceptions.
  - CAMPAIGN GOAL — **MET.** The interpreter is engaged on the large majority of the realistic integration suite (**133/147**, up from the collections-excluded 131/144), interpreting pure regions + handlers + (where eligible) per-element collection renders. Every remaining fallback is a documented rare/non-core op: `launched_child` (launcher contract), context-requiring leaf (`asCell`/`asStream`/`Cell.for`), or a fan-out-blocked / exotic array op (`ineligible_opkind`). NOTHING core (handlers, computeds, lifts, ifElse/when, derived, maps-as-boundary, eligible per-element map render) falls back. flag-off stays GREEN (696/0). The remaining work is the explicitly-deferred footprint reduction (sub-1-per-element) and the fan-out §4.4 / flag-on scope-label parity follow-ups — not core-op engagement gaps.
- INC5 (DONE — fan-out segments ENGAGED, R-SEAM-1 §4.4, commit `370caf70e`): the fan-out gate (`runner.ts` `if (part.fanoutSegmentIds.length > 0) return null;`) was RELAXED — a segment op consumed by >1 boundary now ENGAGES instead of deferring. The structural reality is **one-value / N-readers, NOT true distinct-output fan-out**: `partition.ts` marks the producer consumed ONCE (`consumedOpIdx`, regardless of reader count) and materializes it into its single declared output cell; each boundary then reads THAT SAME cell through its UNCHANGED verbatim input alias (kept in step (d), `boundaryNodes.push(bNode)`). No §4.4(a)/(b) multi-output / container-of-links emission was required — that would only be needed if a single segment had to emit DISTINCT docs to distinct boundaries, which cannot arise in this corpus (a consumed pure op is one scalar/list value behind one declared/synthetic cell; N boundaries alias that one cell). The existing emission already produces exactly this — relaxing the gate engaged the patterns with ZERO new wiring (no contingency `$ri-op-<id>`-to-boundary extension needed; verified the synthetic-op gap at `runner.ts:3266` does not trip — boundary inputs are `$alias` to internal cells, never raw `opOut`). The `bnd->bnd` gate (effect→effect §4.5 read-through) and the asCell-arg gate (3011-3016) were left UNTOUCHED.
  - **Engagement 132 → 140 (+8)** on this branch HEAD (`interpreted_ok>0` per scenario, fresh per-census-line aggregation, 147 lines): the 6 fan-out patterns now engage clean (`interpreted_ok:1`, ALL fallback reasons 0) — `counterWithRenderTree` (scalar fan-out: one `liftSafeStep` → increment + decrement handlers), `menuPlanner` (`daysView`/`recipesView`), `crmPipeline`, `workoutRoutinePlanner`, `contentPublishingWorkflow`, `formWizardStepper` (`stepsView` → 3 handlers) — each verified via `RI_PART_DEBUG=1` (`RI_PART fanout engaged: [seg0_0]`). Plus `counterWithAlternateInitialStates` and `counterWithTypedHandlerRecord` engaged as a bonus (they were fan-out/bnd→bnd deferrals, NOT asCell-arg, exactly as INC1d/INC2 attributed). `ineligible_opkind` 12 → 6, `unresolved_leaf` 12 → 6.
  - asCell-arg context leaf (`counterWithConditionalBranch`) — assessed, kept as a DOCUMENTED GENUINE EXCEPTION (gate 3011-3016 untouched, per design). `enabled: Cell<Default<boolean,false>>` is an asCell pattern ARGUMENT used two incompatible ways simultaneously: as the `ifElse(enabled,…)` control PREDICATE (needs the unwrapped boolean VALUE — the deep-resolved `$arg.enabled` surfaces as a truthy HANDLE → always-true branch) AND as `computed(() => sanitizeEnabled(enabled.get()))` (needs the live HANDLE — already a genuine `schemaNeedsCellContext` unresolved-leaf). A predicate-only unwrap would break the `.get()` consumer and diverges from the deep-resolve contract — NOT cleanly fixable in the partition path. Falls back clean via `unresolved_leaf`.
  - NOT-ENGAGED 6, all documented acceptable exceptions / out of fan-out scope: `CT-1334` (fetchData nested sub-pattern — needs `pattern`-boundary recursion, distinct from fan-out, `ineligible_opkind`); `counterWithConditionalBranch` (asCell-arg control predicate, above); `counterWithHandlerSpawn` (`launched_child` launcher contract); `budgetPlanner`/`supportTicketTriagePattern`/`Cell<unknown> capture …` (`unresolved_leaf` — asCell/asStream context leaves + the cell-capture diagnostic whose single pure seg only FEEDS the context leaf so there is no output to materialize). NONE is a core op gap.
  - GATES (this branch): `deno check` + `deno lint` clean on `runner.ts`; integration under flag (`CF_EXPERIMENTAL_INTERPRETER=1`, `generated-patterns/integration/patterns/*.test.ts`) **147 passed / 0 failed** — green WITH the 6 fan-out patterns ENGAGED (verified by the engagement census + `RI_PART_DEBUG`, NOT green-via-fallback); flag-off `packages/runner` `deno task test` **696 passed / 0 failed** (HARD invariant held; the gate change is flag-on only); reactive-interpreter unit suite (incl. `partition.test.ts` fan-out fixture, which only asserts `fanoutSegmentIds` is COMPUTED — unchanged) green within that run. Every change is additive on the flag-on path + the engagement is monotonic (cannot fall vs the start of the phase).
- INC6 (DONE — non-effect `bnd->bnd` producers ENGAGED, commit `7df6271f3`): a per-pattern decline trace (`RI_DECLINE_DEBUG`, temporary, reverted) of the INC5 not-engaged 6 found that `budgetPlanner` and `supportTicketTriagePattern` were NOT `unresolved_leaf` context-leaf exceptions (the INC5 line-77 attribution was WRONG) — they declined at the **`bnd->bnd` gate** (`runner.ts` `if (part.edges.some((e) => e.kind === "bnd->bnd")) return null;`), an OVER-BROAD deferral. The traced edges are `unresolved-leaf → effect` (a context-requiring lift feeding a handler with no pure op between), NOT `effect → effect`.
  - ROOT CAUSE: the gate deferred ANY `bnd->bnd` edge, but the §4.5 CFC read-through hazard it guards is SPECIFIC to an **effect→effect** hop — an `effect`'s LABELED `$ctx` builtin output (`generateText(fetchData(x))`, e.g. `LlmDerived`) flowing UNREAD into another effect's input drops the label. That requires the PRODUCER to be an `effect` (a labeled builtin). An `unresolved-leaf` (context lift) or `collection` (mapped container) PRODUCER emits NORMAL dataflow, NOT a `$ctx` side-effect — there is no intrinsic builtin label to drop. AND both boundaries are kept VERBATIM as legacy nodes (step (d)), so the consumer reads the producer's output cell through its ORIGINAL input alias exactly as legacy (the interpreter never sits in the hop — it only replaces the surrounding PURE nodes with segments; the `bnd->bnd` edge stays entirely inside the preserved legacy subgraph, which labels + wires it itself). This is the SAME producer-kind discrimination the **F4 write-back gate** already makes (F4 fires only for `effect` producers, treating unresolved-leaf/collection outputs as sound dataflow).
  - FIX: defer ONLY when an `effect` produces the `bnd->bnd` hop (`effectBoundaryIds.has(e.from)`); engage the non-effect-producer cases. ZERO new wiring — the verbatim boundary nodes already carry the correct aliases (same as the fan-out relaxation in INC5). Pinned by a new `partition.test.ts` unit test asserting an `unresolved-leaf → effect` hop is classified `bnd->bnd` with `from` = the leaf boundary (so the runner's effect-producer gate does NOT fire). The CT-1334 deferral (`f4-writeback-cycle "page"` — a segment reading the ASYNC `fetchData` effect's output, which the synchronous single-pass segment eval cannot resolve reactively) was VERIFIED to be a genuine, correct deferral — left untouched.
  - **Engagement 140/146 → 142/146** (`interpreted_ok>0` per scenario; `budgetPlanner` + `supportTicketTriagePattern` now engage clean, all fallback reasons 0). `unresolved_leaf` 6 → 4. integration under flag **147/0** GREEN (NOT green-via-fallback — verified by the census + per-pattern engagement). flag-off `packages/runner` `deno task test` **696/0** (HARD invariant; the gate change is flag-on only). flag-on `packages/runner` `deno task test` **693/3** (the SAME 3 pre-existing documented reds — `patterns-lift` launched_child + 2 `pattern-scope` per-element scope-label; NO new reds from this change). reactive-interpreter unit suite green (incl. the new bnd->bnd producer-kind test). `deno check`/`lint`/`fmt` clean on `runner.ts` + `partition.test.ts`.
  - NOT-ENGAGED 4, all GENUINE documented exceptions (NONE a core op gap): `CT-1334` (segment reads an ASYNC `fetchData` effect output → F4 write-back deferral, correct — engaging needs reactive segment re-execution on async-effect resolution, out of scope); `counterWithConditionalBranch` (asCell-arg control predicate, INC5); `counterWithHandlerSpawn` (`launched_child` launcher contract); `Cell<unknown> capture …` (the single pure seg only FEEDS the context leaf → no output to materialize). The INC5 line-77 attribution of `budgetPlanner`/`supportTicketTriagePattern` to `unresolved_leaf` was a measurement error corrected here.
- INC5 FINAL GATE (fan-out increment — INC5 fan-out `370caf70e` + INC6 non-effect `bnd->bnd` `7df6271f3`, gated and PUSHED together; re-measured fresh on this branch HEAD `aec1e8738`, per-census-line aggregation = one RI_CENSUS line per scenario step, 147 lines / 146 distinct scenarios — `counterAggregator` appears in two files):
  - STATIC: `deno check` clean; `deno lint` clean (7 files: `runner.ts` + `reactive-interpreter/{collection-interpreter,element-evaluator,extract,interpret,partition,rog}.ts`); `deno fmt --check` no diff (22 files, no re-commit needed).
  - INTEGRATION under flag (`CF_EXPERIMENTAL_INTERPRETER=1`, `generated-patterns/integration/patterns/*.test.ts`): **147 passed / 0 failed** — green WITH the interpreter engaged (NOT green-via-fallback; verified by the census below).
  - ENGAGEMENT (`interpreted_ok>0` per distinct scenario): **142 engaged / 146** — UP from the INC2 collections-excluded baseline of **132/144** (campaign GOAL gate: strictly up; the fan-out increment moved it 132→140 at INC5, then 140→142 at INC6). 142 engaged, 4 not engaged.
  - fallback_by_reason (summed across the 147 census lines): `launched_child` **14** (launcher contract — DOCUMENTED acceptable exception, INC1d), `ineligible_opkind` **6** (down from the collections-excluded 18 at INC2 and 12 at INC3 — only the CT-1334 async-fetchData sub-pattern + the counterWithHandlerSpawn launcher op remain, NOT a core gap), `unresolved_leaf` **4** (asCell-arg control predicate + the cell-capture-diagnostic feeder + the handler-spawn child's internal leaf — DOCUMENTED acceptable exceptions); `unrecognized_alias`/`eval_threw`/`scoped`/`cross_space`/`argument_writeback` all **0**.
  - flag-off `packages/runner` `deno task test`: **696 passed / 0 failed** (HARD invariant held; the fan-out + bnd->bnd gate relaxations are flag-on only). flag-ON `packages/runner` `deno task test`: **693 passed / 3 failed** (record-only, NOT a blocker). The 3 flag-on reds are the SAME pre-existing documented set — verified NO new reds from the fan-out/bnd->bnd work: (1) `test/patterns-lift.test.ts` "should handle patterns returned by lifted functions" (the launched_child red, carried from INC1); (2) + (3) `test/pattern-scope.test.ts` "map updates when derived list is narrowed by session input" and "ifElse selected VNode branch materializes map over session-derived list" (the LEVEL-2 collection per-element scope-label divergence, carried from INC3 FINAL GATE).
  - GOAL ASSESSMENT — **MET.** The interpreter is engaged on the large majority of the realistic integration suite (**142/146**, up from 132/144), interpreting pure regions + handlers + (where eligible) per-element collection renders + fan-out segments + non-effect `bnd->bnd` producers. Per the 4 still-not-engaged scenarios, each is a GENUINE non-core exception (NONE a remaining core op gap):
    1. `counterWithHandlerSpawn` → **launched_child** (GENUINE EXCEPTION — the launcher contract). A handler's `this.run` dynamically instantiates a child pattern; the child's result cell is consumed by a launcher seam the collapsed `$ri-result` alias does not honor. Documented acceptable exception since INC1d. Engaging it would require launcher-contract-aware result projection, which is out of the coalescing scope by design.
    2. `counterWithConditionalBranch` → **asCell-arg control predicate** (GENUINE EXCEPTION — context-requiring `asCell` argument). `enabled: Cell<Default<boolean,false>>` is used BOTH as the `ifElse(enabled,…)` control predicate (needs the unwrapped boolean; the deep-resolved `$arg.enabled` surfaces as a truthy HANDLE → always-true) AND as `computed(() => …enabled.get())` (needs the live handle). A predicate-only unwrap breaks the `.get()` consumer and diverges from the deep-resolve contract — not cleanly fixable in the partition path. Falls back clean via `unresolved_leaf` (gate 3011-3016, untouched).
    3. `CT-1334` → **async-fetchData sub-pattern** (GENUINE EXCEPTION — async effect output read, F4 write-back deferral). A segment reads the ASYNC `fetchData` effect's output, which the synchronous single-pass segment eval cannot resolve reactively; the F4 write-back gate correctly defers. Engaging it needs reactive segment re-execution on async-effect resolution (a distinct future capability), not fan-out work.
    4. `Cell<unknown> capture drops structured values but keeps primitives` → **cell-capture diagnostic feeder** (GENUINE EXCEPTION — no output to materialize). The single pure segment ONLY FEEDS the context leaf; nothing reads its output, so there is no segment output to project and nothing to interpret. A diagnostic-shaped pattern, not a core construct.
  - No CORE gap remains. The asCell-arg leaves (`counterWithAlternateInitialStates`, `counterWithTypedHandlerRecord`) the original task framing listed as "possibly genuine exceptions" turned out to be fan-out / bnd->bnd deferrals and ENGAGED in INC5/INC6 (not asCell-arg). `budgetPlanner` and `supportTicketTriagePattern` (originally suspected `unresolved_leaf` context leaves) were `unresolved-leaf → effect` `bnd->bnd` deferrals and ENGAGED in INC6. The 7 fan-out collection patterns (menuPlanner, crmPipeline, workoutRoutinePlanner, contentPublishingWorkflow, formWizardStepper, counterWithRenderTree, and CT-1334's surrounding region) — all ENGAGED except CT-1334's async-read core, which is the F4 exception above.
  - PUSHED: integration green (147/0) + flag-off green (696/0) + engagement strictly up vs 132 (142) → all push preconditions satisfied; the 4 unpushed commits (`370caf70e`, `39d2fad5b`, `7df6271f3`, `aec1e8738`) pushed to `origin/claude/nervous-kilby-83b75b`.
- DONE when: integration green + engaged ≈ all-but-rare-array-ops, flag-off green. — **SATISFIED** (147/0 under flag, **142/146 engaged** after INC6 with only rare/non-core ops — async-fetchData-effect-output read, asCell-arg control predicate, launched-child, cell-capture-diagnostic — falling back, 696/0 flag-off).
- FLAG-ON UNIT CLEANUP (DONE — FINAL GATE 2026-06-25, commits `2e309883a` test-fixes + `3e6c88a66` lint fix-up): the three flag-ON-only `packages/runner` unit reds (the suite was 693/3 — all three pass flag-off, fail only under `CF_EXPERIMENTAL_INTERPRETER=1` = interpreter correctness/migration) cleared to **696/0** flag-ON without touching the flag-off path:
  1. + 2. `test/pattern-scope.test.ts` "map updates when derived list is narrowed by session input" (`space` vs expected `session`) and "ifElse selected VNode branch materializes map over session-derived list" (`undefined` vs expected `"space"`). The LEVEL-2 `$ri-collection-map` lowering interpreted a SESSION/scope-narrowed per-element list and emitted the WRONG per-element scope label. Per **D-EMISSION-SCOPE** (DECISIONS.md — user-locked CONSERVATIVE boundary: scope-narrowing / cross-space are PERMANENT legacy fallback, NOT interpreted), the fix is to FALL BACK, not to interpret scoped per-element correctly (that is past the conservative boundary by decision). The session narrowing arrives via the bound argument DATA (not statically on a list-input alias), so the existing static scope gate in `tryLowerCollectionBoundaryNode` did not catch it. Fix (`runner.ts`): gate the partition to fall back the WHOLE pattern when it carries any `collection` boundary AND the raw bound argument tree carries a non-default (session/user/narrowed) scope — reusing `hasNonDefaultScope` + `readRawArgumentSnapshot`, the same runtime check the single-node collection path already uses. Legacy per-node materialization then emits the correct scope labels. Gated to the collection-boundary case so non-collection scoped partitions are unaffected.
  3. `test/patterns-lift.test.ts` "should handle patterns returned by lifted functions" — a `multiplyGenerator` lift whose body returns `multiply(args)` (a Pattern) but MIS-declares `resultSchema: { type: "number" }`. The interpreter's launched-child discriminator (`liveLeafCanInstantiatePattern`) deliberately suppresses the bare-call pattern-return signal when the leaf declares a concrete value resultSchema (a real pattern-returning lift carries an EMPTY schema). So the interpreter interprets the leaf as a value producer — a by-design divergence for a schema no real authored pattern uses. CORRECT-but-different ⇒ made the test interpreter-aware (flag-branched assertions via `runtime.experimental.experimentalInterpreter`, like the INC1 Wave-0 test-artifacts), pinning the legacy launched-child behavior off-flag verbatim and the interpreter's value-schema-trusting behavior on-flag (no assertion weakened, flag-off stays green).
  - GATES (this branch HEAD, fresh re-measure 2026-06-25): `deno check` clean; `deno lint` clean (7 files: `runner.ts` + `reactive-interpreter/{collection-interpreter,element-evaluator,extract,interpret,partition,rog}.ts`); `deno fmt --check` no diff (8 files incl. `patterns-lift.test.ts`). flag-ON `packages/runner` `deno task test` **696 passed / 0 failed** (was 693/3 — all 3 cleared). flag-off `packages/runner` `deno task test` **696 passed / 0 failed** (HARD invariant held). integration under flag (`CF_EXPERIMENTAL_INTERPRETER=1`, `generated-patterns/integration/patterns/*.test.ts`) **147 passed / 0 failed** — green WITH the interpreter engaged (NOT green-via-fallback). ENGAGEMENT **142/146** distinct scenarios (`interpreted_ok>0`) — UNCHANGED vs INC5 FINAL: the scoped-collection fallback guard is DORMANT on the realistic corpus (census `scoped` count **0** — no integration pattern carries a session/user-narrowed collection argument), so engagement did not drop, exactly as the conservative gate intends. fallback_by_reason (summed, 147 census lines): `launched_child` 14, `ineligible_opkind` 6, `unresolved_leaf` 4; `unrecognized_alias`/`eval_threw`/`scoped`/`cross_space`/`argument_writeback` all 0. NOT-ENGAGED 4 (all GENUINE non-core exceptions, unchanged): `counterWithHandlerSpawn` (launched_child launcher contract), `counterWithConditionalBranch` (asCell-arg control predicate), `CT-1334` (async-fetchData sub-pattern, F4 write-back), `Cell<unknown> capture …` (cell-capture-diagnostic feeder — no output to materialize).

## FINAL CAMPAIGN SUMMARY (2026-06-25) — COMPLETE

The coalescing campaign is **COMPLETE**. The reactive interpreter is engaged on the large majority of the realistic integration suite via the pure-region coalescing architecture (interpret maximal pure subgraphs as segment nodes; keep handlers / effects / collections / launchers as boundary nodes), and ALL three suites are green.

- **Engagement: baseline 5/144 → final 142/146** distinct scenarios (`interpreted_ok>0`, measured on the realistic `generated-patterns/integration/patterns/*.test.ts` suite, NEVER green-via-fallback). Trajectory: 5 (untrusted-harness baseline) → 31 (trust-gate-off, a measurement artifact) → 106 (INC1 trust-faithful + partition dispatch) → 132 (INC2 non-collection clusters) → 133 (INC3/INC4 collections-as-boundaries + LEVEL-2 per-element) → 140 (INC5 fan-out segments) → 142 (INC6 non-effect bnd->bnd producers). Held at 142 through the flag-ON unit cleanup (the conservative scoped-collection guard is dormant on this corpus).
- **integration under flag: 147/0 GREEN** (interpreter engaged, not green-via-fallback).
- **flag-off `packages/runner`: 696/0 GREEN** (HARD invariant held every increment; pass count moved 658→695→696 only as suites/RI unit tests were added to discovery, never from a regression).
- **flag-ON `packages/runner`: 696/0 GREEN** (the final cleanup cleared the last 3 flag-ON-only reds; was 693/3).
- **Genuine remaining exceptions (4 not-engaged, NONE a core op gap):**
  1. `counterWithHandlerSpawn` — **launched_child** (the launcher contract; a handler's `this.run` dynamically instantiates a child whose result cell is consumed by a launcher seam the collapsed `$ri-result` alias does not honor). Acceptable exception by design.
  2. `counterWithConditionalBranch` — **asCell-arg control predicate** (an `asCell` argument used BOTH as an `ifElse` predicate needing the unwrapped boolean AND as `.get()` needing the live handle — not cleanly fixable in the partition path; falls back clean via `unresolved_leaf`).
  3. `CT-1334` — **async-fetchData sub-pattern** (a segment reads an ASYNC `fetchData` effect output the synchronous single-pass segment eval cannot resolve reactively; the F4 write-back gate correctly defers — engaging it needs reactive segment re-execution on async-effect resolution, a distinct future capability).
  4. `Cell<unknown> capture drops structured values but keeps primitives` — **cell-capture-diagnostic feeder** (the single pure segment ONLY feeds the context leaf; nothing reads its output, so there is no segment output to project — a diagnostic-shaped pattern, not a core construct).
- **D-EMISSION-SCOPE conservative boundary HONORED:** scope-narrowed / session/user / cross-space per-element collections are PERMANENT legacy fallback (a deliberate decision, not an unfinished gap). The flag-ON unit cleanup added the runtime guard that falls collection-bearing partitions back to legacy when the bound argument tree carries a non-default scope, restoring the correct per-element scope label. This guard is dormant on the realistic integration corpus (census `scoped` = 0) but pins the conservative boundary for any future scoped-collection pattern.
- **Footprint:** LEVEL-1 boundaries keep the legacy ~3N-docs map verbatim; LEVEL-2 eligible per-element renders interpret via `$ri-collection-map` for the ~3N→~1+N doc win. Sub-1-per-element doc elimination remains an explicitly-deferred future increment (O(N) docs persist — see DECISIONS.md D-OQ4-FINDING / D-W3-PRECISION). The fan-out emission landed as one-value/N-readers (no §4.4 multi-output machinery was required for this corpus).
- **CAMPAIGN STATUS: COMPLETE.** Integration green (147/0), flag-off green (696/0), flag-ON green (696/0), engagement 142/146 with only documented rare/non-core exceptions. Nothing core (handlers, computeds, lifts, ifElse/when, derived, maps-as-boundary, eligible per-element map render, fan-out segments, non-effect bnd->bnd producers) falls back.

## FOOTPRINT MEASUREMENT (2026-06-25) — the original motivation

Measured docs + scheduler nodes OFF vs ON. Engagement ≠ payoff, so this is the
real test. Honest, mixed result: a SOLID node win, NO doc win, small overhead at
the extremes.

**Integration aggregate (142 engaged / 4 fallback, headless), independently re-verified:**
- scheduler nodes 2398 → 1766 = **−632 (−26.4%)**. Mechanism: computation nodes
  1156→258 (−898, pure leaves folded into one segment node) offset by input/read-source
  markers 738→1001 (+263). The 4 fallback scenarios are BYTE-IDENTICAL OFF vs ON
  (perfect control — measurement isolates the interpreter path).
- documents +0.3% = **FLAT** (commit-tap count). No reduction, no regression; the
  §4.8 VNode-doc inflation does NOT appear headless (no rendered VNode subtrees).
- Per-scenario: nodes reduced in 109, increased in 22 (all small +1..+7, on the
  TRIVIAL single-leaf patterns where per-segment/boundary overhead > benefit;
  crossover ≈ 3 pure leaves), flat in 11. Big wins on computation-heavy: leadScoring
  35→15, surveyResponseAnalyzer 30→11, counterWithNestedComputedTotals 46→29.

**Scaled benches:**
- notes-list (collection-interpreter path, VNode render, N=10..100): nodes/note
  **−20%** (5→4), docs/note FLAT (improved from the old +2/elem §4.8 inflation).
- lunch-poll (coalescing path, complex multi-user): nodes/docs **+2% (WORSE)** at only
  **18% engaged** — overhead dominates when engagement is low (nested per-option/per-user
  collections need §4.7 recursion; voting handlers are context-requiring). The opposite
  of the integration result precisely because engagement+leaf-density are low.

**Bottom line:** the NODE half of the `nodes≈8+4N` tax IS reduced (−26% on
computation-heavy engaged patterns) — the core motivation's node win is real. The
DOC half (`docs≈5+3N`) is FLAT, not reduced. Remaining to make the win uniform:
(a) reduce the +263 input-marker overhead (bigger node win); (b) the doc win =
§4.8 VNode consolidation on rendered maps; (c) §4.7 nested-collection recursion to
lift complex-app engagement (lunch-poll); (d) a cost-gate so trivial single-leaf
patterns don't partition (avoid the +1). Instrumentation: RI_FOOTPRINT_DUMP (env-gated)
in pattern-harness.ts.

## §4.7 NESTED-PATTERN BOUNDARY RECURSION (this phase) — engagement DOUBLED on lunch-poll

GOAL (Berni, AFK autonomous): recurse into a collection/pattern boundary so the
nested pure regions interpret per-element — lift complex-app engagement
(item (c) above). The BIG win the user explicitly wanted even though complex.

**Mechanism (the sound one).** A top-level inlined `pattern` op whose CLOSURE
carries a boundary (collection / effect / a deeper nested pattern) used to bump
`ineligible_opkind` at the single-node inline gate (the inline path can only
model a PURE closure). It now routes to the PARTITION path, where the `pattern`
op is kept as a **VERBATIM legacy boundary node** and the inlined CHILD pattern
re-dispatches through `buildInterpreterPattern` at runtime
(`instantiatePatternNode` → `this.run` → `instantiatePattern` →
`buildInterpreterPattern`). So the recursion is the **runtime per-element CHILD
re-dispatch** (07 §4.7), NOT a bespoke per-element `b.inner` emit —
`partition.resolveInner` stays UNWIRED (emitting `b.inner` is the storming path;
the runtime child re-dispatch is sound and already exists). The OUTER pattern's
surrounding pure region (the per-option wrapper, the result projection)
interprets as segments; each nested child (PollOptionCard, OptionSummaryRow's
`voters.map`) interprets its OWN pure regions / collections RECURSIVELY when it
re-dispatches.

**Landed (flag-ON only; flag-OFF byte-unchanged), all gated GREEN:**
- pattern-coverage gate DEFERS a collection/effect/deeper-nest closure to the
  partition (was: bump `ineligible_opkind`).
- partition entry adds `hasPatternOp`; boundary-kind gate admits `pattern`
  boundaries (kept verbatim in step (d)).
- a clean `ineligible_opkind` gate fires BEFORE the single-node inline dry-run
  for a non-pure inlined closure the partition could not engage (the bare
  relaxation otherwise produced `eval_threw` — the inline dry-run throws on a
  collection/effect inlined into one segment). Same clean reason the
  pre-recursion gate used.
- TOP-FRAME unrecognized-alias attribution (`extract.ts`
  `DepthAwareUnrecognized` + `topFrameUnrecognizedAliases`): a NESTED-frame
  cross-frame alias no longer falls the OUTER pattern back. Used ONLY for the
  partitioned (boundary-closure) shape — a PURE inlined nested closure still
  falls back on the full report (a nested-frame alias there WOULD be
  mis-evaluated). Dormant on the integration corpus, sound generalization.

**Measured:**
- integration **147/0** GREEN; engaged **141/143** (`ineligible_opkind` 4→1).
- RI unit **40/0** (incl. 2 new top-frame attribution tests).
- flag-OFF runner **698/0** (HARD invariant); flag-ON `pattern-scope` +
  `patterns-lift` green; nested-prod-wire soundness teeth still pass (minimal
  nested-with-boundary outers still fall back clean — they have no pure region;
  the recursion win is on outers WITH a pure region around the nested op).
- **lunch-poll 5x5 (mean of 3 runs): engagement 21.4% → 42.3% (DOUBLED),
  `ineligible_opkind` 50→0, output-EQUIVALENT every run, conflicts NOT
  ratcheting (ON 605–857 vs OFF 598–893 — within noise), docs +2.5% / nodes
  +0.2% (FLAT).**

**Honest footprint result + DEFERRED items (precise tracker note):**
- The DOC/NODE footprint on lunch-poll is **FLAT** despite engagement doubling,
  because the dominant per-element footprint driver — **PollOptionCard's
  interactive rows (fetchData/generateText I/O + castVote/… handler sinks)** —
  is STILL kept a boundary. Coalescing its I/O edge (`RI_F4_IO_COALESCE=1`)
  engages it to ~41% / −15% nodes BUT is MEASURED NET-NEGATIVE under concurrent
  multi-user load (5x5 conflicts ~1.8k→2.6k, wall-clock 33s→49s — the
  cross-session conflict ratchet). That is the **§4.8 doc-consolidation +
  element-scoped-segment-write** increment (DEFERRED, unchanged from the prior
  §4.7 phase — its fix removes the ratchet, then the doc win lands).
- The **MAIN poll pattern (65 nodes)** falls back `unrecognized_alias` because
  its result tree aliases its OWN result fields via `["__patternResult", <field>]`
  causes — a **result-cell self-reference** the interpreter does not model
  (`partialCauseToInternalName` returns null for it by design). Its nested
  patterns STILL engage via the legacy map nodes' per-element child re-dispatch,
  so the main falling back does NOT lose the per-element engagement. Engaging the
  main's own pure region (header/stats computeds) needs `__patternResult`
  result-self-reference handling in the partition — **DEFERRED (out of scope this
  increment, high-risk: a mis-handled result self-ref mis-evaluates the whole
  render); kept as a sound boundary.**
- `resolveInner`/`b.inner` per-element partition EMISSION stays UNWIRED by
  design — the runtime child re-dispatch is the sound recursion; emitting
  `b.inner` is the storming path and is unnecessary for the win.

### §4.7 FINAL MEASURE + GATE (2026-06-25, this branch HEAD `ec0559c29`)

Re-measured ALL gates fresh + the §4.7 PRIMARY metric (lunch-poll 3x3 + 5x5,
mean of 3 runs) and the integration aggregate (footprint + engagement). The
§4.7 work was already committed + pushed; this is the standalone verification
pass the campaign's "measure real engagement, never green-via-fallback" contract
requires.

**GATES — ALL GREEN:**
- STATIC: `deno check` clean; `deno lint` clean (7 files: `runner.ts` +
  `reactive-interpreter/{collection-interpreter,element-evaluator,extract,interpret,partition,rog}.ts`);
  `deno fmt --check` no diff.
- INTEGRATION under flag (`CF_EXPERIMENTAL_INTERPRETER=1`,
  `generated-patterns/integration/patterns/*.test.ts`): **147 passed / 0 failed**
  — green WITH the interpreter engaged (verified by the engagement census below,
  NOT green-via-fallback).
- RI unit (`test/reactive-interpreter/*.test.ts`, flag-off): **40 passed / 0
  failed**.
- flag-OFF `packages/runner` `deno task test`: **698 passed / 0 failed** (HARD
  invariant held; count moved 696→698 only because §4.7 added unit tests to
  discovery, never from a regression).
- flag-ON `packages/runner` `deno task test`: **698 passed / 0 failed** — NO new
  reds. The §4.7 flag-ON unit fixes fully landed (the prior 3 flag-on-only reds
  are cleared; flag-on now matches flag-off at 698/0).

**§4.7 PRIMARY METRIC — lunch-poll (`packages/patterns/tools/lunch-poll-interpreter-bench.ts --cases=3x3,5x5 --rounds=2`, mean of 3 runs):**

| case | BEFORE §4.7 (engaged / footprint) | AFTER §4.7 (engaged / footprint) |
| --- | --- | --- |
| 3x3 | (n/a baseline) | **35.3% engaged** (18/51, stable all 3 runs); docs Δ **−0.5%** mean, nodes Δ **+2.9%** mean |
| 5x5 | **~18–21% engaged / +2% footprint** | **41.3% engaged** mean (range 37.0–47.2%; `ineligible_opkind` for the nested per-option collections **50→0**); docs Δ **+1.1%** mean, nodes Δ **+2.0%** mean |

- **Engagement on the complex multi-user app DOUBLED** (5x5 ~18–21% → 41.3%),
  exactly the §4.7 payoff: the nested per-option→per-user collections that used
  to bump `ineligible_opkind` (50 bumps) now engage per-element via the runtime
  child re-dispatch (`ineligible_opkind` 0 in census), and the per-option
  wrappers / OptionSummaryRow `voters.map` interpret recursively.
- **Output EQUIVALENCE: PASS every run** — vote tallies (per-option green/yellow/red
  + user/option/vote counts) byte-identical OFF vs ON across all 6 arms. The
  interpreter does not change results.
- **Conflicts NOT a correctness ratchet:** `rejected=0` in EVERY run OFF and ON;
  `conflicts == reverts` throughout (the [[cfc-multibrowser-slowness-instrumentation]]
  signature of retry-that-succeeds, NOT a newer-seq stomp / storm). ON revert
  counts run somewhat higher than OFF and are noisy (3x3 ON 146–322, sometimes
  BELOW OFF; 5x5 ON ~706–790 vs OFF ~518–565) — genuine cross-session
  write-write ping-pong that #4237 already made cheap, no newer-seq stomp.

**FOOTPRINT verdict on lunch-poll — STILL FLAT (toward-a-win but not yet a win):**
the doc/node footprint on lunch-poll is essentially **FLAT** (docs within ±1%
mean, nodes +2% mean) despite engagement doubling — UNCHANGED in character from
the pre-§4.7 +2%. Engagement doubled but the footprint did NOT improve because
the dominant per-element footprint driver (PollOptionCard's interactive I/O rows
+ handler sinks) and the MAIN poll pattern's `__patternResult` self-reference are
STILL kept boundaries (the two DEFERRED items above). §4.7 lifted ENGAGEMENT on
the complex app (the goal it set out to deliver — the nested-collection recursion)
but the lunch-poll *footprint* win is gated on those two deferred increments
(§4.8 I/O-edge doc-consolidation, which is measured net-negative under concurrent
load until the conflict ratchet is removed; and `__patternResult` self-reference
handling). So: §4.7 DELIVERED the complex-app *engagement* win (DOUBLED), and the
complex-app *footprint* win remains explicitly deferred to §4.8.

**INTEGRATION aggregate (the simple-app corpus, fresh re-measure):**
- ENGAGEMENT (`interpreted_ok>0`): **143 / 146** distinct scenarios (147 census
  lines; `counterAggregator` appears twice) — UP from the pre-§4.7 **142/146**.
  `ineligible_opkind` 6→2 (CT-1334 and budgetPlanner/supportTicketTriage now
  engage via the §4.7 routing + the prior fan-out / bnd->bnd work). NOT-ENGAGED 3,
  all GENUINE non-core exceptions: `counterWithHandlerSpawn` (launched_child
  launcher contract), `counterWithConditionalBranch` (asCell-arg control
  predicate), `Cell<unknown> capture …` (cell-capture-diagnostic feeder — no
  output to materialize). fallback_by_reason summed: `launched_child` 14,
  `unresolved_leaf` 4, `ineligible_opkind` 2; `unrecognized_alias`/`eval_threw`/
  `scoped`/`cross_space`/`argument_writeback` all 0.
- FOOTPRINT (RI_FOOTPRINT_DUMP, OFF vs ON): scheduler nodes **2398 → 1764 =
  −634 (−26.4%)**; documents **2931 → 2939 = +0.3% (FLAT)**. Per-scenario: nodes
  reduced in 111, increased in 22 (small +1..+7 on trivial single-leaf patterns),
  flat in 13. UNCHANGED in character from the pre-§4.7 −26% nodes / flat docs —
  the integration node win held while engagement ticked up.

**DID §4.7 DELIVER THE COMPLEX-APP WIN?** YES for ENGAGEMENT (the stated §4.7
goal: nested-collection recursion to lift complex-app engagement — lunch-poll 5x5
~18–21% → 41.3%, DOUBLED, `ineligible_opkind` 50→0, output-equivalent, no
correctness ratchet). The complex-app FOOTPRINT win is NOT yet realized (lunch-poll
docs/nodes FLAT) and remains explicitly deferred to §4.8 (PollOptionCard I/O-edge
doc-consolidation + `__patternResult` self-reference), unchanged from the prior
§4.7 phase note. Still DEFERRED (and why): the two boundary drivers above
(§4.8 + result-self-reference) and the `resolveInner`/`b.inner` per-element
emission (the storming path — the runtime child re-dispatch is the sound
recursion and needs no `b.inner` emit). D-EMISSION-SCOPE honored: scoped /
cross-space per-element collections stay legacy fallback (census `scoped`/
`cross_space` = 0 on this corpus).

## §4.8 — VNode-doc consolidation on rendered maps (THE DOC HALF) — FINAL GATE (2026-06-25, this branch HEAD `d6b11688c`)

GOAL (Berni, AFK autonomous): land the DOC half of the `docs≈5+3N` tax that the
node-half work left FLAT. §4.8 (07 §4.8 + DECISIONS §D-VNODE-DOC-FRAGMENTATION):
a `.map` whose element renders a VNode subtree must write ONE consolidated
element-result doc, not fragment it per VNode node. The two bug fixes the task
called for (per-element doc shape + the over-conservative lowering gate) landed
in commit `d6b11688c`; this section is the standalone re-measure + gate that the
campaign's "measure real footprint honestly, never green-via-fallback" contract
requires. Engaging the consolidated per-element write + the broadened lowering
gate is exactly the §4.8 "desired red-with-partitions" — driven back to GREEN by
FIXING the doc shape + gate (NOT by widening fallback; the gate change NARROWS
fallback — it lowers MORE maps to `$ri-collection-map`).

**BUGS FIXED (both in `packages/runner/src`, commit `d6b11688c`):**
1. **Per-element doc SHAPE — VNode fragmentation** (`collection-interpreter.ts`):
   the per-element write was `elemResult.set(out)`, whose `recursivelyAddIDIfNeeded`
   stamps `[ID]` on every object-inside-an-array (a rendered VNode's `children`),
   which `normalizeAndDiff` then hoists into one entity doc PER nested VNode node
   (`tr`/`td`/`cf-vstack`/3×`span`) → the per-element result fragmented into ~6
   docs (the D-VNODE-DOC-FRAGMENTATION tax). FIX: write RAW consolidated, exactly
   legacy `updateResultProjection`'s primitive —
   `elemResult.setRawUntyped(fabricFromNativeValue(convertCellsToLinks(out)))` —
   so the whole VNode subtree stores INLINE in one element doc. Scalar/object
   element results (W3 `{doubled:N}`) are output-IDENTICAL (the object is the doc
   root, never an object-inside-an-array, so it already lived inline) — the
   docs/element slope only tightens.
2. **The ACTUAL default-app blocker — over-conservative lowering GATE**
   (`runner.ts` `tryLowerCollectionBoundaryNode` → `elementLeavesSurviveSerialization`):
   a transformer-compiled rendered row's inline `computed()`/`lift()` leaves
   serialize as module-level `__cfLift_N` lifts with NO `$implRef` *field* on the
   live in-builder module (that field is minted only at `moduleToJSON` time). The
   old gate checked `module.$implRef` directly → declined EVERY such element, so
   the notes map NEVER reached `$ri-collection-map` and each element ran as a full
   legacy CHILD PATTERN (the doc tax mis-attributed to "$ri-collection-map VNode
   fragmentation" was in fact the per-element child-pattern instantiation — the
   builtin was never reached). FIX: new `elementLeafImplRefResolvable` consults the
   SAME thing `moduleToJSON` uses to mint `$implRef` — the explicit field, else the
   live function's `getVerifiedProvenance` (content-addressed `{identity,__cfLift_N}`,
   keyed into the artifact index that SURVIVES the `getRaw()` round-trip). It
   DELIBERATELY EXCLUDES the host entry-ref (`host:N/fnN`): registry-/session-
   scoped, NOT content-addressed; a builder-direct `cf.str` resolves to it HERE
   yet the runtime builtin throws `unresolved element leaf ops` (a real gate↔runtime
   skew the LEVEL-1 coalescing-spike oracle catches). Per D-EMISSION-SCOPE we admit
   only what is provably recoverable post-serialization.

**GATES — ALL GREEN (no reds to fix; the two bug fixes above drove the §4.8
desired-red back to green before the commit; re-verified fresh on HEAD):**
- STATIC: `deno check` clean; `deno lint` clean (`runner.ts` +
  `reactive-interpreter/collection-interpreter.ts`); `deno fmt --check` no diff.
- INTEGRATION under flag (`CF_EXPERIMENTAL_INTERPRETER=1`,
  `generated-patterns/integration/patterns/*.test.ts`): **147 passed / 0 failed**
  — green WITH the interpreter engaged (NOT green-via-fallback; engagement census
  below).
- RI unit (`test/reactive-interpreter/*.test.ts`, flag-off): **40 passed / 0
  failed**.
- flag-OFF `packages/runner` `deno task test`: **698 passed / 0 failed** (HARD
  invariant — `$ri-collection-map` never registers flag-off + the lowering gate is
  on the interpreter dispatch path only; flag-off byte-unchanged).
- flag-ON `packages/runner` `deno task test`: **698 passed / 0 failed** — NO new
  reds. The three canary tests are GREEN: `pattern-scope` "map updates when
  derived list is narrowed by session input" + "ifElse selected VNode branch
  materializes map over session-derived list" (the per-element scope-label
  divergence the D-EMISSION-SCOPE guard fixes — the §4.8 lowering broadening did
  NOT reintroduce it) and `patterns-lift` "patterns returned by lifted functions".

**ENGAGEMENT (`RI_CENSUS_DUMP`, `interpreted_ok>0`):** **142 engaged / 144 census
lines** — at/above the §4.7 baseline (143/146), NO regression. NOT-ENGAGED 2, both
DOCUMENTED genuine exceptions: `counterWithConditionalBranch` (asCell-arg control
predicate), `counterWithHandlerSpawn` (launched_child launcher contract).
fallback_by_reason: `launched_child` 14, `unresolved_leaf` 3, `ineligible_opkind`
1; `unrecognized_alias`/`eval_threw`/`scoped`/`cross_space`/`argument_writeback`
all **0** — the §4.8 lowering broadening admitted NO scoped/cross-space element
(D-EMISSION-SCOPE guard holds).

**FOOTPRINT — THE DOC WIN LANDED (notes-list, the rendered-map corpus pattern):**
default-app notes bench OFF vs ON (`tools/default-app-interpreter-bench.ts
--notes=30,100`), output-EQUIVALENT (note count + titles identical):

| metric | OFF | ON | Δ |
| --- | --- | --- | --- |
| **docs/note (slope)** | **5.00** | **2.00** | **−60%** |
| docs @N=100 (abs) | 515 | 220 | −57% |
| nodes/note (slope) | 5.00 | 3.00 | −40% |
| wall-clock @N=100 | 10663ms | 9054ms | −15% |
| conflicts | 0 | 0 | flat |

The map lowers cleanly (census `interpreted_ok=1/1 fallback{none}`). **The DOC
half of the tax IS now reduced on rendered maps** — docs/note ON (2.00) < OFF
(5.00), the §4.8 success criterion (coalesced docs ≤ legacy on a rendered-element
pattern, oracle-verified output-equivalent). This is the headline §4.8 win: the
node-half work left docs FLAT; §4.8 makes the doc count DROP on the exact shape
(rendered `.map`) coalescing most wants to help.

**lunch-poll — output-EQUIVALENT, conflicts NOT a ratchet** (4 runs: 1 standalone
+ 3×; `tools/lunch-poll-interpreter-bench.ts --cases=3x3,5x5 --rounds=2`):
- **OUTPUT EQUIVALENCE: PASS every run** (vote tallies byte-identical OFF vs ON);
  `rejected=0` in EVERY arm OFF and ON; `conflicts==reverts` throughout (the
  retry-that-succeeds signature, NOT a newer-seq stomp / storm).
- 3x3 conflicts — OFF {139,224,143,155} mean ~165 vs ON {256,150,164,247} mean
  ~204; 5x5 conflicts — OFF {804,565,595,530} mean ~624 vs ON {638,853,748,1255}
  mean ~874. ON runs somewhat higher with WIDE overlap (ON dips BELOW OFF in
  several runs: 3x3 150<224, 5x5 638<804) — genuine cross-session write-write
  ping-pong #4237 already made cheap, **NOT the 4–10× `RI_F4_IO_COALESCE` ratchet**
  (that path stays gated default-off; §4.8 doc-consolidation does NOT engage the
  PollOptionCard I/O edge — lunch-poll engagement unchanged at 35–37%, the per-
  option/per-user collections engage via the §4.7 runtime child re-dispatch, not
  the §4.8 lowering). The elevated ON conflicts are the pre-existing §4.7 nested-
  recursion engagement, unchanged in character by §4.8.
- lunch-poll docs/nodes stay FLAT (3x3 docs +2.1% / nodes +4.9%; 5x5 docs −6.9% /
  nodes −2.4%; within run noise) — UNCHANGED from §4.7: lunch-poll's dominant
  per-element footprint driver (PollOptionCard's interactive I/O rows + handler
  sinks, and the MAIN poll pattern's `__patternResult` result-self-reference)
  remains a boundary, so the §4.8 rendered-map doc win (which lands on the SIMPLE
  notes-list map) does not reach it. The complex-app doc win stays deferred to the
  two boundary-driver increments (the I/O-edge read-isolation half, gated
  `RI_F4_IO_COALESCE` default-off because it ratchets conflicts; and
  `__patternResult` self-reference handling).

**§4.8 STATUS — DOC HALF DONE.** The rendered-map doc win LANDED and is oracle-
verified (notes-list docs/note 5.00→2.00, −60%, output-equivalent), the §4.8
gating precondition for the doc-win on rendered collections (07 §4.8) is
SATISFIED. All four gates GREEN (integration 147/0 engaged 142/144, RI unit 40/0,
flag-off 698/0, flag-ON 698/0). lunch-poll output-equivalent with no conflict
ratchet. The READ-ISOLATION / I/O-coalesce half (`RI_F4_IO_COALESCE`) stays OPEN +
gated default-off — a SEPARATE cross-document contention problem the doc-
consolidation half does not touch; engaging PollOptionCard's I/O edge is still
measured net-negative under concurrent load until that ratchet is removed.

### §4.8 FINAL MEASURE + GATE — standalone re-verification (2026-06-25, HEAD `f434f884d`)

Re-ran ALL gates + ALL benches FRESH (the campaign's "measure real footprint
honestly, never trust a written number" contract — [[proxy-metric-decoupling]]).
The §4.8 code was already committed (`d6b11688c`); nothing changed in this pass —
this is the verification the FINAL-GATE phase requires before push. Every number
below was measured on this branch HEAD now.

**GATES — ALL GREEN (re-measured fresh):**
- STATIC: `deno check` clean (`runner.ts` + `collection-interpreter.ts`); `deno
  lint` clean (7 files); `deno fmt --check` no diff.
- RI unit (`test/reactive-interpreter/*.test.ts`): **40 passed / 0 failed**.
- INTEGRATION under flag (`CF_EXPERIMENTAL_INTERPRETER=1`,
  `generated-patterns/integration/patterns/*.test.ts`): **147 passed / 0 failed**
  — green WITH the interpreter engaged (engagement census below).
- flag-OFF `packages/runner` `deno task test`: **698 passed / 0 failed** (HARD
  invariant held — `$ri-collection-map` never registers flag-off + the §4.8
  lowering-gate broadening is on the interpreter dispatch path only).
- flag-ON `packages/runner` `deno task test`: **698 passed / 0 failed** — NO new
  reds (the three §4.7 canary tests stay green; the §4.8 lowering broadening did
  NOT reintroduce the per-element scope-label divergence — D-EMISSION-SCOPE guard
  holds).

**ENGAGEMENT (`RI_FOOTPRINT_DUMP` per-line census, 147 lines / 146 distinct
scenarios, `counterAggregator` twice):** **143 engaged / 146 distinct** (the §4.8
FINAL-GATE section above reports 142/144 on a per-census-LINE basis; this is the
same corpus aggregated per DISTINCT scenario = 143/146, matching the §4.7 number —
NO regression, the difference is purely the aggregation unit). fallback_by_reason
summed: `launched_child` 14, `unresolved_leaf` 4, `ineligible_opkind` 2;
`unrecognized_alias`/`eval_threw`/`scoped`/`cross_space`/`argument_writeback` all
**0** (the §4.8 broadening admitted NO scoped/cross-space element). NOT-ENGAGED 3,
all DOCUMENTED genuine non-core exceptions: `counterWithConditionalBranch`
(asCell-arg control predicate), `counterWithHandlerSpawn` (launched_child launcher
contract), `Cell<unknown> capture …` (cell-capture-diagnostic feeder — no output
to materialize).

**PRIMARY METRIC — notes-list doc win (`tools/default-app-interpreter-bench.ts
--notes=10,30,100`), the §4.8 headline, output-EQUIVALENT (note count + titles
identical OFF vs ON, census `interpreted_ok=1/1 fallback{none}` at every N):**

| metric | BEFORE §4.8 | OFF | ON (AFTER §4.8) | Δ |
| --- | --- | --- | --- | --- |
| **docs/note (slope)** | **5.00 / 5.00 FLAT** | **5.00** | **2.00** | **−60%** |
| nodes/note (slope) | −20% (5→4) | 5.00 | 3.00 | −40% |
| docs @N=100 (abs) | (flat) | 515 | 220 | −57.3% |
| nodes @N=100 (abs) | — | 510 | 315 | −38.2% |
| wall @N=100 | — | 10760ms | 8829ms | −17.9% |
| conflicts | — | 0 | 0 | flat |

- **DID docs/note DROP? YES — the §4.8 DOC WIN.** BEFORE §4.8 the rendered-map
  docs/note was FLAT (OFF 5.0 / ON 5.0, the D-VNODE-DOC-FRAGMENTATION tax — the
  per-element VNode subtree fragmented into ~6 docs, and the lowering gate was so
  conservative the notes map ran each element as a full legacy child pattern and
  never reached `$ri-collection-map`). AFTER §4.8 docs/note ON **2.00 < OFF 5.00**
  — the doc half of the `docs≈5+3N` tax is now reduced on the exact shape
  (rendered `.map`) coalescing most wants to help. Output equivalence PASSES.

**lunch-poll (`tools/lunch-poll-interpreter-bench.ts --cases=3x3,5x5 --rounds=2`),
output-EQUIVALENT, NO conflict ratchet:**

| case | engaged | docs OFF→ON | nodes OFF→ON | conflicts OFF→ON (rejected) | wall OFF→ON |
| --- | --- | --- | --- | --- | --- |
| 3x3 | 35.3% (18/51) | 420→429 (+2.1%) | 1236→1246 (+0.8%) | 238→162 (rej 0/0) | 3876→3920ms (+1.1%) |
| 5x5 | 37.0% (50/135) | 615→623 (+1.3%) | 3107→3160 (+1.7%) | 785→816 (rej 0/0) | 10639→11878ms (+11.6%) |

- OUTPUT EQUIVALENCE: PASS (vote tallies byte-identical). `rejected=0` both arms
  OFF + ON; `conflicts == reverts` throughout (the retry-that-succeeds signature,
  NOT a newer-seq stomp). 3x3 ON conflicts (162) are BELOW OFF (238); 5x5 ON (816)
  vs OFF (785) is within run noise. The 5x5 wall +11.6% is one noisy run (this is
  a single-run measure; §4.7 saw 5x5 wall flat-to-negative across runs).
- **DID the per-element I/O coalesce become NET-POSITIVE? NO — honestly, not in
  this increment.** §4.8 delivered the DOC half (the consolidated `setRawUntyped`
  element-result write + the read-isolated `$ri-collection-map` per-element tx),
  which is exactly what the notes-list rendered map needs (−60% docs/note). But
  lunch-poll's footprint stays FLAT (±2%) because the §4.8 doc-consolidation lands
  on `$ri-collection-map`-lowered rendered maps (notes-list), and lunch-poll's
  dominant per-element footprint driver — **PollOptionCard's interactive I/O rows
  (`fetchData`/`generateText` + `castVote`/… handler sinks)** — does NOT go through
  that path: it is a handler-bearing per-element row kept a BOUNDARY by the F4
  write-back-cycle gate (`runner.ts:3457`). Engaging its I/O edge requires
  `RI_F4_IO_COALESCE=1`, which **stays gated default-off** because it is still
  MEASURED NET-NEGATIVE under concurrent multi-user load (the 4–10× conflict /
  2–6× wall ratchet on the hot shared poll doc). The read-isolation primitive the
  ratchet-removal needs now EXISTS on the `$ri-collection-map` path (the per-element
  read-isolated tx + consolidated doc), but it is NOT yet wired into the
  handler-bearing I/O-coalesce path, so that path stays default-off and the
  lunch-poll footprint win remains DEFERRED. The §4.8 increment makes the DOC half
  work where it can (notes-list) without regressing lunch-poll (output-equivalent,
  no ratchet) — it does NOT yet flip the I/O coalesce net-positive.

**INTEGRATION aggregate footprint (`RI_FOOTPRINT_DUMP`, OFF vs ON, summed over 147
census lines):**
- scheduler nodes **2398 → 1764 = −634 (−26.4%)**.
- documents (written) **2931 → 2939 = +8 (+0.3%) FLAT**.
- UNCHANGED in character from §4.7 (nodes −26.4% / docs flat). §4.8 did NOT improve
  the integration-aggregate docs: the realistic integration corpus carries no
  rendered-VNode element map that lowers to `$ri-collection-map` (its rendered-map
  scenarios already engaged via the legacy-boundary per-element child re-dispatch,
  not the §4.8 lowering), so the −60% doc win is specific to the default-app
  notes-list shape and does not move the integration sum. Honest: §4.8's doc win
  is real but narrow (the notes-list rendered-map shape), not corpus-wide.

**§4.8 FINAL VERDICT.** §4.8 DELIVERED THE DOC WIN on the rendered-map shape
(notes-list docs/note 5.00→2.00, −60%, oracle-verified output-equivalent — the
doc half of the tax the node-half work left FLAT). All gates GREEN (147/0 engaged
143/146, RI unit 40/0, flag-off 698/0, flag-ON 698/0), lunch-poll output-equivalent
with no conflict ratchet, integration nodes −26.4% / docs flat. The per-element I/O
coalesce did NOT become net-positive — `RI_F4_IO_COALESCE` stays default-off
(still net-negative under concurrent load); the read-isolation primitive now exists
on the `$ri-collection-map` path but is not yet wired into the handler-bearing I/O
path, so the lunch-poll complex-app footprint win stays explicitly DEFERRED.

## §4.9 — READ-ONLY CELL CONTEXT for asCell-input leaves (context-requiring leaves ENGAGED) — FINAL GATE (2026-06-25, commit `9b019c057` + fmt `a0948d6ca`)

GOAL (Berni, AFK autonomous): hand a context-requiring leaf (a pure lift/computed
whose INPUT SCHEMA is `asCell`/`asStream` — it takes a LIVE Cell/Stream handle to
call `.get()`/`.sample()`, not a value) a live READ-ONLY cell/stream VIEW so it
INTERPRETS, instead of falling back. Before this increment `resolveLeafImpls`
flagged every `asCell`/`asStream` input schema as `unresolved_leaf` via the
`schemaNeedsCellContext` gate — the dominant remaining lunch-poll gap
(`unresolved_leaf` ≈ 55 = these context leaves). This pushes on the
pure-evaluation boundary, so CORRECTNESS-FIRST: (a) WRITES (`.set`/`.send`/…) must
NOT be supported — a leaf that writes its asCell input stays an effectful fallback
boundary; (b) READS must JOURNAL through the segment tx so CFC content-labels
propagate (the pointwise-label oracle) AND so the leaf re-runs reactively on
change; (c) output must be byte-equivalent to legacy.

Engaging these context leaves was the "desired red-with-partitions"; driven back to
GREEN by FIXING the read-only-view semantics + eligibility (NOT by widening
fallback — fallback NARROWS: a context leaf the runner proves argument-fed +
read-only now ENGAGES where it used to be unresolved).

**MECHANISM (the sound one — all flag-ON only; flag-OFF byte-unchanged):**
- **`cell.ts` — read-only VIEW primitive.** `readOnly(reason)` returns a frozen
  SIBLING (shares identity/link/**tx**/schema/`_cfcLabelView`; the original keeps
  its writable handle for handler boundaries). The advisory `readOnlyReason` becomes
  an ENFORCED write barrier (`throwIfReadOnly`): `set`/`send`/`update`/`push`/
  `setRawUntyped`/`setMetaRaw` throw, and the barrier PROPAGATES through `.key()`/
  `.asSchema()`/`.withTx()`/`.asSchemaFromLinks()` so a write cannot escape via a
  sub-cell. Inert when unset (every legacy path → byte-unchanged). Because the
  sibling shares the segment `tx` + `_cfcLabelView`, `.get()`/`.sample()` JOURNAL
  reads through the tx exactly as a normal read → CFC + reactivity parity by
  construction (no special-casing).
- **`extract.ts` — eligibility SPLIT.** The `schemaNeedsCellContext` gate is split:
  a context leaf resolves (read-only) ONLY when the runner proves it eligible
  (`readOnlyCellLeafOps` set) AND its source does not write its input
  (`liveLeafWritesCellInput` scan: `set`/`send`/`update`/`push`/`setRaw*`/
  `setMetaRaw`/`exec`). A write-capable context leaf stays a legacy boundary. Empty
  set ⇒ byte-for-byte prior behavior (all existing callers — flag-off runner, unit
  tests, the element evaluator — pass no set, so EVERY context leaf stays
  unresolved). Nested-pattern leaves are the child's own op-id space → never matched
  → stay legacy boundaries (out of scope, deferred).
- **`runner.ts` — argument-fed vetting + view installation.**
  `computeArgumentFedContextLeaves` vets each context leaf: engage ONLY leaves whose
  asCell input fields are fed by PATTERN-ARGUMENT refs (`{kind:"argument"}` — the
  only place the deep-resolved arg tree surfaces a LIVE handle) AND whose pattern-arg
  path actually surfaces a handle (`argumentPathNeedsCellContext`). An
  internal/opOut/const-fed asCell input resolves to a PLAIN value → `.get()` would
  throw → EXCLUDED (2(b), deferred, stays legacy). `withReadOnlyCellInput` wraps
  each engaged leaf's impl so its handle inputs are made read-only at call time
  (`makeLeafInputReadOnly` structural walk); a missed write throws → the
  interpreter isolates the op to `undefined` + reports `onError` (legacy parity,
  never a silent mis-write).
- **`interpret.ts` — control-predicate unwrap.** `unwrapCellForValue` hook unwraps a
  Cell handle for an `ifElse(enabledCell,…)` control PREDICATE via a tracked
  `.get()` (so the predicate sees the boolean VALUE, not a truthy HANDLE). Pure
  leaves keep the handle; construct/access pass it through. This is what engages
  `counterWithConditionalBranch` (the asCell-arg control predicate that was the
  long-standing documented exception).

**BUGS the engagement required FIXED (correctness-first, all fail-CLOSED):** the
desired-red was driven back to green by the four soundness fixes above — the
read-only-view write barrier + sub-cell propagation (a write must not escape), the
argument-fed handle-availability vetting (an internal/const-fed asCell surfaces a
plain value, not a handle — `.get()` would throw, so EXCLUDE), the
`liveLeafWritesCellInput` effectful-leaf gate (a writing leaf stays a boundary),
and the control-predicate `.get()` unwrap (an `ifElse(handle)` must see the
boolean). NO leaf was kept as a fallback unless it genuinely WRITES its input or its
asCell input is not argument-fed (no handle available — 2(b), a precise tracker
note, deferred). Engagement is monotonic (every new path is additive + fail-closed;
the empty-set default is byte-for-byte prior behavior).

**GATES — ALL GREEN (re-measured fresh on HEAD `a0948d6ca`):**
- STATIC: `deno check` clean; `deno lint` clean; `deno fmt --check` no diff
  (`runner.ts` + `cell.ts` + `reactive-interpreter/{extract,interpret}.ts`).
- INTEGRATION under flag (`CF_EXPERIMENTAL_INTERPRETER=1`,
  `generated-patterns/integration/patterns/*.test.ts`): **147 passed / 0 failed** —
  green WITH the interpreter engaged (verified by the census below, NOT
  green-via-fallback).
- ENGAGEMENT (`RI_CENSUS_DUMP`, `interpreted_ok>0`): **145 engaged / 147 census
  lines** — UP from the §4.8 baseline of 143/146. `counterWithConditionalBranch`
  (asCell-arg control predicate) + one further context leaf now interpret.
  `unresolved_leaf` 4→**3**; `unrecognized_alias`/`eval_threw`/`scoped`/`cross_space`/
  `argument_writeback` all **0**. NOT-ENGAGED 2, both DOCUMENTED genuine exceptions:
  `Cell<unknown> capture …` (cell-capture-diagnostic feeder — no output to
  materialize) and `counterWithHandlerSpawn` (launched_child launcher contract).
- RI unit (`test/reactive-interpreter/*.test.ts`): **41 passed / 0 failed** (flag-on
  + flag-off; up from 40 — `leaf-scan-precision.test.ts` expanded). **CFC ORACLE
  GREEN:** `collection-interpret.test.ts` test (3) pointwise labels — interpreted
  per-element confidentiality labels BYTE-IDENTICAL to legacy
  (`mapped[0]=["alice-secret"]`, `mapped[1]=["bob-secret"]`, `[2]/[3]` empty; no
  smear); `spike-cfc-oracle.test.ts` — read-isolated coordinator keeps POINTWISE
  labels (OQ-4), smear-detector + sibling-read teeth hold. The read-only view's
  reads journal the source label through the segment tx → NO CFC regression.
- flag-OFF `packages/runner` `deno task test`: **700 passed / 0 failed** (HARD
  invariant held; count moved 698→700 only because the increment ADDED
  `cell-readonly.test.ts` + expanded `leaf-scan-precision.test.ts`, never a
  regression — the read-only barrier is inert with no `readOnlyReason` set).
- flag-ON `packages/runner` `deno task test`: **700 passed / 0 failed** — NO new
  reds (matches flag-off at 700/0).

**§4.9 PRIMARY METRIC — lunch-poll 5x5 (`tools/lunch-poll-interpreter-bench.ts
--cases=5x5 --rounds=2`), the dominant context-leaf corpus:**

| metric | BEFORE §4.9 (§4.7/§4.8) | AFTER §4.9 | Δ |
| --- | --- | --- | --- |
| **engaged (`interpreted_ok`)** | **~37% (50/135)** | **55.6% (75/135)** | **+18.6pp (engagement DOUBLED vs the §4.7 ~18–21% floor)** |
| `unresolved_leaf` (census) | 55 | **25** | −30 (the context leaves now interpret) |
| docs written | 636 (OFF) | 623 (ON) | **−2.0%** |
| scheduler nodes | 3091 (OFF) | 3014 (ON) | **−2.5%** |
| wall-clock | 10961ms (OFF) | 9318ms (ON) | **−15.0% (ON faster)** |
| conflicts (rejected) | 605 (OFF, rej 0) | **423 (ON, rej 0)** | ON LOWER — NO ratchet |

- **OUTPUT EQUIVALENCE: PASS** — vote tallies byte-identical OFF vs ON (10 votes
  each arm). The interpreter does not change results.
- **NO conflict/wall ratchet** — `rejected=0` both arms, `conflicts==reverts` (the
  retry-that-succeeds signature, NOT a newer-seq stomp/storm); ON conflicts (423)
  are BELOW OFF (605) and wall is −15%. The context-leaf engagement is a pure-read
  win (read-only views, no extra writes) — it does NOT touch the PollOptionCard I/O
  edge (still a boundary), so it does not ratchet.

**§4.9 VERDICT — ALL TARGETS MET.** The dominant remaining gap (context-requiring
leaves, lunch-poll `unresolved_leaf` ≈ 55) is ENGAGED via the read-only cell/stream
VIEW: reads journal through the segment tx (CFC + reactivity parity, oracle-green),
writes are blocked (effectful leaves stay boundaries), output is byte-equivalent.
Integration 147/0 engaged 145/147 (UP from 143/146), RI unit + CFC oracle 41/0,
flag-off 700/0, flag-ON 700/0, lunch-poll 55.6% engaged (DOUBLED) output-equivalent
with conflicts/wall DOWN (no ratchet). The only context leaves still falling back
are the precise tracker exceptions: WRITE-capable leaves (effectful), and
internal/opOut/const-fed asCell inputs (2(b) — no live handle in the arg tree;
deferred). Nested-pattern context leaves (child op-id space) also stay legacy
boundaries (deferred). NONE is a core gap.

**§4.9 INDEPENDENT RE-VERIFY (FINAL GATE re-measured fresh on HEAD `f04229256`, no
working-tree changes — confirms the committed state, NOT a new increment):** every
gate re-run from scratch and CONFIRMED.
- STATIC: `deno check` clean; `deno lint` clean (6 files: `runner.ts` + `cell.ts` +
  `reactive-interpreter/{extract,interpret}.ts` + `test/cell-readonly.test.ts` +
  `test/reactive-interpreter/leaf-scan-precision.test.ts`); `deno fmt --check` no
  diff (no re-commit needed).
- INTEGRATION under flag: **147 passed / 0 failed**; ENGAGEMENT **145 engaged / 147
  census lines** (= 144/146 distinct scenarios; `counterAggregator` twice), UP from
  the §4.8 baseline 143/146. `unresolved_leaf` **3**, `ineligible_opkind` 2,
  `launched_child` 14; `unrecognized_alias`/`eval_threw`/`scoped`/`cross_space`/
  `argument_writeback` all 0. `counterWithConditionalBranch` ENGAGED
  (`interpreted_ok:1`, all fallback reasons 0) — the asCell-arg control predicate
  context leaf the increment targets. NOT-ENGAGED 2 (both documented genuine
  exceptions): `Cell<unknown> capture …` (cell-capture-diagnostic feeder, no output
  to materialize) + `counterWithHandlerSpawn` (launched_child launcher contract).
- RI unit `test/reactive-interpreter/*.test.ts`: **41 passed / 0 failed** (flag-ON).
- CFC POINTWISE ORACLE (the correctness gate for this increment) — **GREEN, named +
  byte-verified:** `collection-interpret.test.ts` test **(3) "pointwise labels:
  per-element secrets stay on their own index, parity with legacy"** PASSES — fresh
  output confirms `interp mapped = [2,4,6,8]` == `legacy mapped = [2,4,6,8]` AND
  `interp mapped[0] conf = ["alice-secret"]`, `[1] = ["bob-secret"]`, `[2]/[3] = []`
  — BYTE-IDENTICAL to legacy, NO cross-element smear. The read-only view's `.get()`
  reads journal the source label through the segment tx → per-path content labels
  propagate, no CFC regression. (The `spike-cfc-oracle.test.ts` name in the prior
  note is a stale working title; the pointwise oracle lives in
  `collection-interpret.test.ts` test (3), and the smear-detector/sibling-read teeth
  ride the same file's (1)+(2) parity step, also green.)
- flag-OFF `packages/runner` `deno task test`: **700 passed / 0 failed** (HARD
  invariant held). flag-ON `packages/runner` `deno task test`: **700 passed / 0
  failed** (no new reds; matches flag-off).
- LUNCH-POLL `--cases=3x3,5x5 --rounds=2` (fresh): **5x5** votes 10/10
  **equivalent=YES**, engaged **75/135 (55.6%)** `unresolved_leaf` **25**, docs OFF
  622/ON 625, nodes OFF 3139/ON 3034 (**−3.3%**), wall OFF 11180ms/ON 9652ms
  (**−13.7%, ON faster**), conflicts OFF 808/ON 422 (**rejected 0 both arms**, ON
  LOWER — NO ratchet). **3x3** votes 6/6 equivalent=YES, engaged 27/51 (52.9%)
  `unresolved_leaf` 9, docs −1.2%, nodes +1.5%, conflicts OFF 124/ON 136 (rejected 0
  both), wall +28.1% (3x3 is small/single-run noisy — the 5x5 scaled case is the
  representative measure). The footprint deltas sit in the prior-note's run-to-run
  noise band (the doc-written Δ floats ±2% around flat; nodes −2.5..−3.3%; wall
  −13.7..−15.0%); ALL conclusions hold: engagement DOUBLED + held at 55.6%, output
  byte-equivalent, NO conflict/wall ratchet.
- RE-VERIFY VERDICT: the §4.9 committed state is CONFIRMED on a clean fresh measure —
  context leaves ENGAGED (`counterWithConditionalBranch` + lunch-poll's 30
  context leaves), output-equivalent, CFC pointwise oracle byte-identical, no
  ratchet, all suites green. No working-tree change; already committed
  (`9b019c057`/`a0948d6ca`/`f04229256`) and pushed to
  `origin/claude/nervous-kilby-83b75b`.
