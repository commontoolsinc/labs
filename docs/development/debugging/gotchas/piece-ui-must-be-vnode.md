# Piece `[UI]` Must Be a VNode, Not a Bare Pattern Instance

**Symptom:** A pattern type-checks and deploys, its `[NAME]` shows in the
shell title, but its **body renders empty when the piece is opened cold**
(by slug or by raw id URL). Confusingly, it often renders fine when you
navigate to it from *within* an already-loaded app — so it looks like a
navigation bug when it's actually a render bug. No console error is
emitted.

```tsx
// WRONG — [UI] is a bare child-pattern instance. Cold-loads to an empty body.
export const Screen = pattern<In, Out>((ctx) => ({
  [NAME]: "Screen",
  [UI]: <SomeChildPattern foo={ctx.foo} />, // a pattern instance, not DOM
}));

// WRONG — [UI] is the return value of a plain helper that builds the VNode.
// This renders for the ROOT/deployed piece (its UI is materialized at deploy
// and served from storage) but NOT for a cold-loaded SUB-piece, which re-runs
// the pattern and gets an empty UI. Same code shape, different load path —
// which is exactly why the root screen looks fine while sub-screens don't.
export const Screen = pattern<In, Out>((ctx) => ({
  [NAME]: "Screen",
  [UI]: frame({ children: <Body /> }), // helper(...) call, not inline JSX
}));

// CORRECT — [UI] is a DOM-rooted VNode authored inline in the pattern body.
// Child patterns render fine when NESTED inside the DOM (e.g. CategoryRow).
export const Screen = pattern<In, Out>((ctx) => ({
  [NAME]: "Screen",
  [UI]: (
    <cf-screen>
      <SomeChildPattern foo={ctx.foo} />
    </cf-screen>
  ),
}));
```

**Why:** A navigable piece's top-level `[UI]` must resolve to a DOM-rooted
VNode that is authored inline in the pattern body. A bare pattern-instance
result is not rendered as the piece's own UI, and a helper that *returns*
the frame VNode only re-materializes for the root piece (served from
storage), not for a cold-loaded sub-piece that re-executes the pattern.

If you want a reusable layout/frame, either (a) inline its JSX in each
screen's `[UI]`, or (b) make the frame a real `pattern<>()` and nest its
instance **inside** a DOM root in the screen's `[UI]`
(`<div><Frame .../></div>`) rather than using it as the entire `[UI]` — but
note that nesting it changes layout context (e.g. a full-screen
`<cf-screen>` inside a wrapper `<div>` loses its viewport sizing), so
inlining the frame is usually the simpler fix.

## See Also

- @common/concepts/reactivity.md — reactive values and render context
- ./onclick-inside-computed.md — a related "renders/behaves differently than
  authored" gotcha
