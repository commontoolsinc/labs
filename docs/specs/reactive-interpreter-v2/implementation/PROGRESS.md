# Reactive Interpreter v2 — Progress

One row per work order; log entries newest-last. Every landed row carries
measured numbers (OFF vs ON, same commit) once W3 exists.

## Status

| WO | Status | Measured outcome |
| --- | --- | --- |
| W0 — plan + decisions | ✅ done (`804f881b7`) | — |
| W1 — IR v2 core | ✅ done (`667ecf1bd`) | rog.ts + unit tests; internals table-indexed; normalized control tags |
| W2 — builder-born ROG | ✅ done (`b01b75554`) | Zero-recognition front-end at pattern() finalization (WeakMap side-table); str→interpolate native; unknown refs fail-closed to effect boundaries; full runner suite 738/0 with construction ALWAYS-ON (baseline parity) |
| W3 — flag-on dispatch + measurement harness | ✅ done (runner level) | W3a–W3f (`88d139fba`…`886ee0a8b`). Vertical slice green; differential + fallback oracles; measurement harness. Numbers (compute-heavy pure pattern): **nodes −58–64%, docs flat/−1, wall −70–75%**, census interpreted. Flag-ON triage 27→15→4→**1** (only reload-sibling-overdirty: legacy-topology introspection + interpreter-node REHYDRATION IDENTITY, tracked follow-up). **Flag-OFF 738/0** (byte-clean). Gates landed: liveTrusted leaf trust (SECURITY), leaf caps (instantiatesPattern/needsCellContext/writesInput; v1's schema suppression DROPPED as unsound), scope_narrowing + narrowest-read-scope threading (opt-in raw marker), control_reference_semantics (links vs values — emission follow-up), no_node_ops cost gate, pattern-inline reverted to opt-in (piece-identity contract). |
| W4 — multi-segment emission | ✅ done (`ba7bef58c`…`ab87218b7`) | Segments coalesce around VERBATIM legacy boundary nodes (handler/effect/control/collection/pattern/gated-leaf) — the original alias topology IS the wiring (v1 F1/F2/F3 dissolve by construction). **Full corpus census (generated-patterns, flag-ON, all green): 122/180 patterns interpret (67.8%); on engaged patterns 59.3% of node ops collapse; 1281 legacy actions → 845 scheduler nodes (−34%)**. Fallbacks: nothing_to_collapse 33 (cost gate), no_rog 14 + incomplete 10 (engagement headroom), scope 1. Fix trail: ungated leaves (argumentSchema===false bypass), schema-bound per-leaf reads for fully-external leaves (legacy readJavaScriptArgument parity — cleared calendar/proxy-length/reading-list). pattern-tests flag-ON **84/84**; chat sim flag-ON 12/0 (4.8s); runner flag-ON 737/1 / flag-OFF 738/0; root test all-pass; root integration 7/7. Collections per-element path moves to the next WO. |
| W5a — inline map coordinator | ✅ done (`83835b141`+) | **The doc-explosion law breaks**: eligible pure-element maps evaluate per-element via evalRog (live BuiltRog from construction — the no_rog serialization boundary never applies). Measured N=10: **docs 54→24 (−56%), nodes 46→26 (−43%), wall −70%**, byte-equal. Legacy-parity mechanics: element-identity keyed runs (results follow elements across inserts), same cell causes, pointwise per-element txs, consolidated raw writes, resume guard, CT-1623 by-identity op protocol (ri2SubstituteOpRefs), loud non-array/sentinel errors, MONOTONIC DEGRADE to the real legacy map builtin for scoped lists/elements (D-EMISSION-SCOPE enforced dynamically). Gates: runner flag-ON **737/1** (pre-tracked reload item only) / flag-off 738/0; pattern-tests flag-ON 84/84; generated-patterns green; chat sim 12/0. Corpus: engagement 71.1%, inline refusals 0. filter/flatMap + nested-inline (consumed-as-value) next. |
| W6 — consumed-as-value nested inline | ✅ done (`fcab6ca96`) | A nested pattern op inlines (evalRog in-segment, ZERO child docs — the child's value flows through the parent's existing cells) when the child is fully inlinable AND no reference RETAINS its output (result tree, effect/collection/pattern refs + write targets, transitively-retained constructs → boundary, the piece contract). Differential green: value-consumed child inlines, result-retained sibling stays exactly one pattern boundary, byte-equal. Gates: runner flag-ON 737/1 / root flag-off all-pass; pattern-tests 84/84; chat sim 12/0. |
| W5b — transformer native ops | ⬜ | — |
| W6 — function lowering | ⬜ | — |
| W7 — suites + chat sim + measurements (continuous) | 🟡 green at every milestone so far | **Root `deno task test` flag-off: ALL PASSING (207.5s; baseline 210.5s — no construction cost).** **Root integration 7/7** (after the str un-hoist fix; cli suite needed a pre-existing deno.jsonc fix reproduced broken on main). **Chat sim flag-ON 12/0 in 5.4s** — the v1 ~226× pathology does NOT reproduce (conservative gates keep group-chat legacy). Runner: flag-off 738/0, flag-ON 737/1. |

Legend: ⬜ not started · 🟡 in progress · ✅ done · ⛔ blocked.

## Baselines to beat (v1-measured, from #4298)

- Legacy law: docs ≈ 5 + 3N, nodes ≈ 8 + 4N per collection pattern.
- v1 flag-on results (the bar): interpretable-op engagement 88.4%
  (integration corpus), nodes −26→−33%, docs −34%, rendered lists −60%
  docs / −40% nodes per element, lunch-poll wall −7–14%.
- v1 pathologies (must NOT reproduce): cfc-group-chat multi-user flag-on
  ~226× timeout; F4 I/O-coalesce conflict ratchet.

## Log

- (2026-07-02) Campaign start. Branch = main(0cf48b278) + v2 spec
  (7c47ece87). Baseline root `deno task test` kicked off; builder recon in
  flight; W0 docs this entry.
- (2026-07-02) Baseline pinned: root `deno task test` 210.5s, all green.
  Builder recon: pattern identity is content-addressed from serialized bytes
  → D-V2-ROG-SIDETABLE (WeakMap, never serialized); compiled patterns
  execute builder calls at module load → builder front-end covers them.
- (2026-07-02) W1 landed (`667ecf1bd`): rog.ts v2 + unit tests.
- (2026-07-02) W2 landed (`b01b75554`): builder-born ROG at pattern()
  finalization; str hoisted + native interpolate; tagged control; unknown
  refs fail-closed to effect boundaries. Runner package suite **738/0**
  with construction ALWAYS-ON (regression gate green).
- (2026-07-02) W3a landed (`88d139fba`): evalRog v2 (v1 semantics ported;
  indexed internals; ONE normalized control rule; recursive children).
  End-to-end green over builder-born ROGs.
- (2026-07-02) W3b landed (`b8ff8088e`): partition v2 (structural recursion,
  principled external-internal inputs, pure-nested-pattern inline;
  D-V2-F4-DEFER + D-V2-PURE-PATTERN-INLINE recorded).
- (2026-07-02) W3c landed (`6acd8702d`, measurement `8cb0c7597`): flag-on
  dispatch, single-segment increment. Synthetic `{type:"raw"}` node whose
  outputs binding maps op ids → the ops' ORIGINAL serialized aliases (one
  sendResult == the N legacy writes). Runner diff ~15 lines. Differential
  oracle green; first numbers: nodes −64%, docs −1, wall −75% (shape:
  6 lifts + 2 str + ifElse).
- (2026-07-02) **Flag-ON corpus triage (full runner suite, 711/27).**
  Failure classes, mapped to v1 precedents:
  1. **SES security regressions ×3** — leafImpls captured at build time run
     WITHOUT the trust gate legacy applies at resolution
     (`resolveJavaScriptFunction` liveTrusted). FIX FIRST (security): dispatch
     admits a leaf only if it passes a runner-supplied trust predicate
     (v1 interpreterLiveLeafTrustCheck idiom); else unresolved-leaf boundary
     → fallback.
  2. **Leaf caps gates missing** — "patterns returned by lifted functions",
     "named cell inside a lift", "sample()", Schemas ×2 (asCell handles):
     need v1's static scans as capture-time caps (instantiatesPattern /
     needsCellContext / async) + a builder frame (runtime+tx) pushed around
     evalRog so cell() inside a lift body works.
  3. **ifElse semantics ×3** — legacy builtin writes a branch REFERENCE
     (write-once on re-trigger); the control op resolves values. Includes an
     action-NAMING introspection test (possible test-artifact class).
  4. **Dynamic patterns ×5** — derive-returning-pattern (CT-1316) + dynamic
     instantiation: dynamic module → must stay legacy (gate probably missing
     a dynamic-module case at dispatch).
  5. **reload-sibling-overdirty + scheduler event receipts** — synthetic-node
     rehydration/identity semantics; investigate.
  6. **Stack traces ×2** — error-frame parity (the documented onError gap).
  Strategy (v1's proven move): add capture/dispatch gates so classes 1/2/4
  fall back fail-closed → drives flag-ON green while census keeps honest
  engagement; then re-admit classes with proper support.
- (2026-07-02) **Triage complete: flag-ON 27→15→4→1** (W3d `fb12b5f98`,
  W3e `87c28a75e`, W3f `886ee0a8b`, stdout fix `3e9388741`). Landed: trust
  gate; leaf caps (v1 schema-suppression DROPPED as unsound — a typed
  factory-application lift is a silent wrong value); scope: narrowest-read-
  scope threading behind an opt-in raw-module marker + per-run reset
  (pattern-scope 39/0); control_reference_semantics gate (legacy ifElse
  writes a resolved LINK with onlyIfDifferent through its own minted cell —
  faithful emission deferred; in multi-segment emission control ops can stay
  legacy BOUNDARY nodes, recovering those patterns without link-emission);
  no_node_ops cost gate; pattern-inline reverted to opt-in (a handler-built
  child pushed into a list must be an addressable PIECE — value-inlining
  broke it). Remaining 1: reload-sibling-overdirty (legacy-topology
  introspection + interpreter-node rehydration identity — real follow-up).
  Env-flag stdout pollution fixed (override log = caller-passed only, on
  stderr; cli dev green both flags). NEXT: multi-segment emission (segments
  + preserved boundary nodes — the engagement unlock for handler/control/
  effect patterns), then W4 collections.

- (2026-07-03) **W4 multi-segment MILESTONE.** Emission = segments +
  verbatim boundaries; control ops preserved (D-V2-CONTROL-MODERNIZE);
  gated leaves demoted to boundaries instead of pattern-wide fallback.
  Two evaluator-parity fixes found by the pattern-tests corpus: (1)
  `ungated` leaves — the transformer's capture-less computeds are
  lift(fn, false) and legacy's argumentSchema===false bypass runs them
  with undefined (fetch-delay's url starved without it); (2) schema-bound
  per-leaf reads — fully-external leaves read their ORIGINAL alias tree
  through their own argumentSchema (defaults/validation), fixing the
  transient-partial-input throw class. Full gate green (see W4 row).
  NEXT: engagement headroom (no_rog 14 = plain-JSON patterns without live
  factory; incomplete 10 — census the reasons), W5 transformer native ops
  (D-V2-STR-DIRECT), collections per-element docs, rehydration identity.

- (2026-07-03) **W5a inline map MILESTONE.** Per-element child patterns
  gone on eligible maps; doc law broken (−56% docs, −43% nodes, −70% wall
  N=10). Corpus fix trail: derivation-aware side-table for the
  traverse-utils op clone (strict lookup kept for dispatch — positional
  node correspondence); usage from the element ROG incl. the RESULT
  expression (pure projections have zero ops); element-identity keying
  (mid-list inserts); monotonic degrade to the REAL legacy builtin for
  scoped lists (same signature + container cause = seamless); CT-1623
  by-identity sentinel protocol preserved + loud misses; non-array loud
  error. NEXT: nested-pattern inline w/ consumed-as-value (the doc savings
  Berni flagged: not everything materialized in a nested call needs
  materialization), filter/flatMap, no_rog/incomplete headroom, W5b
  transformer native ops (D-V2-STR-DIRECT).

- (2026-07-03) **W6 consumed-as-value nested inline landed** (`fcab6ca96`).
  **PR #4514 OPEN** (github.com/commontoolsinc/labs/pull/4514): CI green
  except the coverage RATCHET (new module tree's fail-closed branches are
  line-uncovered) — accepted via the narrow NEW_PERF_BASELINE coverage-debt
  marker in the PR description + job rerun; Check job fixed (fmt + unused
  imports). Shepherding continues per bot feedback. NEXT: filter/flatMap on
  the inline chassis, no_rog(14)/incomplete(10) headroom, W5b transformer
  native ops (D-V2-STR-DIRECT), rehydration identity.

- (2026-07-03) **FLAG-ON FULLY GREEN MILESTONE.** (1) External-cell refs
  landed → `incomplete` census class 10→0 (external ValueRef + per-Rog
  externals table binding the exact legacy reference form). (2) The LAST
  flag-ON failure resolved: probed the interpreter segment action's
  persisted scheduler snapshot — id `raw:ri2:seg…` STABLE across runtimes,
  persisted CLEAN (no directDirtySeq/staleSeq), reload rehydration HITS
  (ok>0, missNoSnapshot=0, no re-run); the CT-1623 reload guard is now
  flag-aware (1 clean segment snapshot vs 3 computed snapshots). RESULT:
  **root `deno task test` ALL PACKAGES GREEN under
  CF_EXPERIMENTAL_INTERPRETER=1** (223.6s) — flag-ON == flag-off across the
  monorepo. Remaining non-marginal gaps: filter/flatMap inline (~11% of
  reactive collection usage), W5b transformer native ops (hygiene — live
  capture already removed SES from the interpreted path), function
  lowering (the W6 arc), control link-emission (engagement).

- (2026-07-03) **PR #4514 bot-review round addressed** (4 findings, each
  real): params-change element re-runs (subscription declares the params
  address), element-error surfacing to scheduler.onError (throw after the
  consolidated write), the resume-input blank (full awaitInputThenSettle
  port incl. the confirmed-empty SETTLE half — the first fix deferred
  forever and the resume-input-settle suite caught it), const-snapshot
  semantics (structuredClone; unclonable → incomplete). Root suite green
  BOTH flags after; pattern-tests 84/84, chat sim 12/0, generated-patterns
  green, CI green with the coverage-debt override. Remaining non-marginal:
  filter/flatMap inline (~11% of reactive collection usage), control
  link-emission, W5b native ops, W6 function lowering.

- (2026-07-06) **W5b inline FILTER landed** (`d0d46c7fe` + CFC fix
  `c304e88db`). Same chassis as inline map, but the coordinator keeps the
  ORIGINAL element links where a per-element predicate cell settled truthy
  (undefined = pending, legacy two-pass convergence); resumed coordinators
  degrade to the legacy builtin immediately; flatMap stays a verbatim
  legacy boundary (marginal share — record in DECISIONS). Two traps worth
  remembering: (1) a python string-replace silently failed and dispatch
  kept wiring the MAP implementation for filter ops — containers full of
  predicate booleans; always grep after scripted edits. (2) Flag-ON root
  suite caught a REAL CFC hole the differential test can't see: the two
  §8.5.6.1 pointwise tests isolating the container's OWN stamp (shape-only
  reader, empty result) failed because all predicate evaluation was
  deferred to effects — the coordinator's first container write carried an
  empty per-tx join, and later membership diffs never touch the root
  (slot-path-only writtenPaths; `[]`→`[]` is a value no-op). Legacy's
  guarantee is BATCH FIRST-INSTANTIATION: predicates run inline in the
  pattern-run tx, so the first root write joins every considered element's
  label (coarse), refining pointwise afterwards. Fix mirrors that exactly:
  an element's FIRST predicate evaluation runs inline in the coordinator's
  tx (content read deliberately journaled), then hands off to the
  pointwise effect. Side benefit: filter settles in one pass. Post-merge
  with origin/main (#4436 content-addressed action ids; flag-aware
  snapshot-filter resolution in the CT-1623 reload test). Gates: interpreter
  suite 47 steps green, full post-merge sweep running.

- (2026-07-06) **Post-merge flag-ON repairs** (`80644bd53`). The origin/main
  merge (CFC observation classes C1/C3/C4 #4523/#4525/#4541 + content-
  addressed action ids #4436) surfaced five flag-ON failures; all
  root-caused, all fixed:
  (1) C1 followRef smear — probe-scoped asCell slot resolution's terminal
  probe at the element root belongs to no recorded dereference and now
  CONTRIBUTES the target's label; coordinators build identity-only slot
  links from raw slots (bare resolveLink probes self-exempt), with the
  list's schema STRIPPED from element links (an array schema at an element
  path reads undefined). (2) Map's list-root read UNMARKED (value-class
  reads don't consume per-slot link-origin labels; probe-marking made it a
  followRef consumer). (3) Filter run-count parity: fresh runs register
  triggers only (scheduler.resubscribe) — the effect's initial run had
  doubled every predicate after batch-first-pass. (4) Filter resume (red
  since the inline filter landed, hidden by an earlier truncated-grep
  extraction — the lesson held): identity-form elementKeys EQUAL legacy's
  cellIdentityKey form, so predicate cells ARE the docs a degraded
  coordinator's legacy children resolve; load-bearing because the degraded
  batch reconcile is revertible and legacy never re-runs deduped children.
  (5) #4436's src-garble tests pinned flag-OFF (they characterize legacy
  module-action minting; segments never mint from module identity).
  Debug recipe that cracked (1)/(2): temp [cfcobs]/[cfcflow] dumps in
  prepare.ts (per-observation consumption + per-target J/writtenPaths).
  KNOWN RESIDUAL (tracked): resume-append-exclusion flag-ON leaves one
  unattributed pending promise at process exit (test green, flag-OFF
  clean, needs held-window+flag-ON; suspects exonerated: resubscribe
  cancel, unmarked reads, SM closes; candidate: scheduler
  awaitSpaceSyncedWithTimeout's deliberately-orphaned synced()).

- (2026-07-06) **TRANSIENT COLLECTIONS LANDED** (`cb32e2e10`,
  D-V2-TRANSIENT-COLLECTIONS — Berni's "inner map/filter" gap, same-day).
  Value-consumed map/filter/flatMap evaluate SEGMENT-RESIDENT: zero
  container docs, zero per-element docs, zero coordinator actions; chained
  pipelines cascade via the fixpoint retention walk (an admitted candidate
  stops retaining its list input). flatMap UNLOCKED in the transient path
  (no slots to re-key in memory — amends D-V2-FLATMAP-LEGACY, which now
  governs only MATERIALIZED flatMap). Legacy contribute parity pinned by
  differentials (flatMap: array→spread, defined non-array→value itself —
  the first draft guessed "skip non-arrays" and the differential caught it
  immediately). Retained outputs keep the materialized inline coordinators
  (incremental updates). Gates: runner 773/773 ON + 774/774 OFF,
  pattern-tests 87/87 ON, generated-patterns ON, chat sim 12/0 ON.
  Also this session: const doc-fixed-point gate (`edb624ab9`, cubic P1
  refuted+hardened, replied), resumed instantiations keep ORIGINAL legacy
  collection nodes (dispatch `resumed` refusal), second catch-up merge
  (C4/C5 observation classes — all three new CFC suites green flag-ON).
  Remaining gaps: scope flow-tracking (designed, task open), exit-leak in
  resume-append flag-ON (tracked, isolated), W5b native ops, W6 function
  lowering, control link-emission.

- (2026-07-07) **SCOPES LANDED** (`da01f15ee`, D-V2-SCOPES-PER-OP — the
  second of Berni's two gap briefs, same session as transient
  collections). The pattern-wide scope_narrowing refusal is GONE: scoped
  data interprets, routed exactly like legacy per-node actions. Per-op
  scope lattice in evalRog (seed scopes by link RESOLUTION — journal
  invariance is load-bearing, a per-key read restructure broke a scoped
  resume test), per-op RUN BRACKETS (leaf inputs are lazy proxies — the
  scoped deref happens inside leaf bodies; seed-time capture alone
  observes nothing), per-key write routing (ri2PerOpOutputScopes
  side-channel → sendValueToBinding per output key), and a SCOPE-ACCURATE
  per-tx Cell.get() cache (entries record + replay the fill's narrowest
  scope; closes a latent legacy under-narrowing hazard in warm batch txs).
  Sibling differential pins the per-op property (scoped sibling narrows +
  redirects, plain sibling stays space); a second differential pins that
  legacy's simple path IGNORES static scope on plain-value lifts. The
  ENTIRE pattern-scope oracle suite (39) passes flag-ON while
  interpreting. Gates: runner 773/773 ON + 774/774 OFF, root both flags,
  pattern-tests 87/87, chat sim 12/0, generated-patterns — all green.

- (2026-07-07) **DERIVED-COPY resolved-ROG dispatch LANDED** (`87c1a1648`,
  D-V2-RESOLVED-COPY). Berni's challenge — "I thought plain-JSON loads are
  no longer used" — was RIGHT: the chat sim's 16/16 `no_rog` fallbacks were
  all `resolvedHasRog=true` AND positionally faithful, i.e. false
  rejections of derived copies (reload/embedded sub-patterns), not a
  genuine legacy tail. My earlier "stays legacy" attribution was wrong.
  FIX: strict-miss → `getBuiltRogResolved` + positional-correspondence
  validation → bind canonical ROG against the copy's `pattern.nodes`.
  A 6-lens adversarial soundness WORKFLOW (ultracode) found zero holes vs
  the 4 current order-preserving copy sites but flagged the latent
  REORDER-OF-EQUALS hole → hardened the gate with a per-position ALIAS-
  TARGET digest (canonicalizes defer-bump + scope→schema, fails closed on
  reorder/retarget). Comparator unit proof + runtime differential (real
  serializePatternGraph copy interprets via resolved, byte-equal to legacy,
  `interpretedViaResolved` census tag). Empirically: chat sim no_rog 16→0,
  ZERO derived_* spurious rejects, still 12/0. Recovered patterns are
  boundary-heavy sub-patterns that stop at the cost gate — the value is
  metric honesty + engagement for reload/embedded patterns that DO carry
  collapsible compute (generated-patterns corpus). Also measured this
  session (flag on/off): micro map −56% docs/−65% wall, 6-lift chain −58%
  nodes/−70% wall; pattern-tests suite flat (fixed costs dominate); chat
  sim −3%. NEXT MEASUREMENT: corpus engagement delta from this fix.

- (2026-07-07) **COVERAGE-DEBT PAID DOWN + test-glob bug fixed**
  (`d6fa17efd`, `f4460c257`, `f9079ad81`). ROOT CAUSE of the
  `coverage-debt: packages/runner` inflation: the runner `test` task globbed
  `test/*.test.ts`, which does NOT match `test/reactive-interpreter/` — so
  the 9 ri-v2 suites NEVER RAN in CI (dispatch 4%, interpret 1%, partition
  4% by V8 line coverage) and weren't regression guards. Fix = discover from
  `test/` (recursive). Then 6 cov-*.test.ts unit files (a 3-agent workflow +
  a runtime-branch agent) drove the module tree 24.6% → 86.2% line coverage
  (uncovered 2500ish → 396): interpret/leaf-caps/rog/builtin-markers 100%,
  partition 93%, from-builder 91%, dispatch 78%, collection-inline 72%.
  applyExprOp (25 ops), leaf-caps schema predicates, evalRog branches,
  partition/from-builder classification, dispatch fallback + derived-copy
  positional-FAILURE modes (derived_len/kind/edge), segment error isolation,
  inline-collection refusals. Residual 396 = fail-closed degrade/resume +
  RI2_DEBUG branches (guarded by the differential + resume integration
  suites) → honest small override, down from the inflated 9262. Full runner
  suite 820 passed, 0 failed.
