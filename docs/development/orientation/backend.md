# The backend: `toolshed`, `background-piece-service`, `llm`

`toolshed` is the deployed backend. It is a single Deno process built on the
Hono HTTP framework, and it does an unusual amount: it is the durable-storage
server, it runs a runtime of its own, it is an LLM gateway, it does OAuth for a
handful of third-party providers, and it serves the `shell` frontend.
`background-piece-service` is a separate process that runs pieces on a timer.
`llm` is a thin client library that talks to `toolshed`'s LLM endpoints.

`toolshed` has **no package name** in its `deno.jsonc`, because it is an
application, not an importable library. It is launched from `index.ts`.

`background-piece-service` (package `@commonfabric/background-piece`) was called
`background-charm-service` until the charm-to-piece rename. The directory,
package, and source all say "piece" now — the word "charm" appears nowhere in
the package. A couple of persisted identifiers were deliberately left unchanged
so existing spaces keep resolving (the `bgUpdater` stream name and a dated cause
string); those are legacy-shaped, not "charm" — see the note under Technical
debt below.

---

## The deployed topology

```mermaid
flowchart LR
    browser["Browser"]
    subgraph toolshed["toolshed process"]
        hono["Hono app (app.ts)"]
        mem["in-process MemoryServer<br/>(SQLite, one file or a directory)"]
        rt["a runner Runtime<br/>(connects back to its own MEMORY_URL)"]
        gw["LLM gateway routes"]
    end
    bcs["background-piece-service<br/>(separate process)"]
    providers["Anthropic / OpenAI / Groq / Vertex / gateway"]
    extras["OAuth providers, code-exec sandbox,<br/>web search/read, image, voice"]

    browser -- "WebSocket: memory protocol" --> mem
    browser -- "HTTP: static shell, REST" --> hono
    hono --> mem
    hono --> rt
    hono --> gw --> providers
    hono --> extras
    bcs -- "WebSocket: memory protocol" --> mem
    bcs -- "HTTP: /api/ai/llm" --> hono
```

The thing to internalize: **`toolshed` is both a memory server and a memory
client.** It serves the durable store over a WebSocket, and it also holds a
`runner` runtime that connects back to that same store to run patterns
server-side. New readers find this confusing until they see both wirings in
`index.ts`.

---

## Environment and configuration

Everything is driven by a single Zod `EnvSchema` in `env.ts`. The variables a
newcomer trips on:

- **Storage location is two mutually-exclusive modes.** `MEMORY_DIR` (a directory
  of one SQLite file per space, the default `./cache/memory/`) versus `DB_PATH`
  (one absolute-path SQLite file, for clustering; the schema rejects a
  non-absolute value). `MEMORY_URL` (default `http://localhost:8000`) is the URL
  toolshed's own runtime connects back through.
- **A provider is registered by the mere presence of its key.** The LLM keys are
  all `CFTS_AI_LLM_*` (`ANTHROPIC`, `OPENAI`, `GROQ`, plus AWS/Google-Vertex and a
  few declared-but-currently-unwired ones like `CEREBRAS`/`PERPLEXITY`/`XAI`).
  `CFTS_AI_GATEWAY_URL` is a Tailscale-only gateway with clean fallback.
- **Access control.** `MEMORY_ACL_MODE` is `off` / `observe` / `enforce` (default
  `enforce`); `MEMORY_SERVICE_DIDS` is a comma-separated list of DIDs granted an
  implicit OWNER on every space — this is how the background service authorizes
  itself.
- `SANDBOX_SERVICE_URL` (external code-exec), `SHELL_URL` (dev-proxy target),
  and the OTEL block (`OTEL_ENABLED`, endpoint default `http://localhost:4318`,
  sampler config) round it out. A `boolFlag()` helper treats only `"true"`/`"1"`
  as true, on purpose — `z.coerce.boolean()` would turn the string `"false"` into
  `true`.

The server framework glue lives in `lib/`: `create-app.ts` builds the
`OpenAPIHono` app and serves an OpenAPI spec at `/doc` and a Scalar reference UI
at `/reference`; `identity.ts` builds the server's signer `Identity` (from the
`IDENTITY` keyfile, else a passphrase, else `"implicit trust"` in development),
whose DID signs storage auth and is surfaced at `/api/meta`; `otel.ts` exports
spans (with an OpenInference processor) to a collector that fans LLM spans to
Phoenix and all spans to SigNoz. The two middlewares are the pino request logger
(a per-request `reqId`) and an OpenTelemetry middleware that reads an inbound
W3C `traceparent` so a request span links to the browser's trace.

---

## The HTTP and WebSocket request lifecycle

```mermaid
flowchart TB
    serve["Deno.serve(app.fetch)"]
    otel["OpenTelemetry span middleware"]
    pino["pino request logger"]
    route{"route match"}
    handler["Zod-validated route handler"]
    ws["WebSocket upgrade branch<br/>(/api/storage/memory)"]
    bridge["sniff memory protocol,<br/>hand socket to MemoryServer.connect()"]
    shellcatch["shell catch-all (/*)<br/>serves the SPA or proxies the dev server"]

    serve --> otel --> pino --> route
    route -->|"most paths"| handler
    route -->|"/api/storage/memory"| ws --> bridge
    route -->|"unmatched"| shellcatch
```

The memory WebSocket handler is the most intricate file in `toolshed`. It
upgrades the request, takes the first text frame as the candidate handshake and
validates it against the memory protocol (buffering any later frames until the
handoff so none are lost), then hands the socket to the in-process memory server
and bridges frames in both directions. This is the channel `shell`, the `cli`,
and `background-piece-service` all use for durable state.

### The route groups

Most groups follow a `*.routes.ts` (the Zod/OpenAPI schema) plus `*.handlers.ts`
(the logic) plus `*.index.ts` (the wiring) convention. A few (`telemetry`,
`blobs`) skip the triad and register plain Hono routes inline in their
`*.index.ts` instead.

| Path | What it does |
|---|---|
| `/_health`, `/api/health/*` | liveness, stats, LLM provider health |
| `/api/storage/memory` | the durable-store WebSocket |
| `/api/ai/llm`, `/generateObject`, `/models` | the LLM gateway (streaming) |
| `/api/ai/img`, `/voice/transcribe`, `/webreader/*` | other AI capabilities |
| `/api/agent-tools/web-search`, `/web-read` | tools patterns and agents can call |
| `/api/integrations/*` | OAuth2 for ~8 providers, auto-wired from descriptors |
| `/api/patterns/:filename` | serves pattern source files |
| `/api/sandbox/exec` | proxies code execution to an external sandbox service |
| `/api/ingest/:id` | journal-sink ingest channel — posts external data into a space |
| `/api/webhooks[/:id]` | webhook CRUD and delivery |
| `/api/telemetry/*` | telemetry ingest |
| `/api/whoami`, `/api/meta` | identity, build info |
| `/:spaceDid/blobs[/:name]` | per-space blob upload/fetch (not under `/api`) |
| `/*` | the shell SPA (mounted last) |

---

## The LLM gateway

The provider abstraction lives in `toolshed`, not in the `llm` package — which
surprises people, because they look in `llm/` first and find only an HTTP
client. Models are keyed `provider:model` (for example
`anthropic:claude-sonnet-4-6`). The gateway uses the Vercel AI SDK for the
direct providers and also pulls a dynamic set of "gateway" models from an
internal endpoint.

```mermaid
flowchart LR
    client["LLMClient (the llm package)"]
    post["POST /api/ai/llm"]
    cache{"disk cache hit?"}
    find["findModel(): resolve provider:model,<br/>handle aliases + default candidates"]
    stream["AI SDK streamText()"]
    prov["provider (Anthropic / OpenAI / Groq / Vertex / gateway)"]
    ndjson["NDJSON event stream:<br/>text-delta / tool-call / tool-result / finish"]
    cached["return cached final message<br/>as a single JSON body"]

    client --> post --> cache
    cache -->|hit| cached --> client
    cache -->|miss| find --> stream --> prov --> ndjson --> client
```

Concrete mechanics: `findModel` is a plain `MODELS[name]` lookup (aliases are
extra keys pointing at the same `ModelConfig`), and the `default` alias resolves
through `DEFAULT_MODEL_CANDIDATES` (`gateway:claude-sonnet-4-6` →
`anthropic:claude-sonnet-4-6` → `anthropic:claude-sonnet-4-5`). `loadGatewayModels`
fetches `${gateway}/v1/models` with a short timeout, forces an HTTP/1.1 client
(to dodge a Deno HTTP/2 SSE bug), and falls back cleanly off-Tailscale. The disk
cache keys on the SHA-256 of the request JSON (after stripping the `cache`/
`metadata` fields), and the two endpoints have *opposite* defaults: `generateText`
caches only when `cache === true` and there are no live model tools, while
`generateObject` caches unless `cache === false`. Responses carry an
`x-cf-llm-trace-id` header, and `/api/ai/llm/feedback` posts human annotations to
Phoenix.

The `llm` package itself is purely the consumer: `LLMClient.sendRequest`
POSTs to the endpoint and reassembles the streamed events. It also holds shared
prompt templates (`json-gen`, `json-import`, `pattern-fix`, `pattern-guide`,
`piece-describe`, `piece-suggestions`) and a mock/fixture system that blocks live
calls when `CI === "true"` or `ENV === "test"` (its mock entries are one-time-use,
spliced out on match). The `llm → runner` import cycle is a single line —
`prompts/json-import.ts` imports `createJsonSchema` from `runner`.

---

## The background piece service

This process runs pieces' `bgUpdater` handlers on a schedule, so background work
happens with no browser open. It watches a system-space cell listing the
registered pieces, groups them by space, and runs each space's pieces in an
isolated Web Worker.

```mermaid
flowchart TB
    cell["system-space pieces cell (.sink subscription)"]
    ensure["ensurePieces(): filter enabled, group by space DID"]
    sm["one SpaceManager per space<br/>(priority queue + polling execLoop)"]
    wc["WorkerController (IPC, msgId-keyed, timeouts)"]
    worker["Web Worker: own Runtime + PieceManager"]
    fire["load piece by id, send({}) to its bgUpdater stream"]
    back["write success/failure back to the cell<br/>(linear backoff, auto-disable after 3 failures)"]

    cell --> ensure --> sm --> wc --> worker --> fire --> back
    back -.-> cell
```

The registered-pieces list is typed as `BGPieceEntry` (`schema.ts`, fields
`space`/`pieceId`/`integration`/`createdAt`/`disabledAt`/`lastRun`/`status`),
fetched via `getBGPieces` and watched with `piecesCell.sink(...)`. That registry
cell is synced with a privileged confidentiality label (`ifc: { confidentiality:
["secret"] }`) at the fixed cause `BG_CELL_CAUSE` in `BG_SYSTEM_SPACE_ID`.
The scheduling model: each `SpaceManager` runs at most one piece at a time from a
timestamp-sorted queue (`pollingIntervalMs`), reruns each piece roughly once a
minute (`rerunIntervalMs`), applies linear backoff on failure, and disables a
piece after a few consecutive failures. The `WorkerController` uses `msgId`-keyed
IPC with a per-task timeout (several minutes in production). To fire a piece the
worker resolves
the cell by id, loads it with schema `{ bgUpdater: { asCell: ["stream"] } }`, and
does `updater.withTx(tx).send({}); tx.commit()` then awaits `runtime.idle()`.
Isolation is strict: one worker per space, and a terminal worker error disables
the whole space and recreates the worker. A one-time `deno task add-admin-piece`
(casting `bgAdmin.tsx` into the system space) is required before any piece is
polled.

---

## Technical debt and sharp edges

- **The provider abstraction is in the wrong-feeling place.** It is in
  `toolshed/routes/ai/llm/models.ts`, not in the `llm` package. Look there.
- **OAuth providers are auto-wired from descriptors at startup.** The
  `DESCRIPTORS` array is, in order, Google, Airtable, GitHub, Notion, Linear,
  Spotify, Discord, Strava (plus Plaid and a webhook-style Discord route that are
  wired manually because their flows are non-standard). Providers with missing
  credentials are silently skipped (`Promise.allSettled`, so one failure doesn't
  block the rest), and the shared `/api/integrations/bg` route — which registers a
  piece for background updating — attaches to whichever descriptor has credentials
  first. Non-obvious when an endpoint "isn't there."
- **The shell route's headers are deliberately non-isolating.** Concretely
  `Cross-Origin-Opener-Policy: same-origin-allow-popups` and
  `Cross-Origin-Embedder-Policy: unsafe-none`, set *after* the handler so they
  override upstream — the goal is to keep `crossOriginIsolated === false` so
  SES-sandboxed patterns get no `SharedArrayBuffer` or high-resolution timer.
  The shell route is tri-state: `COMPILED` present → serve the static frontend;
  else `SHELL_URL` set → proxy the dev server; else 404. Do not "fix" the headers
  without understanding why.
- **The new ingest and telemetry routes are gated and fail-safe.**
  `/api/ingest/:id` requires a `Bearer` token (uniform 401 for any failure),
  caps the body size, and parses only after the token verifies;
  `/api/telemetry/*` proxies browser OTLP to the collector and is fail-open (204
  when disabled, 413 over the size cap, otherwise a fire-and-forget 202 — never a
  5xx).
- **`background-piece-service` carries the most TODOs in this group**, several
  about the scheduler being approximate: space managers should watch their own
  pieces, a terminal error cannot always be attributed to a specific piece (so a
  stray failure can disable a whole space), and sync is assumed never to return
  partial results. Others are about worker/piece lifecycle and cleanup.
- **`bcs` depends on hardcoded constants** — the system-space DID and a dated
  cause string `BG_CELL_CAUSE = "bgUpdater-2025-03-18"` in `schema.ts` — and
  requires a one-time admin grant before any piece is polled.
- **The rename kept a few backward-compat identifiers.** So existing spaces keep
  resolving, the charm→piece rename intentionally left the persisted/wire names
  alone: the `bgUpdater` handler-stream name, the cause string
  `BG_CELL_CAUSE = "bgUpdater-2025-03-18"`, and the derived system-space DID
  (`BG_SYSTEM_SPACE_ID`), all in `schema.ts`/`worker.ts`. None of them contain
  the word "charm"; they are simply legacy-shaped.
- **A tool-loop cap is hardcoded** (`stepCountIs(...)`) in `generateText.ts` as a
  runaway guard.

---

## Entry points and ports

- `toolshed` — entry `index.ts` (`deno task dev` or `production`).
  `tasks/build-binaries.ts` compiles two binaries — `dist/toolshed` and
  `dist/bg-piece-service` — and writes the `COMPILED` sentinel as JSON
  (`{commitSha, builtAt}`), `--include`d into the toolshed binary and read at
  `/api/meta`. `Dockerfile.toolshed` pins a specific Deno version and does a brief
  "warm run" so the `@db/sqlite` FFI library is baked into the image (no GitHub
  egress on first DB open). The `COMPILED` file's presence also switches the shell
  route from dev-proxy to static serving.
- `background-piece-service` (`@commonfabric/background-piece`) — entry
  `src/main.ts` (`deno task start`). It now ships its own tests, so unlike
  `vendor-astral` it is no longer in the test runner's disabled list.
- `llm` — library only; `.`, `./types`, `./client`.
- `ports.json` (repo root): `toolshed` 8000, `shell` 5173, inspector 9229. The
  OpenTelemetry collector defaults to 4318.
