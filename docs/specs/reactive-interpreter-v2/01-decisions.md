# 01 — The four up-front decisions

These are the decisions that shape everything downstream. Each is pinned here
with its v1 evidence so implementation never re-litigates them silently; a
change to any of these is a spec revision, not a code-review comment.

---

## D-V2-ARTIFACT — the ROG is the compiled artifact

**Context (v1 evidence).** v1 derived the ROG at runtime from the built
legacy graph. The costs were pervasive and measured:

- `extract.ts` (1,910 lines) is a decompiler: module-type classification,
  alias-payload parsing, control-branch picking by field-name priority
  (`pickBranch("ifTrue","then","value")` — silently wrong if the builder
  reorders), event-stream detection via `$kind === "stream"`, and regex scans
  over live function source (`liveLeafCanInstantiatePattern`,
  `liveLeafWritesCellInput`) to rediscover properties the compiler knew at
  emit time.
- Fail-open edges existed: an unresolved `internal` ref was treated as an
  external input rather than an error; a missed effect-input edge mis-layers
  the partition (v1 07 §8 F1 was exactly this class).
- Trust was a running tax: fresh per-call closures carry no verified
  provenance, so the campaign repeatedly hit unstampable-closure walls
  (`str` module-scope hoisting + `recordVerifiedProvenance`;
  `elementLeafImplRefResolvable` vs the `$implRef` field; the harness
  `unsafeTrustPattern` measurement trap).
- The transformer had to smuggle knowledge through brands
  (`$builtin:"expr:+"`) so the runtime could re-recognize it — plus the
  dual-mode encoding tax (`TRUSTED_BUILDERS` registration,
  `callbackIndexesForBuilder` verifier cases, `setSourceMapRange` on
  synthetic arrows, allow-lists duplicated between transformer and runtime).

**Decision.** The transformer emits the serialized ROG as the compiled
artifact. Opaque leaves are content-addressed module exports referenced by
the IR (never fresh closures — provenance becomes an artifact-index lookup).
Three consequences define the migration mechanics:

1. **Flag-off path = ROG → legacy-node-list expander.** Generation from a
   normalized IR is a total function and trivially testable — the inverse of
   v1's partial-recognition decompiler. Both execution modes share one source
   of truth; the differential oracle compares them. There is **no
   byte-identity constraint** against the old compiler's output — output
   equivalence is the gate (v1's byte-identity constraint is what forced the
   branded-lift dual encoding).
2. **The builder DSL becomes a second front-end** that constructs the same IR
   at runtime (it already builds a graph; it builds this one instead). This
   is what lets `extract.ts` die rather than survive for the builder path.
3. **Old compiled artifacts** (pre-v2 format) load via the retained legacy
   loader, keyed on an artifact format version. New compiles produce v2
   artifacts. No in-place migration of deployed pattern bytes; the compile
   cache versioning precedent (constant `cf-compiler` atom + version bump)
   applies.

**What this kills**: extract.ts, the brand channel, the runtime eligibility
probe (eligibility is a compile-time property recorded in the artifact), the
census-as-eligibility machinery, the live-leaf trust regex scans, and the
double lowering (TSX → builder calls → graph → ROG becomes TSX → ROG).

**What it does not kill**: the SES sandbox for opaque leaves; the
compiled-bundle verifier (narrowed to opaque modules — the IR blob is inert
untrusted data, format-validated only); `TRUSTED_BUILDERS` for the builder
front-end; the differential oracle (permanent).

---

## D-V2-LABELS — Option A first; R-SEAM-3 as an explicit, formally-obligated work order

**Context (v1 evidence).** D-OQ4 established that a single inline-value
container cannot carry pointwise `derived` labels (a container write clears
child slots' entries), so O(1) docs and pointwise CFC are incompatible
without new trusted machinery. v1 chose Option A — per-element result docs +
per-element scheduled effects, read-isolated, structurally pointwise — and it
is proven (pointwise oracle green, broken-mirror teeth, ~1 doc + 1 effect per
element vs legacy ~3 docs + 4 nodes). The per-path content-label emit
(R-SEAM-3) and the §8.9.1 trust-gate machinery (`isTrustedForConcept`,
`deriveLabelWithTrustGate`, the flow-precision claim atoms) were **never
built** — they remain spec pseudocode.

**Decision.** v2 ships collections as Option A. But **materialization is
designed so a later R-SEAM-3 flip to O(1) containers is a local change**:
element results are written through one materialization seam
([04-execution.md](./04-execution.md) §5) that today mints a per-element doc
and tomorrow could write an inline slot + per-path label — consumers never
know which. R-SEAM-3 + the trust gate are scheduled as work order V5b with
the v1 03-cfc §8 proof obligations attached; they are **not** on the critical
path to default-on.

**Why not build R-SEAM-3 first**: it is CFC-core work with new formal
obligations, and v1 measured that Option A already captures most of the
practical win (rendered lists −60% docs with per-element docs + consolidated
VNode writes). The O(1) container is an end-state optimization, not the
unlock.

---

## D-V2-READSETS — per-path read sets in core; R-SEAM-2 staged next

**Context (v1 evidence).** v1 segments subscribe on **whole input cells**
even when they read a single path — the per-segment read-narrowing schema
(`narrowArgumentSchemaByTree`) was computed at build time and consulted for
eligibility, but never plumbed to the scheduler's subscription machinery. So
a segment re-runs on any field change of any input cell. Separately, a run
cannot see *which* address invalidated it (R-SEAM-2 unbuilt), so collections
re-derive changes by diffing and the evaluator re-runs segments wholesale.
The +263 input-marker node overhead is a symptom of the same seam gap.

**Decision.**

1. **Per-path read sets are v2-core** (work order V2): the partition's exact
   per-segment input paths become the node's declared read set, using the
   existing `trigger-index.ts` match semantics (v1 04 Delta B2's warning —
   reuse, don't approximate). This is the single biggest invalidation-
   precision lever and it removes the spurious-re-run half of OQ-C4 by
   construction.
2. **R-SEAM-2 (per-trigger delta) is V5a**, needed for selective per-element
   recompute inside collections and for large segments. Whole-segment re-eval
   stays the v2-core semantics — segments are small because boundaries cut
   them; correctness never depends on the delta.
3. **Multi-output emission** uses the container-of-links convention first
   (v1 07 F2); native multi-value fan-out (R-SEAM-1) only if fan-out
   measurement (v1: 3 segments corpus-wide feed >1 boundary) says it matters.
4. **Cost gate**: patterns below the measured crossover (~3 pure leaves)
   don't partition — emit them legacy-expanded. Input markers are replaced by
   seed-by-boundary metadata on the segment node
   ([04-execution.md](./04-execution.md) §3), not marker nodes.

---

## D-V2-LOWERING-SUBSET — capability-based lowering of called JS functions

**Context (v1 evidence).** v1 08 lowered `str` templates and 24 operators;
its coverage probe showed the real line is "single expression in the
supported subset vs has-statements" (~70% of explicit computes are
single-expression), and that the dominant out-of-subset fallback is **method
calls** (`.slice`/`.join`/`.toFixed` — the unbounded tail). Helper functions
defined in the module and called from pattern code remain opaque lifts
entirely. The pattern body itself is already provably expression-only
(`validateSupportedPatternStatements`); statements live in helpers.

**Decision.** The interpret-vs-opaque boundary is decided **at compile time,
per function body, by capability analysis** — not by syntax class alone:

- **Tier 0 (v1 parity)**: operators, `interpolate`, access/construct,
  control (`?:`/`&&`/`||` → native control with operand-return semantics).
- **Tier 1 (statements subset)**: `const`-only bodies (each `const` is a
  named op — SSA falls out for free; no new op kind), early-return /
  `if`-chain bodies (nested `ifElse`), spread/destructuring
  (`construct`/`access`), pure array HOFs (`map`/`filter`/`reduce` with
  lowerable lambdas → collection/fold ops).
- **Tier 2 (calls)**: a **curated pure-method stdlib** (string/array/Math
  methods) as `call` ops behind the fail-closed allow-list — per v1's data
  this is the highest-value increment; and **same-bundle helper functions**
  lowered once as IR `fn` definitions invoked via `call` (define-once,
  invoke-many — no per-site inlining blow-up). Recursion → opaque.
- **Tier 3 (opaque, permanently)**: mutation-bearing loops, `try/catch`,
  `async`, nondeterminism (`Math.random`, `Date.now`), dynamic property
  access beyond guarded `access`, imports from external packages, and
  anything the capability analysis cannot prove pure.

**Invariants carried from v1 (verbatim, they were both nearly violated):**

- **E-2 lineage**: nothing emits a native op unless its exact JS semantics
  are in the single shared allow-list registry, and nothing enters that
  registry without differential-oracle rows (including the nasty rows: `+`
  coercion, `==` vs `===`, `NaN`/`-0`, falsy-but-defined operands for
  `&&`/`||` operand-return, int32/uint32 bitwise coercion). Unsupported →
  opaque leaf **in the artifact** — deterministic and visible, not a runtime
  fallback.
- **E-4 lineage**: label joins are computed over the **static** operand set
  even where value evaluation short-circuits.
- `typeof` stays excluded until the evaluator's unresolved-value convention
  is redesigned to distinguish "unresolved" from `undefined`.
