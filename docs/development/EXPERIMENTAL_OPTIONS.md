# Experimental Options

`ExperimentalOptions` are feature flags that gate incremental rollout of
space-model data-layer changes. Each flag independently enables a piece of the
new storable-value pipeline so features can be activated one at a time without
affecting users who haven't opted in.

## Available Flags

| Flag | Env Var | Description |
|------|---------|-------------|
| `richStorableValues` | `EXPERIMENTAL_RICH_STORABLE_VALUES` | Enables the new storable value type system (`bigint`, `Map`, `Set`, `Uint8Array`, `Date`, `StorableInstance`). |
| `storableProtocol` | `EXPERIMENTAL_STORABLE_PROTOCOL` | Enables the storable protocol (`[DECONSTRUCT]`/`[RECONSTRUCT]`) and `SerializationContext`-based boundary serialization. |
| `unifiedJsonEncoding` | `EXPERIMENTAL_UNIFIED_JSON_ENCODING` | Enables a unified JSON encoding scheme for all storable values. |
| `canonicalHashing` | `EXPERIMENTAL_CANONICAL_HASHING` | Enables canonical hashing, replacing merkle-reference CID-based hashing (see Section 6 of the formal spec). |

All flags default to `false`. Setting any flag to `true` activates the
corresponding experimental behavior.

## Enabling Flags Locally

Set the corresponding environment variables before starting the server. The env
vars must be present both when **building the shell** (for browser-side flags)
and when **running the server** (for server-side flags):

```bash
# Enable a single flag (build + run)
EXPERIMENTAL_RICH_STORABLE_VALUES=true deno task dev

# Enable multiple flags
EXPERIMENTAL_RICH_STORABLE_VALUES=true \
EXPERIMENTAL_STORABLE_PROTOCOL=true \
deno task dev
```

The same env vars work for all entry points:

- **Toolshed server** (`packages/toolshed`): parsed via the Zod env schema in
  `env.ts`.
- **Shell build** (`packages/shell`): injected at build time via
  `felt.config.ts` defines, read from globals in `src/lib/env.ts`.
- **Background charm service** (`packages/background-charm-service`): parsed in
  `src/env.ts` and threaded to worker processes via IPC.
- **CLI script** (`scripts/main.ts`): read directly from `Deno.env`.

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
  +-- ENV: EXPERIMENTAL_RICH_STORABLE_VALUES=true
  |
  +-- toolshed/env.ts        --> Zod parses env vars
  +-- toolshed/index.ts      --> new Runtime({ experimental: { ... } })
                                    +-- setExperimentalStorableConfig(...)
                                    +-- setCanonicalHashConfig(...)
```

### Browser-side (build-time injection)

Browser-side flags are injected at build time and carried to the Web Worker
via the IPC protocol:

```
Build Time (shell)
  |
  +-- ENV: EXPERIMENTAL_RICH_STORABLE_VALUES=true
  |
  +-- felt.config.ts          --> esbuild define: $EXPERIMENTAL_RICH_STORABLE_VALUES
  +-- src/lib/env.ts           --> EXPERIMENTAL.richStorableValues = true
  |
Browser (Main Thread)
  |
  +-- shell/runtime.ts        --> reads EXPERIMENTAL from env.ts
  |
  +-- RuntimeClient.initialize(transport, { ..., experimental: EXPERIMENTAL })
        |
        | postMessage (IPC)
        | InitializationData { ..., experimental: { richStorableValues: true } }
        |
        v
Browser Web Worker
  |
  +-- RuntimeProcessor.initialize(data)
        +-- new Runtime({ ..., experimental: data.experimental })
              +-- setExperimentalStorableConfig(...)
              |    +-- currentConfig.richStorableValues = true
              |         +-- toStorableValue() checks currentConfig
              +-- setCanonicalHashConfig(...)
                   +-- canonicalHashingEnabled = true
                        +-- refer() dispatches to canonicalHash()
```

Key points:

1. The **env vars** are the single source of truth. They must be set at build
   time (for the shell) and at server start time (for toolshed).
2. The **shell build** bakes the flags into the JS bundle via esbuild defines.
3. The **IPC protocol** carries the flags from the main thread to the Web Worker
   via `InitializationData`.
4. The **Runtime constructor** calls `setExperimentalStorableConfig()`, which
   sets the module-level ambient config used by `toStorableValue()` and related
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

### Check the build output

After building the shell with flags enabled, the values are baked into the
bundle. You can verify by inspecting the `EXPERIMENTAL` export from
`src/lib/env.ts` in the browser console or by adding a temporary
`console.log(EXPERIMENTAL)` to the shell code.

### Run the experimental options tests

```bash
cd packages/runner
deno test --allow-ffi --allow-env --allow-read test/experimental-options.test.ts
```

These tests verify that `Runtime` construction correctly sets and resets the
ambient config, and that `toStorableValue()` dispatches based on the
`richStorableValues` flag.

## Implementation Details

The flags are defined in `packages/runner/src/runtime.ts` as the
`ExperimentalOptions` interface. The `Runtime` constructor merges provided flags
with defaults (all `false`) and stores the resolved result as
`runtime.experimental` (type `Required<ExperimentalOptions>`).

The memory layer uses module-level ambient config variables:
`currentConfig` in `packages/memory/storable-value.ts` (set by
`setExperimentalStorableConfig()`) and `canonicalHashingEnabled` in
`packages/memory/reference.ts` (set by `setCanonicalHashConfig()`). This means:

- Only one set of experimental flags is active per JavaScript context at a time.
- In the browser, the Web Worker is a separate JS context, so its flags are
  independent of the main thread.
- Creating a new `Runtime` overwrites the ambient config; disposing it resets
  to defaults.

See the formal spec at `docs/specs/space-model-formal-spec/` for the full
data model specification that these flags gate.
