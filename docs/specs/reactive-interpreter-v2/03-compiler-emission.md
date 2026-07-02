# 03 — Compiler emission: the single lowering

The transformer stops emitting builder *calls* for the reactive skeleton and
emits IR *ops*. Opaque leaves remain compiled JS — hoisted, content-addressed
module exports — referenced from the IR. This document covers what the
transformer pipeline becomes, the function-lowering algorithm, allow-list
governance, and the test regime.

## 1. What replaces what

| Today (v1 / main) | v2 |
| --- | --- |
| `PatternOwnedExpressionSiteLoweringTransformer` wraps each expression site into `__cfHelpers.lift(({a,b}) => a+b)({a,b})` | The expression-site pass emits `expr`/`access`/`construct`/`control`/`interpolate` ops into the pattern's ROG under construction |
| §08 branded `exprLift("expr:+", ([a,b]) => a+b)` dual encoding | Gone. The op *is* the artifact; the flag-off path runs the expander's output ([01-decisions.md](./01-decisions.md) D-V2-ARTIFACT §1) |
| Closure hoisting (CT-1644) hoists every lift body to module scope | Retained **only for opaque leaves** — which are now the *only* things with bodies. Every opaque leaf is a module-scope, content-addressed export by construction; the fresh-closure provenance problem class (v1's `str` hoisting fix, `elementLeafImplRefResolvable`) cannot occur |
| Schema injection (CT-1615) as a second pass over lift modules | Type info flows at emit time: `outSchema` per op from the checker (v1 08 E-5), interned into the schema table. The two-pass structure can remain internally; the output is IR handles |
| `module-scope-cf-data` wrapping + `TRUSTED_BUILDERS` + `callbackIndexesForBuilder` for every new builder shape | Applies only to the builder-DSL front-end and opaque-leaf modules. The IR blob is inert data — no wrapping, no verifier cases per vocabulary addition |
| `.expected.jsx` golden fixtures of emitted builder calls | IR goldens (serialized ROG) for lowered forms + `.expected.jsx` retained for what still emits as JS (opaque leaves, handler bodies) |

Source mapping is a first-class requirement, not an afterthought: every op
carries a source range from the authored expression (v1's
`setSourceMapRange`-on-synthetic-arrow wart, made structural), and a test
asserts ranges survive the round-trip.

## 2. Pattern-body lowering

Unchanged in principle from v1 08 §2.1: a pattern body is provably
expression-only (`validateSupportedPatternStatements`), so the body lowers
completely — JSX expression containers, template spans, returns, call
arguments, object/array literals — into ops. Explicit `computed`/`lift`
callbacks are classified by the same body analysis as helpers (§3): a
single-expression or Tier-1 body lowers; a body outside the subset becomes an
opaque leaf.

Calls taxonomy at a call site (v1 08 OQ-E4, now decided):

- callee is an I/O or handler builtin → `effect` boundary op with full
  contract ([02-ir.md](./02-ir.md) §2.4);
- callee is a collection HOF on a reactive list → `collection` op with the
  callback lowered as the element Rog (or opaque element leaf if the callback
  is out of subset);
- callee is a same-bundle function → `call(FnId)` if the body lowers (§3),
  else opaque leaf;
- callee is a stdlib-registry method → `call(builtin)`;
- anything else (external import, dynamic callee, `new`) → opaque leaf.

## 3. Function lowering (the "go further")

For each function reachable from pattern code within the compiled bundle, the
compiler runs a **capability analysis** over the body:

```text
lowerable(fn) :=
  every statement is: const declaration | if/else | return
  ∧ every expression is in the supported vocabulary
      (operators ∪ access ∪ construct ∪ interpolate ∪ calls per §2 taxonomy)
  ∧ no mutation (assignment, ++/--, mutating stdlib methods)
  ∧ no try/catch, no loops (for/while; array HOFs are calls, handled above)
  ∧ not async, no await, no generators
  ∧ no ambient reads (Date.now, Math.random, globals outside the registry)
  ∧ no recursion (direct or mutual, over the bundle call graph)
```

Lowering is then mechanical:

- `const x = e` → a named op in the `FnDef` body frame (SSA by construction —
  `const` cannot rebind).
- `if (c) return a; ...; return b` → nested `control` ops (early-return
  chains are right-associated conditionals).
- The terminal expression/return → the `FnDef` result ref.

Anything failing a clause → the whole function stays an opaque leaf, **at
compile time, recorded in the artifact** with the failing clause as the
reason (this replaces v1's runtime census: coverage reporting becomes a
compiler statistic you can assert on in CI).

Two deliberate conservatisms, revisit-able later: loop bodies are never
lowered even when provably pure (a `for` over an array should have been a
HOF; lowering imperative loops to fold ops is Tier-3 future work), and a
helper taking a callback parameter is opaque unless every call site passes a
lowerable lambda (higher-order helpers need monomorphization — defer).

## 4. Allow-list governance — one registry

v1 duplicated the operator allow-list between the transformer
(`rewrite-policy.ts`) and the runtime (`rog.ts`) with no sync mechanism, and
its review found the emitter dispatch was not fail-closed by construction
(E-2). v2:

- **One shared registry module** (importable by the ts-transformers package,
  the runner evaluator, and the oracle-corpus generator) defines: operator
  set, control semantics variants, stdlib entries
  `{ id, arity, receiverType, semanticsRef, oracleCorpusRef }`.
- The compiler emits a native op **only** via a registry lookup; the
  evaluator refuses ids not in its registry version (both sides fail closed
  across artifact-version skew).
- A registry entry is added only together with its oracle rows
  ([06-migration-plan.md](./06-migration-plan.md) §4). The nasty-semantics
  rows are mandatory per entry class: coercions for `+`/relational, `==` vs
  `===`, `NaN`/`-0`/`Infinity`, falsy-but-defined operands for
  operand-return control, int32/uint32 for bitwise, locale-independence for
  string methods, sparse arrays and holes for array methods.

## 5. What the builder front-end emits

Hand-built patterns (the builder DSL, `cf.*`) construct the same IR at
runtime: builder factories append ops to a Rog under construction instead of
minting legacy node descriptors. The DSL surface does not change; the graph
it builds does. This is bounded work — the builder's vocabulary is already
the IR's vocabulary — and it is what retires extraction *completely* instead
of keeping a decompiler alive for one caller.

## 6. Compile-time eligibility

The artifact records, per pattern: which ops are boundaries, which regions
are pure, the partition input (or the partition itself — see
[04-execution.md](./04-execution.md) §2 for why the partition stays a
load-time step), and the opaque-leaf census with reasons. The runtime makes
**no eligibility decisions**: it validates the artifact format, resolves
opaque-leaf refs through the artifact index, and executes. A malformed or
version-skewed artifact fails closed to the legacy-expanded path — the only
runtime "fallback", and it is a loader property, not a per-shape judgment.
