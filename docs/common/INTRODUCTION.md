The Common Tools runtime is a fully integrated, reactive runtime and execution environment for user-created programs built using Typescript + `deno`. Each pattern is a `.tsx` file (that may import from other `.tsx` files) and exports a component comprised of reactive `Cell`s stored in `Space`s (defined by a DID). These cells enable durable communication between patterns. The reactivity is enabled by subscribing to the result of a query, defined by the schemas/type signatures.

## Mental Model

Unlike React, patterns are programs that define a reactive graph once upfront rather than being repeatedly re-invoked. This is analogous to [Solid.js](https://docs.solidjs.com/quick-start) components with signal networks. Authors use `computed()` and `lift()` for derived values, and `action()` for handling events.

Want to see it in action? `packages/patterns` contains working examples of many patterns.

## Background

`Cell`s enable durable communication between patterns, creating networks of user-defined programs. Reactivity is enabled through subscription to the result of a query, defined by the schemas/type signatures expressed in a pattern.

Each pattern is composed of `Cell`s (passed in as `Inputs`), [lifted functions](https://en.wikipedia.org/wiki/Lift_(mathematics)), which operate on `Cell`s in a monad-like way, and `Stream`s which are stateless channels written to using `.send()` to send a value. These `Stream`s are used to implement `Handlers`, functions that handle user-events and mutate `Cell`s in response. Patterns make use of the built-in operators defined in `packages/api` and implemented in `packages/runner`.

A pattern returns a `Result` `Cell`, including special fields like `[UI]` (renderable html, composed of custom UI components (from `packages/ui`) as well as any number of user-defined key-value pairs. 

Patterns are free to import from other patterns and compose together into reactive graphs. Patterns are lightweight and should be used exploratively to validate claims and understand usage patterns. The `ct` binary (also available via `deno task ct`) is used to compile and typecheck patterns interactively.
