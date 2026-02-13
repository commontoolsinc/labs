# Experimental Options

`ExperimentalOptions` are feature flags that gate incremental rollout of
space-model data-layer changes. Each flag independently enables a piece of the
new storable-value pipeline so features can be activated one at a time without
affecting users who haven't opted in.

## Available Flags

| Flag | Env Var | Description |
|------|---------|-------------|
| `richStorableValues` | `EXPERIMENTAL_RICH_STORABLE_VALUES` | Enables the new storable value type system (bigint, Map, Set, Uint8Array, Date, StorableInstance). |
| `storableProtocol` | `EXPERIMENTAL_STORABLE_PROTOCOL` | Enables the storable protocol (`[DECONSTRUCT]`/`[RECONSTRUCT]`) and `SerializationContext`-based boundary serialization. |
| `unifiedJsonEncoding` | `EXPERIMENTAL_UNIFIED_JSON_ENCODING` | Enables a unified JSON encoding scheme for all storable values. |

All flags default to `false`. Setting any flag to `true` activates the
corresponding experimental behavior.

## Enabling Flags Locally

Set the corresponding environment variables before starting the server:

```bash
# Enable a single flag
EXPERIMENTAL_RICH_STORABLE_VALUES=true deno task start

# Enable multiple flags
EXPERIMENTAL_RICH_STORABLE_VALUES=true \
EXPERIMENTAL_STORABLE_PROTOCOL=true \
deno task start
```

The same env vars work for all entry points:

- **Toolshed server** (`packages/toolshed`): parsed via the Zod env schema in
  `env.ts`.
- **Background charm service** (`packages/background-charm-service`): parsed in
  `src/env.ts` and threaded to worker processes via IPC.
- **CLI script** (`scripts/main.ts`): read directly from `Deno.env`.

## How Flags Propagate

The full propagation chain ensures every `Runtime` instance -- server-side and
browser-side -- receives the same experimental configuration:

```
Server Process (Deno)
  |
  +-- ENV: EXPERIMENTAL_RICH_STORABLE_VALUES=true
  |
  +-- toolshed/env.ts        --> Zod parses env vars
  +-- toolshed/index.ts      --> new Runtime({ experimental: { ... } })
  |                               +-- setExperimentalStorableConfig(...)
  |
  +-- GET /api/meta           --> { did: "...", experimental: { richStorableValues: true, ... } }
                                    |
                              HTTP response
                                    |
Browser (Main Thread)               v
  |
  +-- shell/runtime.ts       --> fetch("/api/meta")
  |                               extracts experimental flags
  |
  +-- RuntimeClient.initialize(transport, { ..., experimental })
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
                   +-- currentConfig.richStorableValues = true
                        +-- toStorableValue() checks currentConfig
```

Key points:

1. The **server** is the single source of truth. It parses env vars and exposes
   them via `/api/meta`.
2. The **shell** fetches `/api/meta` at runtime (no rebuild needed to toggle
   flags).
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

### Check the `/api/meta` endpoint

With the server running:

```bash
curl http://localhost:8000/api/meta | jq .
```

Expected output (with `EXPERIMENTAL_RICH_STORABLE_VALUES=true`):

```json
{
  "did": "did:key:z6Mk...",
  "experimental": {
    "richStorableValues": true,
    "storableProtocol": false,
    "unifiedJsonEncoding": false
  }
}
```

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

The memory layer uses a module-level ambient config variable (`currentConfig` in
`packages/memory/storable-value.ts`) set by `setExperimentalStorableConfig()`.
This means:

- Only one set of experimental flags is active per JavaScript context at a time.
- In the browser, the Web Worker is a separate JS context, so its flags are
  independent of the main thread.
- Creating a new `Runtime` overwrites the ambient config; disposing it resets
  to defaults.

See the formal spec at `docs/specs/space-model-formal-spec/` for the full
data model specification that these flags gate.
