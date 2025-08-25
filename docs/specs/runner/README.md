# Runner Spec

- Scope: `packages/runner` core runtime behavior. Focus on Cell abstraction,
  data updating and links, schema-driven reads (asCell/asStream/anyOf), and the
  scheduler. Storage backends and docs UI are out of scope except for the
  high-level transactions API used by runner.

- Audience: contributors building recipes, modules, or runtime features that
  need precise semantics for reads/writes, link resolution, and reactivity.

Contents

- `cell.md`: Cell abstraction and API semantics
- `data-updating-and-links.md`: Write normalization and link handling
- `schema.md`: Schema-driven read behavior
- `scheduler.md`: Reactive dependency tracking and execution
- `transactions.md`: Transactions contract used by runner
- `builder.md`: Behavioral spec of builder authoring model
- `runner.md`: Runner engine behavior (process cells, nodes, handlers)
