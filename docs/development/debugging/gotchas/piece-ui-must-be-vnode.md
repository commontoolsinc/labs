# A Navigable Piece's UI Must Be Declared as the `[UI]` Symbol in the Output Type

**Symptom:** A pattern type-checks and deploys, its `[NAME]` shows in the
shell title, but its **body renders empty when the piece is opened cold**
(by slug or by raw id URL). It may look fine while navigating inside an
already-loaded app, so it reads like a navigation bug when it is actually a
*schema* bug. No console error is emitted.

```tsx
// WRONG — the Output type declares the UI under a plain `ui:` key, even
// though the body assigns the computed-symbol `[UI]`. The transformer emits
// the result schema from the DECLARED type, so the schema gets a plain `ui`
// property and NO `$UI`. A cold-loaded piece has no `$UI` to render → empty.
type ScreenOutput = {
  // ...
  ui: VNode; // ← plain key, not the [UI] symbol
};

export default pattern<In, ScreenOutput>((ctx) => {
  const ui = (<cf-screen>...</cf-screen>);
  return {
    [NAME]: "Screen",
    [UI]: ui, // runtime-only assignment; type-invisible because the
              // declared key is `ui`, not `[UI]`
    ui,
  };
});
```

```tsx
// CORRECT — the Output type declares the `[UI]` symbol. The value form is
// irrelevant: inline JSX, a bare child-pattern instance, or a helper that
// returns the VNode all work, because the schema is driven by the type.
interface ScreenOutput {
  [NAME]: string;
  [UI]: VNode; // ← the computed-symbol member; this is what emits `$UI`
}

export default pattern<In, ScreenOutput>((ctx) => ({
  [NAME]: "Screen",
  [UI]: <cf-screen>...</cf-screen>, // inline JSX — fine
}));
```

## Why

The ts-transformer emits a pattern's **result schema** from its **declared
Output type**, not from the runtime value you assign. The `[UI]` member is the
computed symbol `UI` (`Symbol.for("$UI")`), which the transformer lowers to the
`$UI` property in the schema and adds to `required`. If your Output type
declares the UI under a plain `ui:` key instead, the schema gets a plain `ui`
property and **no `$UI`** — so the shell has nothing to mount when the piece is
cold-loaded and re-executed.

The runtime `[UI]: ...` assignment in the body is type-invisible in that case:
the object still has a `[UI]` member at runtime, but it is not part of the
declared contract, so it never makes it into the schema the loader reads.

The **value form is not the bug.** All of these emit `$UI` as long as the
Output type declares `[UI]: VNode`:

- inline JSX (`[UI]: <cf-screen>...</cf-screen>`),
- a bare child-pattern instance (`[UI]: <Counter />`) — this is a sanctioned
  in-repo shape; see `_CounterView` in
  `packages/patterns/counter/counter.tsx`,
- a helper/`lift` call that returns the VNode (`[UI]: frame({ ... })`).

## Repro

Use the transformer to inspect the emitted result schema and grep for `$UI`:

```sh
mise exec -- deno task cf check <file> --show-transformed --no-run \
  | grep -n '$UI\|vnode.json\|required:'
```

**Correct shape** — `packages/patterns/counter/counter.tsx` (Output declares
`[UI]: VNode`):

```ts
properties: {
  value: { type: "number" },
  increment: { asCell: ["stream", "opaque"] },
  decrement: { asCell: ["stream", "opaque"] },
  $NAME: { type: "string" },
  $UI: { $ref: "https://commonfabric.org/schemas/vnode.json" }
},
required: ["value", "increment", "decrement", "$NAME", "$UI"]
```

The `_CounterView` wrapper in the same file uses a *bare* `<Counter />`
instance as its entire `[UI]` and still emits `$UI` (its Output declares
`[UI]: VNode`):

```ts
properties: {
  $UI: { $ref: "https://commonfabric.org/schemas/vnode.json" }
},
required: ["$UI"]
```

**Bug shape** — `packages/patterns/image-analysis.tsx` (Output declares
`ui: VNode`, body returns both `[UI]: ui` and `ui`). The schema has only a
plain `ui` property and **no `$UI`**:

```ts
properties: {
  images: { type: "array", items: { $ref: "#/$defs/ImageData" }, asCell: ["cell"] },
  prompt: { type: "string", asCell: ["cell"] },
  response: { type: ["string", "undefined"] },
  pending: { anyOf: [{ type: "undefined" }, { type: "boolean" }] },
  ui: { $ref: "https://commonfabric.org/schemas/vnode.json" }
},
required: ["images", "prompt", "response", "pending", "ui"]
```

## Fix

Declare the UI as the **`[UI]` symbol** in the Output type:

```ts
import { NAME, UI, type VNode } from "commonfabric";

interface ScreenOutput {
  [NAME]: string;
  [UI]: VNode; // not `ui: VNode`
  // ...other outputs
}
```

The value you assign to `[UI]` can stay exactly as it is — inline JSX, a child
pattern instance, or a helper call. Only the *declared member* needs to be the
`[UI]` symbol.

## See Also

- @common/concepts/reactivity.md — reactive values and render context
- ./onclick-inside-computed.md — a related "renders/behaves differently than
  authored" gotcha
