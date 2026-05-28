# `(cellCall() ?? []).map(...)` nested in another `.map(...)` throws at construction

**Symptom:** Pattern instantiation aborts (no UI renders, `cf test` fails fast)
with one of these strings:

> Reactive reference from outer scope cannot be accessed via closure. Wrap the
> access in a derive that passes the variable through, or use computed() which
> handles this automatically.

> Cannot access cell via closure - reactive dependencies must be explicit
> parameters.

The "outer scope" reference is a top-level pattern-body **cell**; the access is
inside the inner `.map(...)` callback of a pattern like
`{ outer.map((row) => (cellCall() ?? []).map((el) => …) )}`.

## The shape that triggers it

```tsx
{rows.map((row) => (
  <div>
    {row.label}
    {/* WRONG — the receiver of the inner .map is `(people.get() ?? [])`. The
        transformer types it as `T[]` and emits no `mapWithPattern` wrapper,
        but at runtime `people.get()` is an OpaqueRef and `.map` pushes a new
        frame. The inner handler then sees `setAssign` (a cell from the outer
        frame) and throws at construction time. */}
    {(people.get() ?? []).map((p) => (
      <button onClick={() => setAssign.send({ name: p.name })}>
        {p.name}
      </button>
    ))}
  </div>
))}
```

Why this passes type-check but blows up at runtime: the policy at
`packages/ts-transformers/src/policy/rewrite-policy.ts:62-64` classifies
binary-expression receivers (`??`, `||`, `()`) whose LHS is a reactive call as
*plain* JS arrays. No `mapWithPattern` rewrite is inserted (the supported escape
hatch at `packages/runner/src/cell.ts:1743-1766`). At runtime the receiver is
still an OpaqueRef; `CellImpl.map` pushes a frame; the runner's frame check at
`packages/runner/src/builder/node-utils.ts:15-19` throws because the inner
callback's `setAssign`/`onClick` refer to a cell from the *outer* frame.

The trap is that the well-meaning `?? []` guard for the scoped-`.get()` race
(see [scoped-cell-pitfalls.md #5](./scoped-cell-pitfalls.md)) is the exact thing
that hides the cell from the transformer.

## Three idiomatic recipes (in preference order)

### A — Map the cell directly (preferred)

```tsx
{rows.map((row) => (
  <div>
    {row.label}
    {people.map((p) => (
      <button onClick={() => setAssign.send({ name: p.name })}>
        {p.name}
      </button>
    ))}
  </div>
))}
```

No `.get()`, no `??`. The transformer sees an OpaqueRef receiver and emits
`mapWithPattern`, which hoists captured pattern-scope refs into params (the
canonical fixture: `packages/ts-transformers/test/fixtures/closures/cell-map-with-captures.expected.jsx:35-90`).

### B — Pre-bake into a top-level `computed`, then `.map`

When you need to *transform* the list first (filter empties, project to names,
etc.) — do it at the top level once, not per row:

```tsx
const peopleNames = computed(() =>
  (people.get() ?? []).map((p) => p.name).filter((n) => (n ?? "").trim() !== "")
);

// …in JSX:
{rows.map((row) => (
  <div>
    {row.label}
    {peopleNames.map((name) => (
      <button onClick={() => setAssign.send({ name })}>{name}</button>
    ))}
  </div>
))}
```

The receiver is now an OpaqueRef again; the transformer rewrites the inner
`.map`. Shipping example:
`packages/patterns/factory-outputs/lot-watch/main.tsx:1443-1447`
(definition) consumed at `:2110-2118`.

### C — Explicit `derive({deps}, …)` inside the row callback

Only when neither A nor B is structurally possible. Pass the cells you need as
explicit deps so the transformer doesn't have to infer reactivity from the
closure:

```tsx
{rows.map((row) => {
  const chips = derive({ people }, ({ people }) =>
    people.map((p) => p.name)
  );
  return <div>{chips.map((n) => <button>{n}</button>)}</div>;
})}
```

## The anti-pattern to remember

```tsx
// 🚫 (reactiveCall() ?? plainFallback).map(…) inside an outer .map((row) => …)
```

Whenever you find yourself writing that shape, switch to recipe A or B. The
contrast with recipe B's *top-level* `(people.get() ?? []).map(…)` is critical:
the top-level form is fine (its receiver is plain JS by the time the outer
`computed` produces it), the *nested* form is not.

## Reconciliation with the working "blessed" pattern

`packages/patterns/factory-outputs/parking-coordinator/main.tsx:1358-1385`
does NOT read a cell via closure inside its row `.map`. It pre-bakes the
booleans into `adminPeopleData` (recipe B), then the per-row JSX at lines
1982–1998 reads `person.isEditing` — a *property of the OpaqueRef element*,
not an outer cell. No rule violation. Don't take the surface shape of
`computed(() => editingPersonName.get() === personName)` as license to read
arbitrary outer-scope cells from inside a `.map` callback.

## Distinct from the perSession-scope bug

The
[perSession-in-mapped-computed gotcha](./persession-read-in-mapped-computed.md)
fires at link-resolution time, *silently* returns nothing, and is about
narrower-scope follows from a space-scoped reading context
(`packages/runner/src/scope.ts:61-69`,
`packages/runner/src/link-resolution.ts:248-258`). This rule fires at
*construction time*, *loudly* throws, and is about cells from the *outer*
builder frame being captured by an *inner* builder frame
(`packages/runner/src/builder/node-utils.ts:15-19`). Same era, different
layer, different fix recipe. Don't conflate them.

## Tracked framework concern

The transformer policy gap (binary-expression receivers wrapping reactive
calls aren't recognized) and the diagnostic-vs-runtime-error split are filed
as `LINEAR-TICKET-closure-capture-in-nested-map.md` — separate from the
perSession scope-follow ticket.
