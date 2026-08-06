# What a Derivation Reads

Every derivation — a `computed()`, an expression the transformer auto-lifts, an
explicit `lift()` — carries a generated **input schema**. That schema is not
documentation of the derivation: it *is* the read. The runtime materializes
exactly the paths the schema declares and nothing else.

So the schema decides how much of a space a single derived value pulls in. Over
a plain array of strings that is a rounding error. Over a list of pieces it is
not: an element schema that describes the piece fully pulls whatever that type
declares — its fields, its streams, its rendered `[UI]` VDOM — and then
whatever those link to in turn. One derived value can end up reading a whole
space.

This document is about which spellings bound that read and which spellings
give it up.

## Seeing the schema

The transformer's output is the ground truth, and it is one command away:

```bash
deno task cf check ./donut-board.tsx --show-transformed
```

Each derivation appears as a `__cfLift_N` with its input schema inline. This is
worth reading whenever a derived value feels expensive — the schema tells you
what it costs before you deploy anything.

## A plain reactive input narrows to the paths the body reaches

When an input is declared without `Writable<>`, the transformer tracks the
property paths the body reaches and emits only those:

```tsx
// Shown at module scope.
interface Donut { glaze: string; sprinkles: string[] }

export default pattern<{ donuts: Donut[] }>(({ donuts }) => {
  const donutCount = computed(() => donuts.length);
  const glazes = computed(() => donuts.map((donut) => donut.glaze));
  return { [UI]: <div>{donutCount}{glazes}</div> };
});
```

`donutCount` emits `donuts: { type: "object", properties: { length: … } }` — it
does not even describe an array, because nothing but the length is read.
`glazes` emits an array whose element schema is `{ glaze: string }`; the
`sprinkles` of every donut are never fetched.

Object inputs narrow the same way, per property. A body that reaches
`baker.name` emits a `baker` schema with `name` and nothing else.

## A `Writable<>` input is delivered whole

A `Writable<>` (or `Cell<>`) input is handed to the derivation as a live cell,
at its **full declared type**. Reading through `.get()` does not narrow it:

```tsx
// Shown at module scope.
interface Donut { glaze: string; sprinkles: string[] }

export default pattern<{ donuts: Writable<Donut[]> }>(({ donuts }) => {
  const firstGlaze = computed(() => donuts.get()[0].glaze);
  return { [UI]: <div>{firstGlaze}</div> };
});
```

`firstGlaze` emits the complete `Donut` element schema — `sprinkles` included —
even though the body reaches one field of one element.

There is one narrowing that survives a cell capture. When the body reads an
array for nothing but its length — no path reaches an element — the element
type collapses:

```tsx
// Shown at module scope.
interface Donut { glaze: string; sprinkles: string[] }

export default pattern<{ donuts: Writable<Donut[]> }>(({ donuts }) => {
  const donutCount = computed(() => donuts.get().length);
  return { [UI]: <div>{donutCount}</div> };
});
```

That emits `donuts: { type: "array", items: { type: "unknown" }, asCell: […] }`,
and at runtime the elements come back as `null` — the links are resolved to
count them, and no field behind any of them is fetched.

**This is the practical reason to omit `Writable<>` when you do not write.**
[Reactivity and Write Access](../reactivity.md) states the rule as a matter of
intent; the schema is where it becomes a cost. An input you only display, typed
`Writable<>` out of habit, is read whole by every derivation that touches it.

## An opaque call widens the read back to everything

The analysis narrows only what it can see. Hand a value to a function it
cannot see through and it records a read of the whole value, and the full
declared schema comes back:

```tsx
// Shown at module scope.
interface Donut { glaze: string; sprinkles: string[] }

// A small helper in another module — opaque to the analysis.
declare function toList<T>(value: readonly T[]): T[];

export default pattern<{ donuts: Donut[] }>(({ donuts }) => {
  const donutCount = computed(() => toList(donuts).length);
  return { [UI]: <div>{donutCount}</div> };
});
```

That emits the full `Donut` element schema. The helper's body is irrelevant —
even a one-line `(v) => v` has this effect, because opacity is about what the
analysis can follow, not about what the function does.

The same applies to **any method call on a `.get()` result**, built-ins
included. On a plain input, `donuts.map((donut) => donut.glaze)` narrows to
`{ glaze }`; on a `Writable<>` input, `donuts.get().map((donut) => donut.glaze)`
emits the full element schema. A `.filter()`, a `.sort()`, a `.join()`, or a
chain through any of them behaves the same way.

On a plain input, then: property access and index access are followed, a call
is not. On a `Writable<>` input the value already arrives whole, and a call
only forfeits the length-only collapse above.

## Two costs, not one

**Bytes and subscriptions.** The obvious one: a wider schema fetches more, and
subscribes to more, so the derivation also re-runs more often.

**Scope.** The less obvious one, and the one that produces startup behavior
nobody asked for. Every read ratchets the transaction's narrowest read scope
(`recordReadScope` in
`packages/runner/src/storage/extended-storage-transaction.ts`), and the runtime
derives the derived value's output scope from where that ratchet lands. Reach
into anything session-scoped — a `PerSession` UI fragment inside a piece you
read whole, for instance — and the entire derived value becomes session-scoped,
which means it is computed and written again for every session.

A schema that stops above the session-scoped value keeps the derivation at
space scope. A schema that describes the element fully does not, and no amount
of the body "not really using" that field changes it: the schema is the read.

The scope machinery is specified in
[cell scopes](../../../specs/server-side-execution/scopes.md).

## Bounding a read you cannot narrow

When the body genuinely needs an opaque helper, move the derivation into a
`lift()` and **declare the parameter type**. A declared parameter is emitted
verbatim as the schema, and it is a ceiling the helper's opacity cannot raise:

```tsx
// Shown at module scope.
declare function toList<T>(value: readonly T[]): T[];

// toList() is opaque to the analysis; the declared parameter bounds it anyway.
const countDonuts = lift((args: { donuts: { glaze: string }[] }) =>
  toList(args.donuts).length
);
```

That emits exactly `donuts: { type: "array", items: { type: "object",
properties: { glaze: … } } }` — nothing else about a donut is read, however the
body is written.

This is what `lift()` is for. Reuse across patterns is a convenience;
bounding the read of a body the analysis cannot follow is the capability
`computed()` does not have.

## When a derived value looks too expensive

1. Run `deno task cf check <file> --show-transformed` and find the derivation's
   `__cfLift_N`.
2. If its input schema describes more than the body needs, look for the cause
   in this order: a `Writable<>` on an input you never write, a call on a
   `.get()` result, a helper the analysis cannot see through.
3. Drop the `Writable<>`, or rewrite the body in property and index access, or
   move it to a `lift()` with a declared parameter type.
4. Re-run `--show-transformed` and confirm the schema shrank.
