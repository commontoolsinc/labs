# Experimental Options

`ExperimentalOptions` are feature flags that gate incremental rollout of
various major features.

## Available Flags

| Flag | Env Var | Description |
|------|---------|-------------|
| `modernCellRep` | `EXPERIMENTAL_MODERN_CELL_REP` | Enables new "cell representation" classes |
| `persistentSchedulerState` | `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` | Enables durable scheduler observations, dirty state, and scheduler rehydration through memory-v2. |
| `computedCellIds` | `EXPERIMENTAL_COMPUTED_CELL_IDS` | Mints kind-tagged entity ids (`fid2:computed:`) for internal cells provably written only by compute nodes. Gates minting only; readers accept both forms. See `docs/specs/computed-cell-identity.md`. |
| `schedulerHistoricalMightWrite` | n/a (`RuntimeOptions` only) | Preserves the scheduler's legacy cumulative write history for dependency scheduling instead of the default current-known write set. |

All flags default to `undefined` which means they take on the default value
defined for the flag. The default is generally `false` unless the flag is in the
process of being "graduated." Setting any flag to `true` activates the
corresponding experimental behavior, and setting it to `false` suppresses the
experimental behavior (if it happened to be on by default).

Most flags are controlled by environment variables. Flags marked `n/a` in the
table are internal runtime options and currently have to be passed through
`new Runtime({ experimental: { ... } })`.

## Defining a new flag

Unfortunately, there is no single unified "source of truth" for the set of
flags. You pretty much need to search the codebase for an existing flag, and
tweak all the spots that turn up.

## Enabling Flags Locally

Set the corresponding environment variables before starting the server. The env
vars must be present both when **building the shell** (for browser-side flags)
and when **running the server** (for server-side flags):

```bash
# Enable a single flag (build + run)
EXPERIMENTAL_EXAMPLE_NAME=true deno task dev

# Enable multiple flags
EXPERIMENTAL_EXAMPLE_NAME_1=true \
EXPERIMENTAL_EXAMPLE_NAME_2=true \
deno task dev
```

The same env vars work for all entry points:

- **Toolshed server** (`packages/toolshed`): parsed via the Zod env schema in
  `env.ts`.
- **Shell build** (`packages/shell`): injected at build time via
  `felt.config.ts` defines, read from globals in `src/lib/env.ts`.
- **Background piece service** (`packages/background-piece-service`): parsed in
  `src/env.ts` and threaded to worker processes via IPC.
- **CF CLI** (`packages/cli`): the `cf` CLI reads experimental flags from the
  environment when constructing its `Runtime` instance.

**Important:** Because the shell uses build-time injection, toggling flags for
the browser requires rebuilding the shell. Server-side flags take effect
immediately on restart without a rebuild.

## How Flags Propagate

### Server-side (Deno processes)

Server-side propagation is straightforward: env vars are parsed and passed
directly to `new Runtime({ experimental: { ... } })`.

```
Server Process (Deno)
  |
  +-- ENV: EXPERIMENTAL_EXAMPLE_NAME_1=<value>
  |        EXPERIMENTAL_EXAMPLE_NAME_2=<value>
  |        ...
  |
  +-- toolshed/env.ts        --> Zod parses env vars
  +-- toolshed/index.ts      --> new Runtime({ experimental: { ... } })
                                    +-- setExperimentName1Config(...)
                                    +-- setExperimentName2Config(...)
                                    ...
```

### Browser-side (build-time injection)

Browser-side flags are injected at build time and carried to the Web Worker
via the IPC protocol:

```
Build Time (shell)
  |
  +-- ENV: EXPERIMENTAL_EXAMPLE_NAME_1=<value>
  |        EXPERIMENTAL_EXAMPLE_NAME_2=<value>
  |        ...
  |
  +-- felt.config.ts          --> esbuild define: $EXPERIMENTAL_*
  +-- src/lib/env.ts          --> EXPERIMENTAL.exampleName* = true
  |
Browser (Main Thread)
  |
  +-- shell/runtime.ts        --> reads EXPERIMENTAL from env.ts
  |
  +-- RuntimeClient.initialize(transport, { ..., experimental: EXPERIMENTAL })
        |
        | postMessage (IPC)
        | InitializationData { ..., experimental: { exampleName*: true } }
        |
        v
Browser Web Worker
  |
  +-- RuntimeProcessor.initialize(data)
        +-- new Runtime({ ..., experimental: data.experimental })
              +-- setExperimentName1Config(...)
              +-- setExperimentName2Config(...)
              ...
```

Key points:

1. For env-backed flags, the **env vars** are the single source of truth. They
   must be set at build time (for the shell) and at server start time (for
   toolshed).
2. The **shell build** bakes the flags into the JS bundle via esbuild defines.
3. The **IPC protocol** carries the flags from the main thread to the Web Worker
   via `InitializationData`.
4. The **Runtime constructor** calls experiment configuration functions, which
   collectively set up the ambient config for the system.

## Background Piece Service

The background piece service has its own propagation path:

```
packages/background-piece-service/src/main.ts
  --> new Runtime({ experimental: { ... } }) (reads from env.ts)
  --> BackgroundPieceService({ runtime })
  --> SpaceManager({ experimental: runtime.experimental })
  --> WorkerController({ experimental })
  --> worker.ts initialize({ experimental })
  --> new Runtime({ experimental })
```

Set the same `EXPERIMENTAL_*` env vars when starting the background piece
service.

## Verifying Flags Are Working

### Check the logs

When any experimental flags are explicitly overridden, the `Runtime`
constructor logs them on startup. Look for a line like:

```
Experimental flag overrides: someFlag=true, someOtherFlag=false
```

- **Server-side (toolshed):** Check `packages/toolshed/local-dev-toolshed.log`.
- **Client-side (shell):** Check the browser's developer console (the message
  comes from the Web Worker that hosts the runtime).

### Check the build output

You can also inspect the `EXPERIMENTAL` export from `src/lib/env.ts` in the
browser console to see the flag values baked into the shell build.

### Run the experimental options tests

```bash
cd packages/runner
deno test --allow-ffi --allow-env --allow-read test/experimental-options.test.ts
```

These tests verify that `Runtime` construction correctly sets and resets the
ambient config.

## Implementation Details

The flags are defined in `packages/runner/src/runtime.ts` as the
`ExperimentalOptions` interface. The `Runtime` constructor merges provided flags
with defaults (all `false`) and stores the resolved result as
`runtime.experimental` (type `Required<ExperimentalOptions>`).

- Only one set of experimental flags is active per JavaScript context at a time.
- In the browser, the Web Worker is a separate JS context, so its flags are
  independent of the main thread.
- Creating a new `Runtime` overwrites the ambient config; disposing it resets
  to defaults.
