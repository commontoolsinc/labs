# Common Fabric Documentation

Documentation for building **patterns** — reactive TypeScript programs that run
on the Common Fabric runtime.

## Mental Model

- A pattern is a `.tsx` file (may import other `.tsx` files) that exports a
  component built from reactive `Cell`s. Cells live in `Space`s (identified by
  a DID) and enable durable communication between patterns.
- Unlike React, a pattern body runs **once** to define a reactive graph; it is
  not re-invoked on every change (closest analogy: Solid.js signal networks).
  Use `computed()`/`lift()` for derived values and `action()`/`handler()` for
  events. Reactivity comes from subscribing to queries defined by schemas/type
  signatures.
- A pattern returns a result cell containing `[UI]` (JSX rendered with the
  `cf-*` components from `packages/ui`) plus any named key-value outputs. A
  running, instantiated pattern is called a **piece**.
- Patterns compose freely: import another pattern, instantiate it, link cells.
  Working examples live in `packages/patterns/`. Compile and typecheck with
  the `cf` CLI (`deno task cf`).

## Start Here by Task

| Task | Read |
|------|------|
| Build a pattern | [ai/pattern-development-guide.md](ai/pattern-development-guide.md) |
| Write tests | [ai/pattern-testing-guide.md](ai/pattern-testing-guide.md) (mechanics: [workflows/pattern-testing.md](workflows/pattern-testing.md)) |
| Review / critique a pattern | [ai/pattern-critique-guide.md](ai/pattern-critique-guide.md) |
| Manual / runtime testing | [ai/manual-testing-guide.md](ai/manual-testing-guide.md) |
| Pattern Factory build phase | [ai/pattern-factory-build-guide.md](ai/pattern-factory-build-guide.md) |
| Author CFC helpers | [ai/cfc-helper-authoring-guide.md](ai/cfc-helper-authoring-guide.md) |
| Style / UI work | [patterns/style.md](patterns/style.md) → [patterns/ui-cookbook.md](patterns/ui-cookbook.md) → [components/COMPONENTS.md](components/COMPONENTS.md) |
| Something broke | [../development/debugging/README.md](../development/debugging/README.md) |

## Index

### concepts/ — the programming model

- [concepts/pattern.md](concepts/pattern.md) — what a pattern is; inputs, outputs, `[UI]`, `[NAME]`
- [concepts/reactivity.md](concepts/reactivity.md) — the cell system, read/write access, reactive mental model
- [concepts/computed/computed.md](concepts/computed/computed.md) — `computed()`, `lift()`, derived values
- [concepts/action.md](concepts/action.md) — handling events with `action()`
- [concepts/handler.md](concepts/handler.md) — reusable parameterized handlers with `handler()`
- [concepts/factories.md](concepts/factories.md) — passing, storing, invoking, and closing over first-class factories
- [concepts/identity.md](concepts/identity.md) — object identity, `equals()`, why `===` fails across cells
- [concepts/self-reference.md](concepts/self-reference.md) — self-referential types with `SELF`
- [concepts/types-and-schemas/writable.md](concepts/types-and-schemas/writable.md) — `Writable<>` and write access in type signatures
- [concepts/types-and-schemas/default.md](concepts/types-and-schemas/default.md) — `Default<>` for input defaults
- [concepts/glossary.md](concepts/glossary.md) — definitions of pattern, piece, cell, space, etc.

### patterns/ — authoring recipes

- [patterns/two-way-binding.md](patterns/two-way-binding.md) — `$value` binding vs handlers; the `equals()` removal idiom
- [patterns/new-cells.md](patterns/new-cells.md) — creating cells with `new Writable()`
- [patterns/conditional.md](patterns/conditional.md) — conditional rendering with plain ternaries
- [patterns/view-switching.md](patterns/view-switching.md) — switching between views with `computed()`
- [patterns/navigation.md](patterns/navigation.md) — navigating to detail views
- [patterns/composition.md](patterns/composition.md) — composing patterns into reactive graphs
- [patterns/multi-user-patterns.md](patterns/multi-user-patterns.md) — shared spaces, per-user state, collaboration
- [patterns/style.md](patterns/style.md) — styling and theme guide (design brief, tokens, fonts)
- [patterns/ui-cookbook.md](patterns/ui-cookbook.md) — worked UI layout vignettes
- [patterns/meta/drag-and-drop.md](patterns/meta/drag-and-drop.md) — drag-and-drop with `cf-drag-source` / `cf-drop-zone`

### components/ — the UI library

- [components/COMPONENTS.md](components/COMPONENTS.md) — index of all `cf-*` components, bindable props, usage narrative
- [components/forms.md](components/forms.md) — stub; form authoring lives in COMPONENTS.md, internals in `packages/ui/docs/`
- [components/CELL_CONTEXT.md](components/CELL_CONTEXT.md) — `cf-cell-context` debugging tool

### conventions/ — system integration

- [conventions/wish.md](conventions/wish.md) — discovering pieces with `wish()`; scopes, favorites, profiles
- [conventions/mentionable.md](conventions/mentionable.md) — exposing and consuming mentionable pieces
- [conventions/adding-pieces.md](conventions/adding-pieces.md) — adding pieces to a space via the `addPiece` handler
- [conventions/HOME_SPACE.md](conventions/HOME_SPACE.md) — home space, user identity, default patterns
- [conventions/summary.md](conventions/summary.md) — the summary convention for pieces

### capabilities/ — built-in effects

- [capabilities/llm.md](capabilities/llm.md) — `generateText` / `generateObject`; reactive results, no `await`
- [capabilities/fetch.md](capabilities/fetch.md) — `fetchJson` / `fetchText` / `fetchJsonUnchecked` / `fetchBinary`; reactive results, no `await`

### workflows/ — CLI and testing mechanics

- [workflows/development.md](workflows/development.md) — `cf` CLI loop: check, deploy, setsrc, inspect, link
- [workflows/pattern-testing.md](workflows/pattern-testing.md) — writing and running pattern tests
- [workflows/handlers-cli-testing.md](workflows/handlers-cli-testing.md) — invoking mounted callables from the CLI

[INTRODUCTION.md](INTRODUCTION.md) is a stub kept for older links; this README
replaces it.
