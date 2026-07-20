---
status: historical
created: 2026-07-15
archived: 2026-07-15
reason: "Executed: power-assert diagnostics for pattern-test assertions shipped; the transformer README and pattern-testing guide describe the system now."
---

# Power-assert diagnostics for pattern-test assertions

## The problem

A pattern test declares assertions as `{ assertion: Reactive<boolean> }`,
normally produced by `computed(() => condition)`. The author's comparison runs
inside the author's own closure, so the operands collapse to a single boolean
before the harness ever sees them. A failing assertion can therefore only
report `Expected true, got false`. It cannot say what the operands were.

The goal is that a failing `a + b <= c` reports that `a + b` was 3 and `c` was
2, that a failing `f(x, y)` reports `x` and `y`, and so on: the operands of the
top-level operator and the arguments of calls, each labelled with its authored
source text and its rendered value.

## Enabling facts

These were established by running `deno task cf check <probe>.tsx
--show-transformed --no-run` and `deno task cf test <probe>.tsx` against
throwaway probe patterns. They are the non-obvious constraints that shape the
design, and each one invalidates an otherwise-reasonable approach.

### The lowered lift body is plain synchronous JavaScript

`computed(() => a.get() + b.get() <= c.get())` emits:

    const __cfLift_1 = __cfHelpers.lift<{...}, boolean>(
      ({ a, b, c }) => a.get() + b.get() <= c.get(),
      /* input schema */, /* output schema */, /* options */
    );
    const cmp = __cfLift_1({ a: a, b: b, c: c }).for("cmp", true);

The reactive leaves are hoisted into an explicit capture set and the body is
ordinary JavaScript over resolved values. The classic power-assert AST rewrite
therefore applies to that body with no reactive or laziness complications: the
reactivity all lives outside the body.

### The diagnostic can travel in the reactive value

The harness holds only `stepCell.key("assertion")` — a cell. It cannot trace
that cell back to a source site, so a side-channel capture buffer keyed by
assert-id has no key the harness can look up. Carrying the diagnostic in the
value the harness already pulls avoids that linkage problem entirely.

It also removes the staleness question. The harness re-pulls a failing
assertion up to three times to let the graph settle. A pulled value is by
construction the result of the most recent evaluation, whether or not the
memoized lift actually recomputed, so the reported operands always match the
reported failure.

### The returned record must be a concrete type

This is the constraint that dictates the shape of the emitted code.

A field whose inferred type is `unknown` gets `{ type: "unknown" }` in the
output schema, and a consumer reading such a field back materializes it as
`undefined`. The compiler rejects this outright for pattern outputs:

    error: pattern() output field `check` has inferred type `unknown`, so the
    output schema carries `{ type: "unknown" }` there. A consumer that reads
    such a field back materializes it as `undefined`.

So the assertion body must not return `boolean | Diagnostic` (a union), and
must not return `any` or `unknown`. It returns one concrete record type on
both the passing and the failing path, and the harness reads its `ok` field.

`__cfHelpers` is declared `any`, so a call to a helper hung off it returns
`any` and collapses the schema to `unknown`. The emitted code must reach its
helpers through a *typed* export instead. `__cf_data` / `__cfDataHelper` is
the existing precedent for a typed injected helper.

### Casts cannot paper over any of this

`CastValidationTransformer` rejects `as unknown as` outright:

    error: Double-casting via 'as unknown as' is not allowed. Casts bypass
    reactive tracking and type safety.

So `assert()`'s declared type must be honest about what it returns, and
`TestStep` must widen to accept it rather than being cast around.

### End-to-end confirmation

A probe pattern whose assertion body was a hand-written imitation of the
intended emitted shape — block body, local buffer, capture calls around each
operand, concrete record return — produced this from the existing harness:

    ✗ assertion_1
        Expected true, got {"ok":false,"source":"a + b <= c","parts":[
          {"src":"a + b","rendered":"3"},{"src":"c","rendered":"2"}]}

The record survives the reactive graph, storage, and `pull()` intact. What
remains is generating it from the transformer and rendering it in the harness.

## Design

### Instrument before lowering, not after

The instrumentation pass runs *before* `LiftLoweringTransformer`, on the
authored AST, rather than on the lowered body. Two things fall out of that:

- The operand labels are the author's own source text (`a + b`), taken
  straight from the authored node. Instrumenting the lowered body would
  instead label the operand `a.get() + b.get()`, and recovering the authored
  text would mean reconstructing spans through `getOriginalNode` /
  `getSourceMapRange`.
- The existing reactive lowering rewrites `a + b` into `a.get() + b.get()`
  inside the capture-call arguments exactly as it otherwise would, so no
  lowering logic is duplicated or bypassed.

### Emitted shape

`assert(() => a + b <= c)` becomes a computed whose body is:

    () => {
      const __parts = [];
      const __ok = __cfAssert.capture(__parts, "a + b", a + b)
                <= __cfAssert.capture(__parts, "c", c);
      return __cfAssert.result(__ok, "a + b <= c", __parts);
    }

`capture` records the source text and value and returns the value unchanged,
so evaluation order and semantics are untouched. `result` renders the captured
values with `toCompactDebugString` only when the assertion failed, so the
passing path stays cheap, and returns the concrete record type either way.

### Recognizing `assert`

`assert` is registered in `commonfabric-runtime-registry.ts` as a builder that
maps to `builderName: "computed"`. The registry already carries a `builderName`
field distinct from `exportName`, currently an identity mapping for every
entry; honouring it in builder resolution is a no-op for existing entries and
lets `assert` reuse every stage that already handles `computed`, instead of
threading a new builder name through the seven stages that special-case it.

### Reaching the helpers without an import

The emitted body needs a runtime function to record and render values, and it
needs concrete types. It cannot get them from a new injected import: only
`__cfHelpers` is injected in practice (`injectCfDataHelper` has no production
callers), and an import added at AST level binds too late for the checker to
type it — symbol binding happens before the pipeline runs.

Instead the body reaches the runtime through `__cfHelpers`, which *is* the
commonfabric module object at runtime (`commonfabric.__cfHelpers =
commonfabric` in the builder factory), and contains the `any` that comes back
from it behind inline type annotations:

    const __cfAssertParts: { src: string; rendered: string }[] = [];
    const __cfAssertOk: boolean = <instrumented expression>;
    return { ok: __cfAssertOk, source: "...", parts: __cfAssertParts };

The annotations are inline type literals, so no type name needs importing, and
the inferred return type is concrete.

### The gate, and why the body shape is not optional

`assert()`'s declared type has to match the value it actually produces. The
probe worked because its declared type matched; `CastValidationTransformer`
forbids papering over a mismatch; and a declared type of `boolean` against a
record value would have the output schema disagree with the stored value.

So `assert` declares `Reactive<AssertRecord>`, `TestStep` widens to accept it,
and the pass **always** rewrites an `assert` body into the record shape. If
the rewrite were skipped, the body would return a bare boolean while the
declared type promised a record, and the schema and the value would disagree.
The transform option therefore controls only whether the capture calls are
inserted — the record shape itself is unconditional.

This still satisfies the production requirement, and does so structurally: the
pass only ever rewrites `assert(...)` calls. Every other expression is passed
through untouched, so emitted output — and the `implementationFingerprint`
that persistent scheduler state keys on — is byte-identical for all existing
code. `assert` is new test-only API and appears in no production pattern. A
test asserts the byte-identical property for a non-assert expression.

## Stages

- [x] `assertCapture` runtime helper and `assert` builder implementation
- [x] `assert` builder: registry entry, builder-name resolution, api surface
- [x] Instrumentation transformer, with the `assertDiagnostics` option
- [x] Render the record in `packages/cli/lib/test-runner.ts`
- [x] Byte-identical output test for a non-assert expression
- [x] Control-flow forms (`?:`, `&&`, `||`, `??`)

## Scope

Covered: the comparison and arithmetic operators, call arguments, `!`, and the
short-circuit and conditional forms.

Only `assert` is instrumented. Instrumenting every `computed`/`lift` would add
overhead everywhere and perturb the reactive graph.

## Corrections found while implementing

Two things assumed above turned out to be wrong, and are recorded here because
the reasoning that led to them looks sound until it is tested.

**Short-circuit and conditional operators do not need a second pass.** The plan
assumed control-flow lowering hoists `&&`, `||` and `?:` out of the body into
separate reactive nodes, following the note in `utils/expression.ts` that they
are "peeled off earlier by control-flow lowering". That is true at a JSX
expression site but not inside a lift body: `emitBinaryExpression` returns
early for these operators when `inSafeContext`, which a lift body is. They
survive as plain JavaScript and are instrumented in the same body rewrite as
everything else. Wrapping the operands preserves short-circuiting on its own,
because a capture on the right of `&&` only runs if the left let it — so an
operand the assertion never evaluated is never recorded, with no special case.

**A typed helper import was not needed.** The plan proposed reaching the
runtime through a typed injected export, on the grounds that `__cfHelpers` is
`any` and would collapse the schema to `unknown`. Two inline type annotations
in the emitted body — on the parts array and on the boolean result — contain
the `any` instead, and the explicit return type annotation on the callback is
what schema injection reads. No new import, injected or otherwise.
