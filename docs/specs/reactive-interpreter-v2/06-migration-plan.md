# 06 — Migration plan: work orders, gates, harvest, process

## 1. Work orders

Each lands as small PRs on main behind a default-off flag
(`experimentalInterpreterV2`), each gated by the oracles in §4. No umbrella
branch (§6).

| WO | Contents | Exit gate |
| --- | --- | --- |
| **V0 — IR + expander + harness** | IR v2 types + serialization ([02](./02-ir.md)); the ROG → legacy-node-list expander; port the differential-oracle harness to compare (interpreted vs legacy-expanded) and (legacy-expanded vs current-compiler legacy) | Expander output-equivalent to current compilation on the pattern corpus; oracle harness green as the *permanent* gate |
| **V1 — compiler emission, expression subset** | Replace expression-site lift-wrapping with op emission (operators, interpolate, access/construct, control); shared allow-list registry; IR goldens; source-range tests | Parity with v1 §08 coverage (str-leaf invocations = 0, operator leaves = 0) *without* the branded-lift encoding; transformed-graph + runtime output equivalence (v1 OQ-E1's two checks) |
| **V2 — partition + segments** | Harvest partition.ts + evalRog; plan-consuming emission module behind the narrow RunnerSeam ([04](./04-execution.md) §2); per-path read sets; cost gate; seed-by-boundary | Engagement ≥ v1 (88.4% interpretable-op on the integration corpus); OQ-C4 oracle (segment re-runs ⊆ legacy re-runs); footprint ≥ v1 nodes −26% |
| **V3 — collections (Option A)** | Inline element Rogs; per-element effects/docs; consolidated raw writes; element-cell GC; inline result paths | Pointwise oracle + broken-mirror teeth; rendered-map docs ON ≤ legacy (target −60%/element per v1 §4.8); grow/shrink/reorder reconcile oracle |
| **V4 — function lowering** | Tier 1 (const-SSA, early-return chains, HOF callbacks), then Tier 2 (stdlib `call` registry, same-bundle `fn`/`call`) | Per-entry oracle rows before registry entry; compile-time opaque-census assertions in CI; loaded-pattern SES-leaf count strictly decreasing on the corpus |
| **V5a — R-SEAM-2** | Per-trigger delta surface; selective element recompute | Collections skip untouched elements under the delta; no correctness dependency (delta off ⇒ same outputs) |
| **V5b — R-SEAM-3 + §8.9.1 gate** *(decision point)* | Trusted per-path content-label emit; trust-gate machinery; O(1) containers through the materialization seam | The v1 03-cfc §8 proof obligations; pointwise oracle on inline containers |
| **V5c — checkpoint tier** *(product-gated)* | Persist expensive opOuts with transitive-external-read `derivedFrom`; GC with element lifecycle | Confirm the unbounded-importer workload is still a target first |
| **V6 — default-on** | Flip the flag; retire the expander path incrementally | §5 pathology gates green; perf baselines; multi-user/cross-space suite green flag-ON |

## 2. CI requirements (from day one, not retrofitted)

- The flag-ON job runs **the multi-user / cross-space pattern-tests**, not
  just the runner suite + single-runtime integration. v1's 226× cross-space
  regression stayed invisible for the entire campaign because flag-ON CI
  never covered that suite; this is the proxy-metric lesson made structural.
- Engagement/lowering census dumped in CI and asserted (coverage may only
  ratchet up; "green via fallback" is not representable once eligibility is
  compile-time, but "green via opaque-leaf regression" is — the census
  assertion catches it).
- Footprint benches (docs/nodes slope per element; the doc-explosion law) run
  on the notes-list and lunch-poll shapes with output-equivalence checks.

## 3. Harvest list from #4298

Take, nearly verbatim:

- `partition.ts` (layered assignment + union-find) and the `evalRog` core
  with per-op error isolation.
- The **test estate** — the most valuable artifact of the campaign:
  differential oracles (`prod-wire`, `nested-prod-wire`,
  `collection-prod-wire`, `extract-interpret` reshaped for compiled IR),
  pointwise-CFC oracles + the broken-mirror support harness
  (`broken-collection-interpreter.ts`), eligibility-hole RED→GREEN proofs
  (reshaped as compiler-census tests), footprint accounting
  (`doc-explosion-measure.test.ts`, `interpreter-measure.ts`), benches
  (`notes-list-bench`, lunch-poll tools, child-pattern-map scaled), and the
  expr fidelity suites (`expr-interp.test.ts`, `expr-interp-cfc.test.ts`,
  `str-interpolate-cfc.test.ts`).
- `cell.ts` read-only enforcement (`readOnlyReason` on
  `set`/`send`/`setRaw`) — a standalone hardening win; land it on main
  independently of everything else, first.
- The spec set (01–08 + DECISIONS.md + coalescing-campaign.md) as the cited
  v1 record.

Deliberately **not** taken: `extract.ts` (the decompiler), the branded
`exprLift` transformer + its verifier/TRUSTED_BUILDERS cases, the runtime
eligibility probe + census-as-eligibility, the runner.ts dispatch/emission
seam, `$ri-collection-map`'s runtime re-extraction path.

## 4. The permanent gates (discipline carried from v1)

1. **Differential oracle**: interpreted == legacy-expanded on the corpus, per
   work order, including the negative axes (every compile-time opaque
   decision has a test asserting the opaque path also matches).
2. **Registry-entry oracle rows**: no vocabulary growth without the
   nasty-semantics rows ([03](./03-compiler-emission.md) §4).
3. **OQ-C4 invalidation oracle**: segment re-runs ⊆ legacy re-runs under
   input mutation.
4. **Pointwise + broken-mirror**: read isolation stays load-bearing, provably.
5. **Red-green for every fix** (repo discipline): failing test first.

## 5. Risks the plan must burn down explicitly

| Risk | Owner WO | Notes |
| --- | --- | --- |
| **Cross-space pull amplification** (v1: ~226–270× on whole-state sinks over reader-isolated cross-space docs) | V2/V3, gate at V6 | Structural: coalesced result topology × schema-less deepTraverse sinks × docs that never load re-dirtying on every sync notify. v2's per-path read sets shrink the read-set churn, but the sync-layer interaction (unconditional load-notify; per-read `sync()` of never-loading docs) needs its own fix. Root-cause record: v1 `implementation/pull-amplification-root-cause.md`. Repro is the cfc-group-chat multi-user integration test. |
| **F4 I/O write-back ratchet** (forced in v1: 25× conflicts, broken output) | V3+, possibly never | Coalescing a pure region co-resident with a hot shared write target multiplies stale-confirmed-read surface. v2 keeps such regions boundary-cut by construction (effect.writeTargets edges); un-trapping them is research (element-scoped read isolation on the I/O path), not a milestone. |
| **Stdlib fidelity** | V4 | Each method is a small correctness contract; the registry + oracle rows are the containment. Growth is deliberately slow. |
| **Artifact migration / version skew** | V0/V6 | Old artifacts on the legacy loader indefinitely; the expander only serves v2 artifacts. Watch the stale-server version-skew trap in integration testing (port-offset discipline). |
| **R-SEAM-3 proof work** | V5b | New operational model + refinement theorem (v1 03-cfc §8) — schedule as spec-repo work with the implementation, or don't flip O(1) containers. |
| **Builder front-end scope creep** | V1/V2 | The DSL emits the IR; any DSL shape the IR can't express is a design gap to fix in the IR, not a runtime special case — that instinct (special-case it at runtime) is how extract.ts happened. |

## 6. Process rules

- **No umbrella PR.** v1 ended at 123 commits / +30k lines, unmerged, with
  main moving underneath. Small coherent PRs to main, each green, each
  behind the flag.
- **Metric = the census, not suite-green.** Twice in v1, "CI green" hid
  near-zero real engagement. The census assertion in CI (§2) is the
  anti-regression for the metric itself.
- **Realistic workloads early**: lunch-poll and the multi-user suites run
  from V2 onward, not after the architecture is set.
- Decisions and divergences go in a `DECISIONS.md` next to this plan, in the
  v1 format (it worked).
