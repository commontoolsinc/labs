# Reactive Interpreter v2 — compile the ROG, don't extract it

> **Status**: design draft (2026-07-02). This is the from-scratch rewrite of
> the Reactive Interpreter validated by PR
> [#4298](https://github.com/commontoolsinc/labs/pull/4298) (branch
> `claude/nervous-kilby-83b75b`). That branch's spec set
> (`docs/specs/reactive-interpreter/` 01–08 + `implementation/DECISIONS.md` +
> `implementation/coalescing-campaign.md`) is the **v1 record**: the evidence
> base this design cites. v1 stays unmerged; v2 supersedes it as the
> implementation plan and harvests its algorithmic core and test estate.

## 1. What v1 established

v1 set out to kill the per-element materialization tax (`docs ≈ 5 + 3N`,
`nodes ≈ 8 + 4N`) by executing a Reactive Operation Graph (ROG) IR with a
trusted meta-node. Three of its original claims were **refuted by
measurement** and replaced by what actually works:

| Original claim (v1 02-design) | What survived contact |
| --- | --- |
| One meta-node per eligible pattern; all-or-nothing eligibility | **Pure-region coalescing** (v1 07): cut at effect/handler/collection boundaries, coalesce maximal pure regions into segment nodes, hand the coarser DAG to the unchanged scheduler (D-COALESCE). |
| O(1) docs via inline containers, with pointwise CFC | **Incompatible under current CFC machinery** (D-OQ4): a container write clears child `derived` labels. Pointwise requires per-element docs (Option A, chosen: ~1 doc + 1 effect per element) or a new trusted per-path content-label emit (R-SEAM-3, never built). |
| Leaves stay opaque sandboxed JS | **Opaque leaves are the wrong default for expressions** (D-EXPR / v1 08): native `expr`/`interpolate` ops removed the SES round-trip for operators and `str`, and were the largest single coverage unlock. |

The deepest reframe: **the interpreter is a graph-compression pass, not a new
execution model.** The scheduler remains the reactive engine; segments and
boundaries are ordinary nodes that inherit invalidation, CFC, and
materialization for free.

Measured on v1 (branch HEAD `99c8b1eca`): interpretable-op engagement
**88.4%** on the integration corpus; scheduler nodes **−26% → −33%**; docs
**−34%** overall; rendered lists **−60% docs / −40% nodes** per element;
lunch-poll wall **−7–14%** with fewer conflicts. Costs, also measured: +263
input-marker nodes, +1 node on trivial single-leaf patterns, and a ~56%
practical engagement ceiling on lunch-poll (the residual is genuinely
effectful).

Two pathologies remained open and **gate default-on regardless of
architecture** (see [06-migration-plan.md](./06-migration-plan.md) §5):

- **Cross-space pull amplification** (~226–270× timeouts on the multi-user /
  cross-space pattern-tests): a schema-less whole-state sink deep-traversing
  the coalesced result graph, combined with a reader-isolated cross-space doc
  that never loads, forms a structural re-sync/re-dirty loop.
- **The F4 I/O write-back ratchet**: coalescing a pure region that shares a
  transaction footprint with a hot shared doc multiplies the
  stale-confirmed-read surface (forced: 25× conflicts, broken output).

## 2. The v2 thesis

v1's implementation complexity was dominated by one retrofit decision: the
ROG was **decompiled at runtime from the built legacy graph** (a 1,910-line
extractor full of shape-recognition heuristics, regex scans over live
function source for trust, a runtime eligibility probe, and a brand channel —
`$builtin:"expr:+"` — through which the transformer smuggled knowledge to the
runtime so it could re-recognize what the compiler knew all along).

v1 08's own core argument — the interpret-vs-black-box decision "must be made
in the transformer, where the distinction still exists" — generalizes to the
whole IR. So:

> **One lowering. The transformer emits the ROG as the compiled artifact.**
> Opaque leaves become content-addressed module exports referenced by the IR.
> The legacy execution path is *generated from* the same IR (a ROG →
> legacy-node-list expander), not maintained as a parallel source of truth.
> The builder DSL becomes a second front-end constructing the same IR at
> runtime. Eligibility becomes a compile-time property visible in the
> artifact; the runtime probe, the fallback census-as-eligibility, and the
> extractor disappear.

And it goes one step further than v1: **plain JS functions called from
pattern code are lowered into the IR too** (capability-gated, fail-closed at
compile time), so a loaded pattern's pure computation — including its helper
functions and a curated pure-method stdlib — interprets natively without SES.

## 3. The four decisions

Pinned in [01-decisions.md](./01-decisions.md); summary:

1. **D-V2-ARTIFACT** — the ROG is the compiled artifact; flag-off runs
   legacy nodes *expanded from the IR* (generation, not recognition); old
   artifacts load via the retained legacy loader, keyed on artifact version.
2. **D-V2-LABELS** — ship collections as Option A (per-element docs,
   pointwise, proven); design materialization so R-SEAM-3 (trusted per-path
   content-label emit) can later flip containers to O(1) without
   re-architecture. R-SEAM-3 + the §8.9.1 trust-gate machinery are explicit,
   formally-obligated work orders, not assumptions.
3. **D-V2-READSETS** — segments declare **per-path read sets** to the
   scheduler in v2 core (v1 computed the narrowing but never plumbed it);
   R-SEAM-2 (per-trigger delta) staged immediately after, for selective
   collection recompute.
4. **D-V2-LOWERING-SUBSET** — the interpret-vs-opaque boundary is
   **capability-based, not syntax-based**: const-only bodies, early-return
   chains, pure array HOFs, and a curated pure-method stdlib lower to IR;
   mutation loops, try/catch, async, nondeterminism, and external-package
   imports stay opaque. Every native op is differential-oracle-verified
   before it enters the (single, shared) allow-list.

## 4. Document map

| Doc | Contents |
| --- | --- |
| [01-decisions.md](./01-decisions.md) | The four up-front decisions: context, options, recommendation, consequences. |
| [02-ir.md](./02-ir.md) | IR v2: what carries over from v1 `rog.ts`, what changes (frames, tagged control, inline element ROGs, effect contracts, leaf capability annotations, `fn`/`call`, interned schemas), serialization and the untrusted-data stance. |
| [03-compiler-emission.md](./03-compiler-emission.md) | The single lowering: replacing expression-site lift-wrapping with op emission; function lowering tiers; allow-list governance; goldens; what remains of hoisting/schema-injection/SES. |
| [04-execution.md](./04-execution.md) | Partition (harvested), segment emission behind a narrow runner API, evaluator, per-path read sets, collections, result materialization, checkpoint tier, cost gate. |
| [05-cfc.md](./05-cfc.md) | What carries over from v1 03-cfc wholesale; v2 deltas (function-lowering trust argument, static-operand label joins, boundary read-through by construction, R-SEAM-3 obligations). |
| [06-migration-plan.md](./06-migration-plan.md) | Work orders V0–V6, permanent gates, CI requirements, the harvest list from #4298, process rules, risks. |

## 5. Non-goals (unchanged from v1 unless noted)

- **NG1 — IFC inside leaf bodies.** Opaque leaves keep coarse
  all-inputs-taint-all-outputs labels.
- **NG2 — a new trust root.** The transformer is still not a trust boundary.
  The IR is untrusted data; the interpreter derives labels from actual
  runtime reads under structural read isolation. Compiler-emitted
  annotations are fail-closed hints: they can only cause a boundary or a
  fallback, never grant a capability ([02-ir.md](./02-ir.md) §4).
- **NG3 — interpreting arbitrary JS.** The interpreted dialect grows
  (operators → statements-subset → stdlib calls) but stays a closed,
  oracle-verified vocabulary; everything else is an opaque leaf **decided at
  compile time**.
- **NG4 — a second propagation channel.** Segments and per-element effects
  are ordinary scheduler nodes driven by the one storage notification
  channel.
- **NG5 — preserving internal-cell identity across the migration.** User
  state and externally-referenced outputs are preserved; derived interior is
  not.
