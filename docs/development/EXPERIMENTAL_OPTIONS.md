# Experimental Options

`ExperimentalOptions` are feature flags that gate incremental rollout of
space-model data-layer changes. Each flag independently enables a piece of the
new fabric-value pipeline so features can be activated one at a time without
affecting users who haven't opted in.

## Available Flags

| Flag | Env Var | Description |
|------|---------|-------------|
| `modernDataModel` | `EXPERIMENTAL_MODERN_DATA_MODEL` | Enables the new fabric value type system (`bigint`, `Map`, `Set`, `Uint8Array`, `Date`, `FabricInstance`). |
| `unifiedJsonEncoding` | `EXPERIMENTAL_UNIFIED_JSON_ENCODING` | Enables a unified JSON encoding scheme for all fabric values. |
| `modernHash` | `EXPERIMENTAL_MODERN_HASH` | Enables canonical hashing, replacing merkle-reference CID-based hashing (see Section 6 of the formal spec). |
| `modernSchemaHash` | `EXPERIMENTAL_MODERN_SCHEMA_HASH` | Enables modern schema hashing, replacing stableStringify-based schema hashing. |

All flags default to `false`. Setting any flag to `true` activates the
corresponding experimental behavior.

## Enabling Flags Locally

Set the corresponding environment variables before starting the server. The env
vars must be present both when **building the shell** (for browser-side flags)
and when **running the server** (for server-side flags):

```bash
# Enable a single flag (build + run)
EXPERIMENTAL_MODERN_DATA_MODEL=true deno task dev

# Enable multiple flags
EXPERIMENTAL_MODERN_DATA_MODEL=true \
EXPERIMENTAL_UNIFIED_JSON_ENCODING=true \
deno task dev
```

The same env vars work for all entry points:

- **Toolshed server** (`packages/toolshed`): parsed via the Zod env schema in
  `env.ts`.
- **Shell build** (`packages/shell`): injected at build time via
  `felt.config.ts` defines, read from globals in `src/lib/env.ts`.
- **Background charm service** (`packages/background-charm-service`): parsed in
  `src/env.ts` and threaded to worker processes via IPC.
- **CT CLI** (`packages/cli`): the `ct` CLI reads experimental flags from the
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
  +-- ENV: EXPERIMENTAL_MODERN_DATA_MODEL=true
  |
  +-- toolshed/env.ts        --> Zod parses env vars
  +-- toolshed/index.ts      --> new Runtime({ experimental: { ... } })
                                    +-- setDataModelConfig(...)
                                    +-- setModernHashConfig(...)
                                    +-- setSchemaHashConfig(...)
```

### Browser-side (build-time injection)

Browser-side flags are injected at build time and carried to the Web Worker
via the IPC protocol:

```
Build Time (shell)
  |
  +-- ENV: EXPERIMENTAL_MODERN_DATA_MODEL=true
  |
  +-- felt.config.ts          --> esbuild define: $EXPERIMENTAL_MODERN_DATA_MODEL
  +-- src/lib/env.ts           --> EXPERIMENTAL.modernDataModel = true
  |
Browser (Main Thread)
  |
  +-- shell/runtime.ts        --> reads EXPERIMENTAL from env.ts
  |
  +-- RuntimeClient.initialize(transport, { ..., experimental: EXPERIMENTAL })
        |
        | postMessage (IPC)
        | InitializationData { ..., experimental: { modernDataModel: true } }
        |
        v
Browser Web Worker
  |
  +-- RuntimeProcessor.initialize(data)
        +-- new Runtime({ ..., experimental: data.experimental })
              +-- setDataModelConfig(true)
              |    +-- modernDataModelEnabled = true
              |         +-- fabricFromNativeValue() checks modernDataModelEnabled
              +-- setModernHashConfig(...)
              |    +-- modernHashEnabled = true
              |         +-- hashOf() dispatches to hashOfModern()
              +-- setSchemaHashConfig(...)
                   +-- modernSchemaHashEnabled = true
                        +-- schemaHashOf() dispatches to modern path
```

Key points:

1. The **env vars** are the single source of truth. They must be set at build
   time (for the shell) and at server start time (for toolshed).
2. The **shell build** bakes the flags into the JS bundle via esbuild defines.
3. The **IPC protocol** carries the flags from the main thread to the Web Worker
   via `InitializationData`.
4. The **Runtime constructor** calls `setDataModelConfig()`, which
   sets the module-level ambient config used by `fabricFromNativeValue()` and related
   functions.

## Background Charm Service

The background charm service has its own propagation path:

```
bg-charm-service/src/main.ts   --> new Runtime({ experimental: { ... } })
                                     (reads from env.ts)
                                --> BackgroundCharmService({ runtime })
                                     --> SpaceManager({ experimental: runtime.experimental })
                                          --> WorkerController({ experimental })
                                               --> worker.ts initialize({ experimental })
                                                    --> new Runtime({ experimental })
```

Set the same `EXPERIMENTAL_*` env vars when starting the background charm
service.

## Verifying Flags Are Working

### Check the logs

When any experimental flags are enabled, the `Runtime` constructor logs them on
startup. Look for a line like:

```
Experimental flags enabled: modernDataModel, unifiedJsonEncoding, modernHash, modernSchemaHash
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
ambient config, and that `fabricFromNativeValue()` dispatches based on the
`modernDataModel` flag.

## Implementation Details

The flags are defined in `packages/runner/src/runtime.ts` as the
`ExperimentalOptions` interface. The `Runtime` constructor merges provided flags
with defaults (all `false`) and stores the resolved result as
`runtime.experimental` (type `Required<ExperimentalOptions>`).

The memory layer uses module-level ambient config variables:
`modernDataModelEnabled` in `packages/data-model/fabric-value.ts` (set by
`setDataModelConfig()`), `modernHashEnabled` in
`packages/data-model/value-hash.ts` (set by `setModernHashConfig()`), and
`modernSchemaHashEnabled` in `packages/data-model/schema-hash.ts` (set by
`setSchemaHashConfig()`). This means:

- Only one set of experimental flags is active per JavaScript context at a time.
- In the browser, the Web Worker is a separate JS context, so its flags are
  independent of the main thread.
- Creating a new `Runtime` overwrites the ambient config; disposing it resets
  to defaults.

See the formal spec at `docs/specs/space-model-formal-spec/` for the full
data model specification that these flags gate.
