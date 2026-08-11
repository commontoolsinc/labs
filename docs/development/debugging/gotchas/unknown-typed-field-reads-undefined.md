# A field typed `unknown` reads back as undefined

**Symptom:** a field holds a real value — another piece, a nested object — and
every read of it through the declaring type is `undefined`. No compile error, no
runtime error, no warning. Rendering the same path still works, which is what
makes this confusing: `<cf-render $cell={entry.piece} />` shows the piece while
`entry.piece.label` right beside it is undefined.

```typescript
// Shown at module scope.
interface Entry {
  type: string;
  piece: unknown; // holds a link to another piece
}
```

**Why:** `unknown` lowers to the schema `{ type: "unknown" }`, and the runner's
traversal will not materialize an **object or array** read under it: those two
arms short-circuit to `undefined` (`runner/src/traverse.ts`,
`_traverseWithSchemaInner`). A primitive is unaffected — the string, number,
boolean and null arms treat the same schema as a match and return the value — so
a field typed `unknown` that holds a string reads back fine, and only one that
holds an object or a list goes quiet. An `asCell` alongside it also still
produces a cell; `{ type: ["unknown", …] }` and an `anyOf` with an unknown branch
behave like the bare form.

The path survives even when the value does not, which is why cells and rendering
still work: a `$cell` binding passes the path, and the renderer reads it under a
schema of its own (`asSchema(rendererVDOMSchema)` — `runner/src/runner.ts` on the
mainline path, `shell/src/views/BodyView.ts`, and `html/src/in-process.ts` when
the reconciler runs in the caller's own process), while every read of the
*value* comes back empty.

Two transformer diagnostics cover neighbouring cases and neither catches this
one: `reactive-capture:unknown-type` reports a closure capture whose inferred
type is `unknown`, and `schema:unknown-type-access` reports a property typed
`unknown` accessed directly on a lift or handler parameter
(`ts-transformers/src/transformers/type-shrinking.ts`). Reaching the field
through an array element inside a callback, as below, is outside both.

## What decides whether a read materializes

The schema of the **operand the value is read into**, not the schema the field
was declared with. A lift or handler that names the fields it wants gets them:
the read follows the link into the target and materializes them, and re-runs
when the target changes them.

```typescript
// Shown at module scope.
// The operand names the field, so this read follows the link and materializes.
const readLabel = lift<{ piece: { label?: string } }, string | undefined>(
  ({ piece }) => piece?.label,
);
```

Three rules decide whether such a read reaches the value:

**Name the property.** Naming it is what reliably overrides a declared field
schema. An operand of `entries?: any[]` can lower to `items: true`, and a `true`
schema defers to the schema the cell itself carries (`traverse.ts`,
`combineOptionalSchema`: a true parent falls through to
`combineSchema(parentSchema, linkSchema)`) — with `piece: unknown` still inside
it, so `entries[0].piece` is undefined. `entries?: { piece: any }[]` names the
property, and the piece materializes: the same read of
`entries[0].piece.nickname` yields the module's real nickname under the second
operand and `undefined` under the first.

Do not read `any[]` as always lowering to `items: true`. Type shrinking narrows
an operand from the accesses in the lift body, so a body that indexes a literal
position can get a structural schema that materializes, while the same
annotation with a variable index gets `items: true` and does not. Naming the
fields is what makes the read independent of that; `--show-transformed` below is
how to see which one you got.

**Apply the lift where the value is still a link.** A `.map()` at pattern-body
scope keeps each element reactive, so a lift applied inside it is a real lift
application on a link. The same `.map()` inside a `computed()` is not: the whole
`computed()` body becomes a single lift, and the `.map()` there is plain
JavaScript over the already-materialized list, where the field is already
`undefined`.

```typescript
// Shown at module scope.
const readEntryLabel = lift<{ piece: { label?: string } }, string | undefined>(
  ({ piece }) => piece?.label,
);

export default pattern<{ entries: { type: string; piece: unknown }[] }>(
  ({ entries }) => {
    // Each element is still a link here, so the lift reads through it. The
    // same expression inside a `computed()` would not.
    const labels = entries.map((entry) =>
      readEntryLabel({ piece: entry.piece as { label?: string } })
    );
    return { labels };
  },
);
```

**In a handler, ask for a cell.** A handler receives its operands as values, so
there is no link left to follow. Type the field as a `Cell<...>` and call
`get()` on it:

```typescript
// Shown at module scope.
interface ListEntry {
  type: string;
  piece: unknown;
}
type EntryHandle =
  & Omit<ListEntry, "piece">
  & { piece: Cell<Record<string, unknown>> };

const reportFirstLabel = handler<
  { result: Writable<unknown> },
  { entries: Writable<EntryHandle[]> }
>(({ result }, { entries }) => {
  result.set(entries.get()[0]?.piece?.get()?.label);
});
```

The declaring type and the operand type describe the same cell; the call site
casts between the two views. Casting **to** a `Cell<>` is rejected by the
transformer, so a handler that also builds new entries cannot take this view of
the list it writes: the entry it constructs would have to be cast into it.

## Confirming it

The emitted operand schema is the ground truth, and
`--show-transformed` prints it:

```bash
deno task cf check <pattern>.tsx --show-transformed --no-run
```

A field you expect to read shows as `{ type: "unknown" }` when the read will
come back undefined, and as the shape you named when it will materialize.

## Where this has bitten

`packages/patterns/record.tsx` holds each of its modules as
`SubPieceEntry.piece: unknown`. Every feature that read a field off a module —
the module's own label in its header, the icon a record-icon module carries, the
aliases a nickname module carries, the settings dialog's contents, the LLM
summary's per-module data, and the smart-default label picker — read `undefined`
and silently fell back, each discovered separately. The label picker was fixed
by recording the chosen label on the entry beside the piece; the rest read
through the module, as above. See `packages/patterns/record-module-fields.test.tsx`
and `packages/patterns/integration/record-module-chrome.test.ts`.
