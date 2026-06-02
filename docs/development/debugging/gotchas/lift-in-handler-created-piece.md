# lift() in a Handler-Created Piece Resolves Only at 1 Hop

**Symptom:** A piece opened via `navigateTo(SomePattern({ someCell, ... }))`
from inside a handler renders its own content fine (its `computed()` / `.get()`
reads of `someCell` resolve), but a `lift()` built from that same cell **one
level deeper** — in a nested child pattern the piece instantiates — returns
empty. e.g. a `cf-autocomplete` bound to it shows no options. No console error.
The identical component works when the piece is reached as a **root output**
(no handler in the chain), so it looks inconsistent.

```tsx
// WRONG — Viewer is handler-created; it passes its cell down to a nested child
// pattern whose lift() (2 hops from the handler) does NOT resolve → empty.
const Viewer = pattern<In, Out>(({ items }) => ({
  [UI]: <Composer items={items} />, // Composer does buildIndex({items}) internally
}));
// elsewhere: handler(..., () => navigateTo(Viewer({ items, ... })))

// CORRECT — build the lift in the handler-created piece's OWN body (1 hop —
// resolves) and bind the UI to that local result; inline the relevant UI
// rather than delegating to a nested child pattern.
const Viewer = pattern<In, Out>(({ items }) => {
  const index = buildIndex({ items });                  // 1 hop — resolves
  return { [UI]: <cf-autocomplete items={index} /> };   // bound to local lift result
});
```

**Why:** Cells passed through a handler's `navigateTo(...)` resolve for direct
reads (`computed` / `.get()`) in the created piece's body, but a `lift()` that
consumes them one level deeper (inside a child pattern the piece instantiates)
does not re-materialize. A root-output piece (no handler in the chain) doesn't
hit this, so a shared composer/child component that works fine in, say, a tab
can come up empty when reused inside a handler-created viewer. Build the lift in
the navigable piece's own body and inline the UI that binds to it.

## See Also

- ./piece-ui-must-be-vnode.md — sibling cold-load / handler-created-piece
  resolution gotcha
- @common/concepts/reactivity.md
