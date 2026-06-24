# 08 — Expression-subset interpretation: lower the expression graph, don't black-box it

> **Status**: design proposal (2026-06-24). Peer to
> [07-coalescing-architecture.md](./07-coalescing-architecture.md); the coalescing
> track depends on this for the **serialized-pattern** case. Decision record:
> [implementation/DECISIONS.md](./implementation/DECISIONS.md) §D-EXPR.
> Grounded in the real ts-transformer seams (cited inline).

## 1. The problem

When the ts-transformer lowers a pattern body, every reactive **expression site**
(the seven `getExpressionContainerKind` kinds — `jsx-expression`,
`template-span`, `return-expression`, `variable-initializer`, `call-argument`,
`object-property`, `array-element`; `expression-site-types.ts`) is wrapped into a
**lift-applied call**:

```
a + b   →   __cfHelpers.lift(({a, b}) => a + b)({a, b})
```

(`PatternOwnedExpressionSiteLoweringTransformer` → `rewritePatternOwnedExpressionSites`,
`expression-site-lowering.ts:519`; emit via `createLiftAppliedCall`,
`builtins/lift-applied.ts:178`.) To the runtime this is a `type:"javascript"`
module with an opaque `implementation` + `$implRef`; the interpreter's
`classifyModule` (`extract.ts:117`) classifies it `{kind:"leaf"}` and **runs the
function as a black box** — the `a + b` AST is *not* recoverable post-transform.

Two costs follow:

1. **Serialized patterns can't interpret it.** A *loaded* pattern's lift bodies
   are `$implRef`s, not live functions, so a leaf op needs **SES resolution**
   (`resolveLeafImpls` → the verified-implementation index, `extract.ts:780`) and
   otherwise falls back (`unresolved_leaf`). Since production patterns are usually
   loaded, the **bulk of a real pattern's pure computation is an opaque leaf that
   needs the sandbox** — even though it's just `a + b`.
2. **The meta-node understands the wiring, not the computation.** Arithmetic,
   comparison, `!`, etc. are black boxes; the interpreter can't reason about them
   (finer invalidation, per-operator labels, etc.).

The auto-generated wrappers are **indistinguishable from explicit `computed()`**
in the emitted artifact: explicit `computed(() => expr)` lowers to the *same*
`__cfHelpers.lift(() => expr)({})` shape (`lift/transformer.ts:86`), and the
transformer's auto-vs-explicit markers (`markAsSyntheticComputeCallback`,
`isSyntheticComputeCallback`, `CrossStageState` WeakSets, `cross-stage-state.ts:89`)
are **compile-time-only and dropped**. So the interpret-vs-black-box decision
**must be made in the transformer**, where the distinction still exists — not in
the runtime, where it's erased.

## 2. The change

**Replace the pattern-owned expression-site lowering with one that emits the
expression subset directly as ROG operator ops the meta-node evaluates natively,
falling back to a lift-applied leaf only for forms it does not (yet) support.**
Leave **explicit** `computed()`/`lift()`/`derive()` alone (their bodies can be
arbitrary JS — statements, loops — and stay opaque leaves).

Concretely, in `rewriteExpression` (`expression-rewrite/rewrite-expression.ts:214`)
and its emitters, for a pattern-owned site whose expression is in the **expression
subset**, emit an **operator op** into the graph instead of `createLiftAppliedCall`:

- **binary** (`+ - * / % ** | & ^ << >>`, `< > <= >= == === != !==`) →
  one `expr` op per operator (today: `emitBinaryExpression` →
  lift-applied leaf, `binary-expression.ts:218`).
- **unary** → `expr` op. ⚠️ Correction (review E-3): only `!` has a dedicated
  emitter today (`prefix-unary-expression.ts`); `-x`/`+x`/`~x`/`typeof x` fall
  through to the enclosing-site wrapper, so migration *adds* coverage for those,
  it does not swap a leaf. **Exclude `typeof` from the v1 supported set** (it
  clashes with the evaluator's `undefined`-on-unresolved convention).
- **conditional `?:`** → a native ternary `expr` op (today: → `ifElse` builtin,
  `conditional-expression.ts:175`).
- **logical `&&` / `||`** → native `expr` ops (today: → `when`/`unless`,
  `binary-expression.ts:148/198`).
- **member / element access** (`x.foo`, `x[i]`) → the existing `access` op.
- **object / array literals** → the existing `construct` op (the transformer
  already descends into children rather than wrapping the literal —
  `container-expression.ts:14`).
- **calls** to lifts / other ops → an op referencing the callee op; calls to I/O
  builtins → a **boundary** (per §07).

Everything else (a method call like `x.slice(2)`, a tagged template, anything not
in the supported set) → **fall back to a lift-applied leaf, exactly as today**
(fail-closed, growable). The supported set can grow operator-by-operator behind
that fallback.

### 2.1 The interpret-vs-black-box boundary (why it's principled)

- **Pattern-body expression sites** are *provably* in the expression subset: bare
  `if`/`for`/`while`/`var`/`let`/early-return/reassignment in pattern context
  already **error** (`validateSupportedPatternStatements`,
  `pattern-context-validation.ts:453` — a pattern body is "a single terminal
  return, no loops/let/var/reassignment"). So lowering them to operator ops is
  safe — there is no statement-level JS to miss.
- **Explicit `computed(fn)`/`lift(fn)` bodies** can contain arbitrary JS, so they
  stay **opaque leaves**. (Note: inside an explicit compute, `&&`/`||` already
  stay native JS — `shouldLowerLogicalExpression` only lowers them in
  `contextKind === "pattern"`, `rewrite-policy.ts:35`. So "emit `&&`/`||` as
  expression ops" is *already* the behavior inside computes; this change extends
  the **graph** treatment to pattern-owned sites.)

This is the clean line: **interpret what is provably an expression (the pattern
body); black-box what may be arbitrary JS (explicit compute bodies).**

### 2.2 What it does to the control ops

Control flow is *already* first-class ROG: `ifElse`/`when`/`unless` are
`CONTROL_OPS` → `{kind:"control"}` (`extract.ts:76,150`). But today their
**branches/predicates are still wrapped lift leaves**. Emitting native `?:`/`&&`/
`||` operator ops folds the branch/predicate computation into the operator graph,
so the *whole* conditional expression is interpreted — no branch leaves. The
`control` op kind then narrows to **explicit** `ifElse(...)`/`when(...)`/`unless(...)`
builtin calls a user writes (which stay builtins). (Open: keep `control` for
explicit calls AND add native ternary/logical `expr` ops, or unify — §6 OQ-E3.)

## 3. The ROG vocabulary extension

Add an operator op kind (sketch):

```ts
| { kind: "expr"; op: BinOp | UnOp | "?:" | "&&" | "||"; inputs: ValueRef[] }
```

The evaluator (`interpret.ts evalRog`) gains an `expr` case that applies the
operator to its resolved inputs with **exact JS semantics** (§4). `access` /
`construct` / `control` / `leaf` (explicit lifts) are unchanged. `expr` ops are
**pure** (no SES, no leaf resolution) — that is the whole point.

## 4. Semantic fidelity — the entire correctness surface

The interpreter's operators must match JS **exactly**, or it diverges from legacy
(which runs the real function). This is where the risk is, and the differential
oracle is the gate (`interp == legacy` over a corpus of real expressions):

- `+` number/string coercion; `==` vs `===`; `!=`/`!==`; relational coercion.
- `&&`/`||` return the **operand** (not a boolean) under JS truthiness; `?:`
  selects; `!`/unary `-`/`+`/`typeof`/`~`.
- `NaN`, `-0`, `Infinity`, `null`/`undefined` propagation, BigInt (if it occurs).
- Bitwise/shift coercion to int32/uint32 if those ops are supported.

Anything whose JS semantics the implementation is unsure of → **don't add it to
the supported set yet**; leave it a leaf. The supported set is exactly the set
whose JS semantics the evaluator reproduces and the oracle verifies.

### 4.1 Short-circuit vs eager (a reactivity/read-set decision, not just cost)

`a && b`: **eager** (evaluate both operands, then select — like the current
`control`, which computes both branch ops in topo order) means the op's read-set
includes `b` even when `a` is falsy → it re-runs when `b` changes (over-reactive),
and `b` throwing is contained only by per-op error isolation. **Short-circuit**
(evaluate `b` only when `a` is truthy) gives a tighter read-set. Eager is the
simplest first cut and matches today's `control` behavior; short-circuit is a
read-set-precision refinement (ties to 07's OQ-C4). Decide explicitly; default
eager, note the precision item.

## 5. Why this matters (and how it composes with coalescing)

- **Shrinks the SES/serialized boundary — the production-dominant win.** Operator
  ops need no function to resolve and no sandbox, so a *loaded* pattern's
  expression computation interprets natively. Only **explicit** lifts remain
  `$implRef` leaves. Since patterns are usually loaded, this is large.
- **Simpler pipeline:** the expression-wrapping stage becomes an expression→ROG
  emitter; no opaque function round-trip for the common case.
- **Composition (07 + 08 are the two halves):** coalescing partitions the graph
  (pure regions vs I/O boundaries); expression-interpretation enriches the ops
  *inside* a pure region (operators, not leaves) and **removes the SES dependency
  there**. Only together does the interpreter genuinely run real loaded patterns:
  07 un-traps the pure regions; 08 lets those regions execute without the sandbox.

## 6. Open questions / risks

- **OQ-E1 — the transformer is the blast radius.** Replacing a load-bearing
  lowering stage (`expression-site-lowering.ts`) must produce a faithful graph and
  an airtight fallback. Gate with **two** differential checks: transformed-output
  equivalence (the emitted graph computes the same as the lift-applied form) and
  runtime-output equivalence (`interp == legacy`).
- **OQ-E2 — the supported set + the fallback predicate.** Define exactly which
  expression forms emit operator ops vs fall back to a leaf, and make the fallback
  fail-closed (unknown form → leaf, never a wrong op). Mirror the transformer's
  existing `containsOpaqueRef && requiresRewrite` gating + `detectCallKind`
  early-out for already-`computed`/`lift` calls (`rewrite-helpers.ts:91`).
- **OQ-E3 — control unification.** Keep `control` for explicit `ifElse(...)` calls
  and add native `?:`/`&&`/`||` `expr` ops, or unify? Recommend: native `expr`
  ops for pattern-owned ternary/logical; keep `control` for explicit builtin calls.
- **OQ-E4 — calls.** A pattern-body call to another lift/op → an op ref; a call to
  a method (`.slice`, `.toFixed`) → supported-method op or leaf fallback; a call
  to an I/O builtin → boundary (§07). Define the call taxonomy.
- **OQ-E5 — CFC.** `expr` ops are pure; their flow-join follows their input reads
  (no new label). Verify no under-label vs the leaf they replace (the leaf read
  the same inputs).

## 7. Validation before building

Prototype the **coverage** the same way 07 did, at the transformer/AST seam (the
auto-vs-explicit split is *not* recoverable from the ROG — §1): per pattern, count
the leaf ops that are **auto-generated expression-computeds** (would become
operator ops, no SES) vs **explicit** lifts (stay opaque). Two seams (per the
recon): (1) instrument the transformer to count `isSyntheticComputeCallback`
wrappers vs explicit; or (2) re-derive from the pre-transform AST (re-run the
eligibility predicate over the seven expression-site kinds, minus literal
`computed`/`lift` calls). The measurement answers: **how much of a real loaded
pattern's computation moves from opaque-SES-leaf to natively-interpreted operator
ops** — i.e. how much the serialized boundary shrinks.

## 9. Prototype + adversarial review findings (2026-06-24)

A coverage prototype (`packages/patterns/tools/expr-interp-coverage-probe.ts`,
pre-transform AST over 10 real patterns) + an independent design review returned
**GO-WITH-FIXES** and **materially refined the scope**.

### 9.1 Coverage — the scope lever is *single-expression computes*, not "auto"

| metric | value |
| --- | --- |
| (A) auto-generated expression sites → operator ops (no SES) | **37** |
| (B) explicit `computed`/`lift`/`derive` | **80** |
| A/(A+B) — §08-as-scoped off-SES fraction (lower bound) | **31.6%** |
| of B, single-expression bodies already in the subset | **45 (56%)** |
| off-SES fraction if those are also interpreted | **~70%** |

**The auto-vs-explicit split is a coding-style artifact, not a semantic boundary**
— `computed(() => a+b)` is the same shape as an auto-wrapped `a+b`. §08-as-written
(interpret only auto sites) leaves most of the win on the table. **The real
interpret-vs-blackbox line should be "is the compute body a *single expression in
the supported subset*?" (auto OR explicit) vs "does it have statements?"** — which
is exactly the line `validateSupportedPatternStatements` already draws for pattern
bodies. (Scope decision for the coordinator.)

### 9.2 Priority — access + ternary dominate, and both reuse EXISTING ops

By share of A: **access 43% · ternary 32% (cumulative 76%)** · call 14% · binary
**5%** · logical 5% · unary 0%. Two consequences:

- The arithmetic operators (`+ - * /`) are a **thin 5% tail** in real patterns; the
  bulk is **member access + ternary**.
- Both high-coverage forms map to **existing interpreter ops** (`access`,
  `control`) — *no new semantics, no semantic-fidelity risk*. So the
  **high-coverage, low-risk v1 is "stop wrapping access/ternary expression sites
  in lift leaves; emit them as the `access`/`control` ops they already are."** The
  new `expr` operator ops (arithmetic/logical/unary — where the §4 fidelity risk
  lives) are a small, incremental, oracle-gated tail.
- Next growth target after v1: **method calls** (`.slice`/`.join`/`.toFixed` — 38
  occurrences, the dominant out-of-subset fallback leaf).

### 9.3 Design punch-list (GO-WITH-FIXES; resolve before building)

| # | Finding | Sev | Fix |
| --- | --- | --- | --- |
| E-1 | **`&&`/`||` must return the resolved OPERAND** under truthiness (`cond ? RHS : cond` / `cond ? cond : RHS`), reusing a single `pred` ValueRef (like `when`/`unless`). A boolean-coercing op silently diverges on falsy-but-defined operands (`0`/`""`/`NaN`/`null`). | **HIGH** | §3/§4 — pin the operand-return contract + oracle rows with falsy-but-defined operands. |
| E-2 | **Fallback is NOT fail-closed by construction.** The emitter dispatch returns the first emitter that claims a node; a half-implemented `expr` branch emits a *wrong op* and bypasses the leaf fallback at the bottom of that emitter. | MED | §2.1/OQ-E2 — an explicit `SUPPORTED_EXPR_OPERATORS` allow-list consulted at the top of the `expr` emitter, provably ⊆ the oracle-verified set; red test that every non-set op → leaf. |
| E-3 | §2 factual error: only `!` has a unary emitter; `-x/+x/~x/typeof x` fall through to the enclosing wrapper today → migration *adds* coverage, not swaps. `typeof` clashes with the `undefined`-on-unresolved convention. | MED | §2/§4 — correct the baseline; **exclude `typeof` from v1**. |
| E-4 | Short-circuit vs CFC: a short-circuiting `&&` reads only `a` when `a` falsy → drops `b`'s label vs the leaf it replaced (under-label under enforce). | MED | §4.1/OQ-E5 — compute the label join over the **static** operand set even when value-evaluation short-circuits; if unified under enforce, short-circuit is blocked. |
| E-5 | §3 `expr` op sketch omits `outSchema` (`Op` requires it, `rog.ts:118`); native ops bypass `registerSyntheticCallType`, losing the downstream result type that drives traversal/capability/label structure. | MED | §3 — source `outSchema` from `checker.getTypeAtLocation(expression)`; note the `typeRegistry`/schema-gen interaction in OQ-E1. |

**Highest-risk before building (E-1 + E-2 together):** make the supported-operator
set an explicit dispatch-level allow-list provably ⊆ the oracle-verified set, AND
pin the `&&`/`||` operand-return value-identity — both as invariants with red
tests *before* any emitter code, because nothing in the current emitter
architecture enforces fail-closed, so a partially-correct operator ships a wrong
op rather than degrading to a leaf.

**No NO-GO.** The thesis holds; all findings are fidelity/scope corrections. The
review independently confirmed the §2.1 interpret-vs-blackbox boundary is real
(`validateSupportedPatternStatements`) and that access/construct reuse + per-op
throw isolation are sound.
