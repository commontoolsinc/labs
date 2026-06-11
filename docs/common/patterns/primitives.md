# Primitives: the composition contract

A **primitive** is a pattern designed to be embedded inside other patterns —
used as a JSX tag, not deployed standalone. Primitives own a slice of *logic and
model* (an editable list, a confirm-action gate, a master/detail selection)
while leaving rendering to the host. They live under
`packages/patterns/primitives/` and form the `primitive` tier in
[`packages/patterns/index.md`](../../../packages/patterns/index.md).

This document defines the contract every primitive follows. The worked example
is `EditableList` (`packages/patterns/primitives/editable-list.tsx`); later
primitives (ConfirmAction, MasterDetail) follow the same shape.

## What a primitive exposes

In priority order:

1. **Cells + Streams pre-bound to the caller's data.** This is the real
   product. The caller passes a `Writable<T>` it owns; the primitive binds its
   handlers to that cell and returns the bound `Stream<>`s. The caller wires
   nothing by hand — passing the cell *is* the wiring.
2. **A convenience layer** of fuzzy / agent-friendly Streams (e.g.
   text-addressed `*ByText`). Optional, additive, clearly labelled as
   convenience — never the core model.
3. **An optional default `[UI]`.** A static `VNode` giving a caller who just
   wants the thing a working experience for free. A caller who wants custom
   rendering simply does not render it.

## The crux: a sub-pattern CAN mutate a parent-owned cell

This is the question that makes or breaks embedding, and the answer is **yes**.

When a parent writes:

```tsx
const list = EditableList({ items: myItems }); // myItems: Writable<Item[]>
```

the primitive receives the **same** reactive cell — not a copy. Handlers inside
the primitive that call `items.push(...)` / `items.set(...)` mutate the parent's
cell, and the change syncs back to the parent automatically. Evidence:

- [`reactivity.md`](../concepts/reactivity.md): `Writable<>` is *write intent*
  on a shared reactive cell, not a fresh cell.
- [`composition.md`](./composition.md): "Both patterns receive the same `items`
  cell — changes sync automatically."
- `packages/patterns/examples/cf-render.tsx`: the embedded `Counter` mutates the
  parent's `state.value` via its own handler.

Because of this, a primitive does **not** need the parent to pass in Streams or
handlers. The primitive defines the handlers, binds them to the cell it was
given, and hands the bound Streams back. (The escape hatch — a primitive that
genuinely cannot mutate its input, e.g. a cross-space owner-protected cell —
would instead expose Streams the parent wires to its own handlers. EditableList
does not need this; same-space `Writable<T[]>` mutation works.)

## Identity, not index, not title (collection primitives)

For **collection** primitives — ones that own a list/set of items
(`EditableList`, `MasterDetail`) — core mutations address an item by **live
reference**, using the data model's own identity: `removeItem` takes `{ item }`
and calls `cell.remove(item)`; `updateItem` / `toggleItem` locate the item with
`findIndex((x) => equals(x, item))`. The runtime gives array items implicit
entity identity that survives reorder and field mutation, and `equals()` /
`remove()` compare by that identity — a row rendered from `items.map(...)`
already holds the reference it needs to send.

Two things are explicitly **not** the identity model:

- **Array indices.** Index-based selection/mutation breaks under reordering and
  concurrent edits — the central fragility this composition overhaul removes.
- **User-land id fields.** NEVER mint `id` properties (UUIDs, counters,
  timestamps) on items. The reactive fabric is an object graph, not a keyed
  database; synthetic ids fight the reactivity system (in `.map()` callbacks an
  `id` property is a Cell, not a string, so lookups fail silently). See
  [`identity.md`](../concepts/identity.md) ("No ID generation") and
  [Custom `id` Property Pitfall](../../development/debugging/gotchas/custom-id-property-pitfall.md).

Primitives with no collection (e.g. `ConfirmAction`, a single-gate primitive)
have nothing to address and this section does not apply to them.

Title/text addressing, where offered, is a **separate, explicit convenience
layer** (e.g. `removeItemByText`) — the agent-facing string-addressing story for
LLMs that only have words. It is fuzzy (case-insensitive, first-match) and
documented as such. It sits *on top of* the reference-addressed core; it is not
the identity model.

## Headless vs default rendering

- **Default (rendered):** drop the primitive in your vdom and render its `[UI]`:

  ```tsx
  <EditableList items={myItems} />
  ```

  You get the built-in experience. The default UI is opinionated about item
  shape — for EditableList it reads `done` (checkbox) and `label` (text). That
  assumption applies *only* to the default UI.

- **Headless (logic only):** embed for the model, render your own rows:

  ```tsx
  const list = EditableList({ items: myItems });
  // ...elsewhere in your vdom:
  {list.items.map((it) => (
    <my-row>
      <span>{it.label}</span>
      <cf-button onClick={() => list.toggleItem.send({ item: it })}>
        toggle
      </cf-button>
    </my-row>
  ))}
  ```

  A headless caller may ignore the default UI's shape assumptions entirely and
  key rows off whatever extra fields it added to its items (the item type carries
  an index signature so extra fields pass through the model untouched).

  Caveat: extras pass through as **plain data only**. An index signature emits
  `additionalProperties: true`, which has no `asCell` marker, so a `Writable<>` /
  cell-link extra is **not** re-hydrated as a live Cell when read back through
  the item schema (the "any → true schema → can't distinguish Writable from
  computed" gotcha). Scalars and plain objects round-trip fine; an item that
  needs a nested *live* cell must declare it as a typed field with `asCell`
  rather than relying on the index-signature passthrough.

### Why no render-prop / VNode input

A primitive does **not** accept a "render each row" callback or `VNode` input.
Render props and VNode-valued inputs fight the CTS transformer and the
reactive reconciler (`[UI]` must be a static VNode; passing functions/VNodes as
reactive inputs leads to "unexpected object" reconciler errors). The headless
path — consume cells + streams, render your own `.map()` — achieves full custom
rendering without that machinery.

## Authoring checklist

- Item type carries whatever the model needs — **no `id` field**; an index
  signature lets callers extend it.
- Core handlers address items by live reference (`equals()` /
  `cell.remove(item)`), bound to the caller's `Writable<T[]>`.
- Counts / derived values are **named `computed` cells** (so they resolve
  through `runSynced` + `.get()` in tests).
- `[UI]` is a static `VNode`; gate empty/non-empty with `ifElse` as a *child* of
  a static wrapper, never by wrapping `[UI]` in `computed()`.
- Default rows use `$checked` / `$value` two-way binding — do not add setter
  handlers that just write the same value back.
- Optional convenience (`*ByText`) streams are additive and documented as fuzzy.

## See also

- [Pattern Composition](./composition.md) — the embedding mechanics.
- [Reactivity](../concepts/reactivity.md) — why `Writable<>` shares a cell.
- `packages/patterns/primitives/editable-list.tsx` — the worked example.
