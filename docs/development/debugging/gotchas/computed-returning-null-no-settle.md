# computed() Returning null Doesn't Settle

**Symptom:** `Too many iterations` during settle — no error is thrown. Daemon
deploys SKIP and the piece renders "Untitled"/blank; at runtime the reactive
scheduler is pegged and queued events (e.g. `navigateTo`) never commit, so taps
appear dead.

**Cause:** A render `computed()` whose output toggles between `null` (or
`undefined`/nothing) and a VNode over a **reactive** read. The reactive node's
presence in the tree blinks in and out, so the reconciler never reaches a fixpoint.
(Distinct from `immediate-event-invocation.md` — there it's a render-time `.send()`;
here it's the computed's *return value* flipping between empty and a node.)

```tsx
// WRONG - output flips empty vs VNode over a reactive read
{computed(() => {
  const items = attachments.get() ?? [];
  if (items.length === 0) return null;       // ⛔ does not settle
  return <cf-hstack>{items.map(renderChip)}</cf-hstack>;
})}
```

## Fix

A render `computed()` must ALWAYS return exactly one VNode — never `null`. Hide the
empty case instead.

**Form A — toggle `display`** (when the empty and non-empty states share one
element, e.g. a list that's either populated or empty):

```tsx
{computed(() => {
  const items = attachments.get() ?? [];
  return (
    <cf-hstack style={{ display: items.length === 0 ? "none" : "flex" }}>
      {items.map(renderChip)}
    </cf-hstack>
  );
})}
```

`cf-vstack`/`cf-hstack` host elements are `display: block` (the flex layout lives on
an internal shadow `.stack`). Only force `display: flex` on the host when you need
`flex-wrap` there; otherwise toggle `"none"`/`"block"` so you don't alter layout.

**Form B — hidden placeholder** (different subtrees, or to keep the visible branch
byte-identical):

```tsx
{computed(() => {
  if (cond) return <cf-vstack style={{ display: "none" }}></cf-vstack>;  // a node, not null
  return <section />;
})}
```

## What is NOT this bug

- A `computed` that always returns a node — even a hidden one
  (`<x style="display:none"/>`) — settles fine. (`mobile-frame`-style always-render
  wrappers rely on this.)
- Inline JSX `{cond ? <x/> : null}` in a **static child slot** of a stable parent —
  fine. It's an authored slot, not a reactive node blinking in and out.

## See Also

- gotchas/immediate-event-invocation.md — another `Too many iterations` cause (a render-time `.send()`)
- gotchas/onclick-inside-computed.md — onClick-handler pitfalls in render computeds (incl. the conditional-`onClick` raw-function variant)
- @common/concepts/reactivity.md — reactivity system and `computed()`
