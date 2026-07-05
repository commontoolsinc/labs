# CTS documentation audit — ts-transformers & schema-generator
**Date:** 2026-07-04 · **Tree:** E-cf-repos/labs @ e8516c636 (= origin/main ce0e54322 of 2026-07-01 + 1 unrelated commit; both packages identical to origin/main)
**Method:** orchestrator read the full spec corpus + core sources in main context; 6 read-only audit agents (inventory, schema-generator claim audit, in-package triage, spec-corpus verification, coverage inversion, cross-layer consistency) verified claims against code/tests/fixtures/git; orchestrator independently re-verified every headline finding. Full agent reports live beside this file.
**Prior art this extends (not restarts):** #4075 spec reconciliation (6/12), cfc-spec-audit remediation waves #3970–#4056, docs overhaul #3979/#3980, docs CI-typecheck gate #4317, tests-consolidation #4380.

---

## 1. Headline

**The spec corpus is good — and it denies an implemented subsystem.** CFC schema lowering (all 21 canonical aliases → `ifc.*` metadata, `WriteAuthorizedBy` identity markers, `UiAction`/`UiPromptSlot`/`UiDisclosure` JSX rewriting → `ifc.uiContract`) shipped 2026-04-14 in #3263 and is fixture-pinned (`opaque-input-lowering.expected.jsx` literally emits `ifc: { opaque: true }`; 11+ in-package tests). Yet `ts_transformers_current_behavior_spec.md` §6.8/§12/§14.6 state "no CFC schema lowering yet… no ifc.* emission anywhere in src/… WriteAuthorizedBy contributes no schema metadata", and both `cfc_*.md` contracts still say "Draft, not current implemented behavior." The June 12 reconciliation (#4075) retained the false claims — **manual spec maintenance missed a whole subsystem for ~3 months, in the security-relevant direction** (an agent trusting the spec would treat live IFC surface as dead draft code).

Everything else follows from the same lesson: the corpus's drift-resistance (cite-the-constant §16.1, "code/tests win") is right in design and incompletely enforced in practice. The fixes below therefore pair content repairs with enforcement (a spec-sync test, CI-gate extension, a repeatable audit skill).

## 2. Out of date (verified, ranked)

**Spec corpus** (`docs/specs/ts-transformer/`):
1. §6.8, §12 (final bullets), §14.6 — CFC lowering status wholesale wrong (headline above).
2. §3-adjacent omission: **stages 15–19 have no behavior sections at all** (see §4 Missing).
3. §6 diagnostics inventory missing ≥5 live diagnostics: `pattern-result:unknown-type`, `pattern-context:receiver-method-call`, `pattern-context:inline-reactive-root-access` (pattern-body-reactive-root-lowering.ts:1467), `reactive-capture:unknown-type`, + the wish-result diagnostic held only by `docs/wish-result-lowering-spec.md`. The `family:kind` id scheme is never stated.
4. §5 registry list omits `uiVariant` (second "ignored" export beside `byRef`).
5. §6.4 cites synthetic param `__ct_pattern_input`; code emits `__cf_pattern_input` (pattern-callback-transform.ts:169). (Nuance: `__ct*` brands are alive in packages/api — two conventions coexist; fix the example, don't unify.)
6. §12 "asCell / asStream" wording: no `asStream` field exists in the api JSONSchema type and neither package emits it ("stream" is an `asCell` entry; legacy key read-tolerated by two runner utilities only).
7. Header metadata lies: "Effective date: April 6, 2026" atop a spec edited through June (~115 commits of package churn since).
8. `review_guide.md` is a PR-3154 reviewer artifact promoted to standing entrypoint; its framing ("this PR") is stale by construction.
9. `design_deltas.md` Candidate Touchpoints cite renamed files (map-strategy.ts → array-method-strategy.ts family).
10. `cfc_authoring_contract.md` vs `packages/api` divergence: contract lowers collection wrappers to objects; api type says `ifc.collection?: readonly string[]`. Unimplemented either way — but the drafts disagree with the type they target. Both contracts also cite broken acceptance-test paths.

**Package READMEs:**
11. ts-transformers README pipeline list: 18 of 19 stages (omits PatternCoverage); golden workflow wrong/missing (`.expected.tsx` vs actual `.expected.jsx/.js`; no UPDATE_GOLDENS); "Additional Documentation" links notes slated for deletion.
12. schema-generator README: `#/definitions/` vs code's `#/$defs/`; "aliases resolving to anonymous types are inlined" is wrong for non-generic aliases (hoisted via aliasSymbol fallback, type-utils.ts:472); 9-name exclusion list vs the real spelling/native/structural rule.

**Runtime-dialect doc** (`docs/specs/json_schema.md`, frozen 2025-09):
13. `ifc.classification` example — key exists nowhere in the api type; live keys (confidentiality/integrity/…/uiContract) undocumented.
14. `asCell`/`asStream` as boolean-ish markers vs the actual `asCell: [entries]` array (incl. nested `["cell","cell"]`, `["opaque"]`, scope-carrying entries).
15. No mention of de-facto extensions the generator emits: `{type:"unknown"}`, `{type:"undefined"}`, `$defs` hoisting; "void shouldn't appear" vs code emitting `{asCell:["opaque"]}` for void.

**Author-facing layer** (docs/common, tutorials, skills — punch-list for owners, §7):
16. Docs that teach compile errors: view-switching.md (handler-in-body ×2), new-cells.md (`.get()` on plain input), tutorials/state.md (imports non-exported `derive`; `lift(fn)(args)` in body; deprecated `cell()`), reactivity.md over-broad `.get()` rule.
17. Critic-skill wrongness amplifiers: pattern-critique-guide false-FAILs (inline `.filter` in JSX = the spec's own GOOD example; `[NAME]: someProp`; "new Stream() does not exist") and pattern-critic's `!==`-on-cells exemplar.
18. docs/tutorial/07-compilation.md (otherwise the best narrative): names deleted `BuilderCallbackHoisting` (#3864); `Reactive<T>` marker row conflicts with spec §12 [resolution pending — mapping-spec agent adjudicating from code]; example output omits the `__cfReg` trailer.
19. knowledge-base skill: cites retired "Spell"; labels a runner-side migration design "Authoritative system design"; its blanket "specs win" predates the normative/descriptive split.

## 3. Redundant / decentralized (fates decided, pending your review)

In-package accretions (20 files triaged, every fate evidence-backed): **DELETE 11** (incl. SCHEMA_INJECTION_NOTES — records since-reversed decisions; TEST_PLAN — its 7 proposed test files never created; SAFE_CONTEXT — terminology and policy both superseded; transformers_notes — cites deleted src/reactive/*; tutorials/cts.md — "Needs to be written" stub live in the published TOC with the wrong expansion of CTS), **FOLD 2** (ISSUES_TO_FOLLOW_UP's one live item → design-deltas follow-ups; event-handler-detection contract → spec §7.1), **ARCHIVE 1** (hierarchical-params — good capture-model rationale), **KEEP 6** (adding-type-arg + array-method-pipeline how-tos [1 repair], derive-to-lift [status refresh], wish-result [fold diagnostic], both test READMEs). Meta-finding: #4422 rename touched 8/20 mechanically — git dates manufacture false freshness; unlabeled stale docs must die or carry status banners.

Structural decentralization: TWO parallel tutorial trees (tutorials/ April-vintage + broken entry path; docs/tutorial/ June 11-chapter course) — consolidation decision needed; terminology split (glossary "Common Fabric TypeScript" vs cts.md "Common Type System"; `CFC_TRANSFORMER_*` constants naming the CTS pipeline); schema-dialect knowledge scattered across json_schema.md + api type + two package READMEs with no current single source.

## 4. Missing (now being drafted)

1. **A schema-generator spec** — the biggest gap: 56-line README for a 7.7k-line package that is half the language contract. [Mapping spec drafting in progress: type-mapping table, $defs/cycles, wrapper vocabulary, Default/DeepDefault, scope wrappers, CFC alias lowering, JSDoc→description/tags, hints, fail-loud inventory, options, test workflow, sources-of-truth table.]
2. **Spec sections for pipeline stages 15–19** (ReactiveVariableFor auto-`.for("<varName>")` identity causes; ModuleScopeShadowing; ModuleScopeCfData `__cf_data` wrapping; PatternCoverage incl. the one-prepended-line/lineOffset:-1 and cache-bypass couplings; ModuleScopeFunctionHardening) — including the **sandbox-verifier cross-package contract** (emitted shapes pattern-matched by `@commonfabric/utils/sandbox-contract.ts`) documented nowhere transformer-side. [Five sections drafting in progress.]
3. **Per-package agent entry points** — no AGENTS.md/CLAUDE.md in either package; repo AGENTS.md never links the spec dir. [Drafted.]
4. Undocumented operational surface: `visitEachChildWithJsx` requirement, `no-node-get-text` lint rule, golden env knobs (UPDATE_GOLDENS/FIXTURE/SKIP_INPUT_CHECK), library-embedding lifecycle (real driver = runner/harness/engine.ts, not js-compiler), compile-byte-cache (#4425), CrossStageState contract living in a 200-line code comment citing a deleted design doc.

## 5. Code findings (docs audit → latent bugs; phase-4 seeds)

- **Anonymous `export default function` hardening bug (probe-verified, task chip filed)**: stage 19 emits `const __cfDefaultFn_1 = __cfHardenFn(function …); export default __cfDefaultFn;` — the export references an undeclared name (`createUniqueName`-`.text` trap, same class §11.3 documents). Zero test coverage on that path.
- **Broken manifest export**: ts-transformers deno.jsonc exports `./core/imports` → `src/core/imports.ts` does not exist (orchestrator-verified).
- **`widenLiterals` does not widen all-literal unions** (probe-verified): `"a"|"b"` still emits `enum` — the all-literal branch runs before the flag is consulted.
- **TS enum hoisting collision risk** (probe-verified): enum members hoist to `$defs` under the bare member name — two enums sharing a member name would collide (untested outcome).
- Tuples emit `{type:"array", items:{type:[…]}}` — positional info lost, no `prefixItems`; bigint literals go through `Number` (2^53 precision loss).
- Dead surface: `injectCfDataHelper` zero callers (orphaned since #3254; history documented in spec §15.6); `mode:"error"` zero production consumers; `GenerationContext.cyclicTypes/cyclicNames` computed per generation, never read.
- Node-based vs type-based literal encoding divergence (`const:` vs `enum:[…]`) — unpinned output divergence.
- CFC alias matching is name-keyed with no source-file check — a user type named `Integrity` lowers to `ifc` metadata (foot-gun; load-bearing for api aliases; needs a decision, not a silent fix).
- The transformer's AST-built hardening helpers and sandbox-contract string builders are maintained by hand in two encodings with no equivalence test (drift = every module load fails; loud but untested).
- `cf view`'s `SCAFFOLDING_NAMES` is an unimported copy of `SHADOWED_FACTORY_BINDINGS` — can drift silently.
- Orphaned fixture: `closures/map-type-assertion.expected.jsx` (no `.input.*` partner, obsolete import style).
- pattern-schema/pattern.md vs reactivity.md Output-`Writable<>` policy conflict (regression fixture guards brand preservation) — needs an owner ruling.
- RESOLVED during audit: `Reactive<T>` emits **no** wrapper marker (guard test + fixture evidence); tutorial's `asCell:["opaque"]` row was wrong and is fixed.

## 6. Root causes (why good practices still drifted)

1. **Verification is manual.** §16.1's cite-the-constant pattern exists but nothing executes it; #4075 reconciled by hand and missed #3263.
2. **The CI docs-typecheck gate (#4317) covers docs/ but not package-internal docs** — precisely where rot concentrated.
3. **PR-scoped artifacts get promoted to standing docs** (review_guide) and working notes never scheduled their own death.
4. **Rename churn fakes freshness** (git dates ≠ verification dates; no per-doc status/verified-against metadata).
5. **Cross-package contracts have no doc home** (transformer↔verifier, transformer↔runner coverage plumbing), so neither side documents them.

## 7. Punch-lists for other owners (not drafted by me)

- docs/common: view-switching examples; reactivity `.get()` sentence; new-cells example; writable.md "must be in computed()" claim; composition spread symptom.
- tutorials/: tree decision (retire vs banner vs merge into docs/tutorial); state.md rewrite + companions; making-lists workaround vs mergeable methods; state_modify Math.random → nonPrivateRandom.
- skills: critique-guide 3 rows; pattern-critic exemplar; knowledge-base "Spell" + overview.md label + hierarchy refinement (suggested wording in design doc).
- Output-Writable policy adjudication (pattern-schema/pattern.md vs reactivity.md).
- runner/pattern-construction owners: overview.md Background staleness + phase statuses.
- specs repo: cfc/11-developer-guide "Recipe"/commitIntent leftovers.
- json_schema.md runtime-semantics half (tri-state additionalProperties, narrowing): flagged for runtime-owner review; I only fixed generation-side facts.

## 8. Spec-corpus verification detail (agent D; full report: spec-verification.md)

Verdict counts (current_behavior_spec: ~78 CONFIRMED / 11 STALE / 10 WRONG / 2 UNVERIFIABLE; README 14/1/1; review_guide 13 confirmed with only its PR framing stale — its content survives; goals 4 spot-confirmed/1 minor; design_deltas 14/6; cfc_authoring 6/4/1; cfc_ui_helper 10/2; **type_driven_behavior_inventory 19/19 CONFIRMED**; both normative specs' factual asides confirmed). The corpus is fundamentally sound; the WRONGs cluster almost entirely in the CFC-status story.

**Two-baseline caveat:** agent D audited origin/main @ 71a52a530 (via read-only git archive); this working tree is 78 commits behind (13 touching audit paths). Fixes drafted tonight are correct **for this tree**; the following are REAL on latest main and must be folded in after rebase (all mechanical, ~1 hour):
1. Pipeline is **20 stages**: `MergeablePushValidationTransformer` at position 5 (#4450/#4505) — spec §3 list + stage ordinals (§6.8 "stage 10"→11, §11 "stage 13"→14, coverage "stage 18"→19, and the new §13–§17 stage numbers shift by one) + a new §6 entry for `mergeable-push:read-then-push` (warning severity; read-dependent-push vs independent-read-modify-write; one-per-collection-per-handler). The spec-sync test will fail on rebase until §3 is updated — by design.
2. Fetch family split (#4206): registry gains `fetchJson`/`fetchBinary`/`fetchText`/`fetchJsonUnchecked` (spec §5); `fetchJson<T>` gets dedicated schema injection + `fetch-json:missing-type-argument` (§5/§10.5/§6).
3. `capability:unreadable-cell-argument` (#4486) → §6 catalog.
4. Re-run `test/spec-sync.test.ts` and the spec-audit skill's enumeration checks after rebase.

Also from D, folded into tonight's fixes: review_guide all-links-valid (archived with banner rather than deleted); design_deltas file/symbol renames (map-strategy→array-method-strategy, isReactiveArrayMapCall gone, landed-as names, D-005 location+count softening); goals C-012 constructor-forms framing; cfc_authoring internal inconsistency (`Classified` vs `Confidential`) + 5 missing lowered aliases + broken acceptance paths; UI-helper contract met-in-substance characterization (non-literal `as` silently keeps default tag; all-or-nothing literal hint rule; hint fields extended via `TrustedActionUiContract`).

## 9. What was drafted tonight (uncommitted, on your branch)

**Spec corpus** — current_behavior_spec: CFC-status rewrite (header, §6.8, §12, §14.6→§19.6), header effective-date → verified-against line, §2.2 dedup channel, §5 uiVariant, §6.4 `__cf` fix, §6.5 statement-level diagnostics, §6.6 `pattern-result:unknown-type`, new §6.9 lowering-stage diagnostics, §7.1 UI-helper rewrite + event-handler detection contract, and **five new stage sections §13–§17** (ReactiveVariableFor / ShadowGuards / `__cf_data` / PatternCoverage / FunctionHardening — each code-cited, with sandbox-verifier contracts and the coverage couplings documented; drafted by section agents from source, orchestrator-integrated) with old §13–16 renumbered §18–§21 and four new sources-of-truth rows. design_deltas: 6 mechanical repairs + follow-up queue absorbing ISSUES_TO_FOLLOW_UP's live item. goals: C-012 framing. cfc_* contracts: status headers now state the landed slice + letter-vs-shipped deltas (incl. the OPEN ifc.collection shape conflict), alias list synced to api, acceptance paths fixed.
**New docs** — docs/specs/ts-transformer/README.md (corpus map/authority/read-paths/protocol; replaces review_guide, which is archived with banner alongside hierarchical-params); docs/specs/schema-generator/ mapping spec; packages/*/AGENTS.md + CLAUDE.md; skills/spec-audit/SKILL.md.
**Repairs** — package README (pipeline pointer-ized, `.expected.jsx`, UPDATE_GOLDENS, doc links); json_schema.md (asCell array, no asStream, real ifc keys, unknown/undefined/void, $defs — runtime sections untouched, flagged for runtime-owner review); array-method-callback-pipeline stage block; fixtures README derive rows; derive-to-lift scratch-ref annotation; cf-review skill link; repo AGENTS.md pointers; tutorials/myst.yml TOC.
**Deletions (staged)** — 13 files per triage evidence (11 DELETE + 2 folded-then-deleted).
**Enforcement** — packages/ts-transformers/test/spec-sync.test.ts (green; pins spec §3 to CFC_TRANSFORMER_STAGE_NAMES) + the spec-audit skill for the non-mechanical remainder.

Nothing committed; review via `git status` / `git diff` (renames and deletions are staged so they display as such).
