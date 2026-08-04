# Shell — Agent Guide

The browser-based shell: a Lit web-component application that hosts the piece
runtime and gives a user a way to move around their spaces. Entry point is
`src/index.ts`.

## Facts that will bite you

- `deno task dev` points at the **production** backend. For local work run
  `deno task dev-local`, which serves on `127.0.0.1:5173` and is reached through
  the toolshed proxy on port 8000, not directly. See
  [`LOCAL_DEV_SERVERS.md`](../../docs/development/LOCAL_DEV_SERVERS.md).
- Type checks and tests run from the workspace root, not from this package.
- `shared/` is shared source, not a subdirectory of `src/`. The `ui` package
  compiles the same files, and `./shared` is the only entry this package
  exports. A change there is a change to two packages.
- A component never writes application state. It calls `this.command(...)` from
  `BaseView`, which dispatches a composed, bubbling `shell-command` event that
  `RootView` catches and applies. `Command` is a closed union in
  `shared/app/commands.ts`, and `isCommand` rejects anything outside it at the
  boundary, so a new kind of state change means extending that union rather than
  reaching past it.
- Embed mode is a property of the route, not of a component. The `.embed` path
  prefix (`shared/app/view.ts`) strips shell-owned chrome, and every navigation
  has to preserve it — including one issued by a rendered pattern. A navigation
  that drops the prefix escapes the embedding host.
- The build tool is `@commonfabric/felt`, which lives in this repository at
  `packages/felt` rather than coming from a registry. Its configuration is
  `felt.config.ts`.
- Views use `@lit/task` for asynchronous work, and cleanup belongs in the
  component lifecycle. A task that outlives its component keeps writing into a
  disconnected tree.

## Where answers live

| Question                       | Read                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| The state shape                | `shared/app/state.ts`                                                                                        |
| What commands exist            | `shared/app/commands.ts`                                                                                     |
| How a command is applied       | `processCommand` in `src/views/RootView.ts`                                                                  |
| How the runtime is mounted     | `src/lib/runtime.ts`                                                                                         |
| Coding style and test commands | [`DEVELOPMENT.md`](../../docs/development/DEVELOPMENT.md), [`TESTING.md`](../../docs/development/TESTING.md) |
| Writing a `cf-` component      | the `lit-component` skill                                                                                    |
