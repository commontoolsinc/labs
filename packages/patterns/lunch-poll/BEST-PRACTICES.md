# Lunch Poll Pattern Best Practices

These notes are likely general best practices for Common Fabric pattern
composition, deployed pattern iteration, and UI-bearing sub-patterns. For now we
are collecting them here while developing the lunch poll pattern, so they can
stay close to the concrete examples and regressions that taught them. Once the
same rules prove useful outside this poll, they should be promoted into the
shared pattern documentation.

## Sub-Pattern Composition

- A function-call sub-pattern instance is an output object. Use named fields
  such as `child.someStream` or `child.someComputed` for non-UI outputs. If the
  same child also renders UI, validate the exact embedding form in the browser;
  nested mapped composition has shown differences from `cf test`.
- JSX-only embedding remains appropriate when the parent does not need outputs:
  `<Child prop={value} />`.
- Be careful embedding a function-call child UI inside another mapped child
  while also reading the child's outputs. On deployed browser state, this can
  settle differently from `cf test`; keep data-heavy rendering at the boundary
  that owns the data unless browser validation proves the nested composition.
- If a parent only needs generated data, fetch state, streams, or other
  non-visual outputs, do not function-call a UI-bearing child and hide its
  `[UI]`. Split out a headless helper/pattern or keep the data fetch in the
  parent, then render from durable parent-owned data.
- Keep `[UI]` outputs as static VNodes. Do not wrap the whole UI in
  `computed(() => <... />)`. Use `computed` for data and branch values, then
  render those values from ordinary JSX.
- Parent and child input/output names are exact contracts. Direct imports beside
  `main.tsx` keep composition boundaries explicit.

## Mapped Children

- When instantiating a sub-pattern inside `array.map(...)`, make every child
  field read explicit in the map body. Passing a reactive item object through
  without touching its fields can produce a narrowed element schema that omits
  fields the child needs.
- Resolve `PerUser` values once at the parent level before entering per-item
  maps. Pass the resolved value, such as `me`, into mapped sub-patterns instead
  of passing the raw `PerUser` cell.
- Avoid inventing shared state inside a child. The parent should own durable
  `PerSpace`/`PerUser` cells and pass them down; children may own only local UI
  state appropriate to their boundary.

## Rendering From Data

- Gate a card from the data it actually renders when possible. For example, a
  "recent rows" card should use the visible row query as the rendering source,
  not only a separate aggregate count query that may settle differently.
- Treat aggregate queries and derived counters as supporting signals unless they
  are the only data needed for the UI.
- Keep large static assets, such as fallback data-URI images, outside lifted
  computeds. Render generated or stored images as overlays only after a safe
  non-empty URL resolves.
- For large data-URI image `src` values, compute only the boolean gate. Use the
  original input or fetch result directly as `src`; do not route the large URI
  itself through a lifted `computed` before rendering.
- Treat generated image presence as transport success, not visual QA. A stored
  data URL can be valid 128x128 image bytes and still be visually blank; check
  the rendered thumbnail when image quality matters.

## Testing And Deployment

- Focused pattern tests are part of the contract for non-trivial sub-patterns.
  Tests should assert rendered behavior, not only underlying state transitions.
- Multi-user tests are required when identity, `PerUser`, host/admin state, or
  cross-viewer behavior moves across a composition boundary.
- Validate against populated existing state before deploying over a live piece.
  Fresh local state can miss regressions involving stored images, existing
  votes, joined identities, and SQLite-backed history.
- After `setsrc`, verify both normal cell-backed state and non-cell-backed
  capabilities such as SQLite query outputs. Browser console probes are useful
  when CLI reads do not subscribe or a remote websocket is unreliable.

## Documentation

- Each reusable sub-pattern should document its overall purpose, not only its
  input/output fields. A caller should be able to decide whether to use it from
  the overview comment plus interface docs.
- Prefer generic descriptions when a sub-pattern could move into a shared
  library later. Keep lunch-specific wording only where the behavior is truly
  lunch-poll-specific.
