# Configuration Reference

A categorized reference for environment variables, build flags, CLI args, and
developer tasks across the Common Tools labs repo.

This doc is **not** the source of truth — it points to the schemas that are.
For exhaustive, always-current lists check the Zod schemas linked at the top
of each section.

| Component | Schema file |
|---|---|
| Toolshed (server) | [`packages/toolshed/env.ts`](../../packages/toolshed/env.ts) |
| Shell (browser, build-time) | [`packages/shell/felt.config.ts`](../../packages/shell/felt.config.ts), [`packages/shell/src/lib/env.ts`](../../packages/shell/src/lib/env.ts) |
| Background piece service | [`packages/background-piece-service/src/env.ts`](../../packages/background-piece-service/src/env.ts) |
| CLI | [`packages/cli/launcher.ts`](../../packages/cli/launcher.ts), [`packages/cli/mod.ts`](../../packages/cli/mod.ts) |
| Integration tests | [`packages/integration/env.ts`](../../packages/integration/env.ts) |
| Experimental flags | [`docs/development/EXPERIMENTAL_OPTIONS.md`](./EXPERIMENTAL_OPTIONS.md) |

When defaults shown here disagree with the schema, the schema wins — please
update this doc.

---

## Server / core

Required only if you're running the toolshed.

| Var | Default | Notes |
|---|---|---|
| `ENV` | `development` | `development`, `production`, or `test`. `ENV=test` is required by the test runner. |
| `HOST` | `0.0.0.0` | Bind address. |
| `PORT` | `8000` | Server port. Also overridable via the `--port=N` CLI arg (used by `deno --watch`, which doesn't forward env vars). |
| `LOG_LEVEL` | `info` | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. |
| `DISABLE_LOG_REQ_RES` | `false` | Suppress per-request log lines. |
| `CACHE_DIR` | `./cache` | Local disk cache root. |
| `API_URL` | `http://localhost:8000` | Self-referential URL used for internal server-to-server requests. |
| `SHELL_URL` | _(unset)_ | When set, toolshed proxies non-API paths to this upstream — used by local dev to route to the Shell dev server on `:5173`. |

---

## LLM providers

A provider's models are **only registered when its env var is set**. See
[`packages/toolshed/routes/ai/llm/models.ts`](../../packages/toolshed/routes/ai/llm/models.ts)
for the registration logic.

| Var | Provider |
|---|---|
| `CFTS_AI_LLM_ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `CFTS_AI_LLM_OPENAI_API_KEY` | OpenAI |
| `CFTS_AI_LLM_GROQ_API_KEY` | Groq |
| `CFTS_AI_LLM_CEREBRAS_API_KEY` | Cerebras |
| `CFTS_AI_LLM_PERPLEXITY_API_KEY` | Perplexity |
| `CFTS_AI_LLM_XAI_API_KEY` | xAI (Grok) |
| `CFTS_AI_LLM_AWS_ACCESS_KEY_ID` + `CFTS_AI_LLM_AWS_SECRET_ACCESS_KEY` | AWS Bedrock |
| `CFTS_AI_LLM_GOOGLE_APPLICATION_CREDENTIALS` + `CFTS_AI_LLM_GOOGLE_VERTEX_PROJECT` + `CFTS_AI_LLM_GOOGLE_VERTEX_LOCATION` | Google Vertex AI |

> Note: toolshed uses the `CFTS_AI_LLM_` prefix (not the conventional
> `ANTHROPIC_API_KEY`, etc.). The exact variable names are required.

### LLM gateway

| Var | Default | Notes |
|---|---|---|
| `CFTS_AI_GATEWAY_URL` | `https://llm.stage.commontools.dev` | OpenAI-compatible `/v1/models` endpoint. Toolshed probes it at startup; reachable models are registered and `gateway:claude-sonnet-4-6` becomes the default when present. **The default URL is Tailscale-only — external users will not be able to reach it.** That fallback path is supported: an unreachable gateway logs a warning, the startup probe times out in ~3s, and the direct-provider models continue to work. Set to `""` to opt out and skip the probe entirely. |

**Default model resolution order** (defined in `models.ts` as
`DEFAULT_MODEL_CANDIDATES`):

1. `gateway:claude-sonnet-4-6`
2. `anthropic:claude-sonnet-4-6`
3. `anthropic:claude-sonnet-4-5`

The first candidate registered becomes the `default` alias and the value used
for `TASK_MODELS.coding` / `TASK_MODELS.json`.

### LLM observability (Phoenix)

| Var | Purpose |
|---|---|
| `CFTS_AI_LLM_PHOENIX_PROJECT` | Phoenix project name |
| `CFTS_AI_LLM_PHOENIX_URL` | Phoenix UI URL |
| `CFTS_AI_LLM_PHOENIX_API_URL` | Phoenix API URL |
| `CFTS_AI_LLM_PHOENIX_API_KEY` | Phoenix API key |

---

## Other AI services

| Var | Purpose |
|---|---|
| `FAL_API_KEY` | `/routes/ai/img` (image gen), `/routes/ai/voice` (transcription). |
| `JINA_API_KEY` | `/routes/ai/webreader`. |

---

## OAuth integrations

All blank by default. Each integration is gated on its `_CLIENT_ID` /
`_CLIENT_SECRET` pair; routes return 404 / fail predictably if not set.

| Service | Vars |
|---|---|
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| Notion | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` |
| Linear | `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` |
| Spotify | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` |
| Discord | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |
| Strava | `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` |
| Airtable | `AIRTABLE_CLIENT_ID`, `AIRTABLE_CLIENT_SECRET` |

### Plaid

| Var | Default | Notes |
|---|---|---|
| `PLAID_CLIENT_ID` / `PLAID_SECRET` | _(unset)_ | |
| `PLAID_ENV` | `sandbox` | `sandbox` \| `development` \| `production`. |
| `PLAID_PRODUCTS` | `transactions` | Comma-separated. |
| `PLAID_COUNTRY_CODES` | `US` | |
| `PLAID_REDIRECT_URI` | _(unset)_ | Optional. |
| `PLAID_SYNC_ALL_TRANSACTIONS` | `false` | Sync full history vs. incremental. |

### Notification webhooks

| Var | Purpose |
|---|---|
| `DISCORD_WEBHOOK_URL` | General-purpose alerts. |
| `LLM_HEALTH_DISCORD_WEBHOOK` | LLM health monitor alerts. |
| `HOSTNAME` | Included in alerts so multi-host deploys are distinguishable. |

---

## Identity & auth

There are three interacting identity concepts. Pick one column based on which
process you're configuring.

| Process | Path-to-keyfile var | Passphrase var | Default fallback |
|---|---|---|---|
| Toolshed | `IDENTITY` | `IDENTITY_PASSPHRASE` _(deprecated)_ | `"implicit trust"` (dev only) |
| Background piece service | `IDENTITY` | `OPERATOR_PASS` | `"implicit trust"` (dev only) |
| CF CLI | `CF_IDENTITY` env or `--identity <path>` | _(none)_ | _(none — error if remote)_ |

For local dev, all three default to the implicit-trust passphrase so they
share an identity automatically. To match the CLI to the local server (only
needed for operator/admin tasks on your own localhost):

```bash
deno run -A packages/cli/mod.ts id derive "implicit trust" > claude.key
export CF_IDENTITY=./claude.key
```

`"implicit trust"` is a shared, publicly-derivable identity — never use it
against a shared or remote server (everyone who derives it becomes the same
principal). For a personal or unique identity, use `id new`. See
[`docs/development/SHARED_IDENTITY.md`](./SHARED_IDENTITY.md) for the
browser-import flow.

---

## Memory store

The toolshed-embedded memory service has two modes:

| Var | Default | Notes |
|---|---|---|
| `MEMORY_DIR` | `./cache/memory/` (as a `file://` URL) | **Directory mode** — one SQLite file per space. Default; backwards-compatible. |
| `DB_PATH` | _(unset)_ | **Single-file mode** — absolute path to one SQLite database. Used for clusterduck clustering. Validated as an absolute path. |
| `MEMORY_URL` | `http://localhost:8000` | Where other components reach the memory service. |
| `MEMORY_ACL_MODE` | `enforce` | Space ACL policy: `off`, `observe`, or `enforce`. `observe` logs ordinary access shortfalls, while malformed ACLs and fresh-space genesis violations still fail closed. |
| `MEMORY_SERVICE_DIDS` | _(empty)_ | Comma-separated DIDs with implicit OWNER on every space. These identities may initialize ACLs but still cannot make an ordinary first write before genesis. |

With ACL policy active, a fresh space is read-only until its space identity or a
configured service DID writes a valid ACL with a concrete OWNER. A populated
space that has never had an ACL remains authenticated-public READ/WRITE as a
temporary pre-launch compatibility rule; public access never includes OWNER.
Retracted, malformed, and ownerless ACLs fail closed.
Normal fresh named-space bootstrap currently creates
`{ [activeUser]: "OWNER", "*": "WRITE" }` so new non-home spaces are public
read/write until ACL management has a UI. Home bootstrap remains owner-only.

---

## Sandbox service

Used by `/routes/sandbox/exec` to execute untrusted pattern code.

| Var | Default | Notes |
|---|---|---|
| `SANDBOX_SERVICE_URL` | `https://sandbox.stage.commontools.dev` | External sandbox executor. |
| `SANDBOX_TOOLSHED_URL` | _(falls back to `API_URL`)_ | URL injected into sandboxes as `CF_API_URL` so they can call back to this toolshed. |

The executor itself is not in this repo; the toolshed only forwards to
`SANDBOX_SERVICE_URL`. The service is `commontoolsinc/common-cluster` (Go): its
`node-agent` serves `/v1/sandboxes` and runs each sandbox as a gVisor container
on a per-node ZFS dataset. The `runsc` runtime and `sandboxexec` library come
from `commontoolsinc/gvisor` (branch `cfc_v2`), and the cluster is provisioned by
`commontoolsinc/infra` (Terraform).

---

## OpenTelemetry

Off by default; flip `OTEL_ENABLED=true` to start exporting.

| Var | Default |
|---|---|
| `OTEL_ENABLED` | `false` |
| `OTEL_SERVICE_NAME` | `toolshed` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` |
| `OTEL_TRACES_SAMPLER` | `always_on` |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` |

The toolshed SDK provider registered by `OTEL_ENABLED` lives only in the main
isolate. Server executor Workers bridge their isolated Runtime telemetry only
under Deno native OTel (`OTEL_DENO=true|1` with `--unstable-otel`). Attachment
and teardown are fail-open; spans identify the executor Runtime, served space,
and sponsoring user while metrics keep those DIDs out of their labels.

---

## Build info

| Var | Default | Notes |
|---|---|---|
| `TOOLSHED_GIT_SHA` | _(auto-detected)_ | Deployed commit SHA, surfaced via `lib/build-info.ts`. Takes priority over the build-baked SHA. |

The compilation cache for compiled patterns is the content-addressed cell
cache (always on under an enforcing CFC mode; see
`packages/runner/src/compilation-cache/cell-cache.ts`). The former
`COMPILATION_CACHE_*` env vars configured the removed AMD bundle cache and no
longer exist.

---

## Experimental flags

[`docs/development/EXPERIMENTAL_OPTIONS.md`](./EXPERIMENTAL_OPTIONS.md) is the
central registry of every experimental flag: what each gates, who added it, its
default, its planned end state, and its removal path, plus the propagation paths
(server / shell / bg-piece / CLI) and verification steps. Briefly:

- Server-side toggles take effect on restart.
- Shell-side toggles are baked at build time — toggling requires a rebuild.
- The same env var must be set everywhere the flag is read.

The environment-backed flags (the only ones settable without editing code) are:

| Flag | Env var |
|---|---|
| `modernCellRep` | `EXPERIMENTAL_MODERN_CELL_REP` |
| `persistentSchedulerState` | `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` |
| `serverPrimaryExecution` | `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION` |
| `eagerSourceAnnotation` | `EXPERIMENTAL_EAGER_SOURCE_ANNOTATION` |

The runtime-only flags (`commitPreconditions`, the CFC enforcement dials) and the
storage, memory-protocol, and shell flags are documented in the registry. See it
for the complete list.

---

## Shell (browser)

Most shell config is **build-time**: esbuild injects defines in
`packages/shell/felt.config.ts` and they become globals read by
`packages/shell/src/lib/env.ts`. Browser-side changes require a rebuild.

| Build-time var | Runtime global | Default | Notes |
|---|---|---|---|
| `PRODUCTION` | `$ENVIRONMENT` (`"production"` if set, else `"development"`) | _(unset = dev)_ | Triggers minified bundle and disables sourcemaps. |
| `API_URL` | `$API_URL` | falls back to `location.origin` | Backend the shell calls. |
| `COMMIT_SHA` | `$COMMIT_SHA` | _(unset)_ | Surfaced for debugging. |
| `EXPERIMENTAL_MODERN_CELL_REP` | `EXPERIMENTAL.modernCellRep` | _(unset)_ | See experimental flags. |
| `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` | `EXPERIMENTAL.persistentSchedulerState` | _(unset = runtime on)_ | See experimental flags. |
| `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION` | `EXPERIMENTAL.serverPrimaryExecution` | _(unset = runtime on)_ | Set `false` for rollback; see experimental flags. |
| `EXPERIMENTAL_EAGER_SOURCE_ANNOTATION` | `EXPERIMENTAL.eagerSourceAnnotation` | on in dev builds, off in production | See experimental flags. |
| `SHELL_PORT` | _(server-only)_ | `5173` (from `ports.json`) | Dev server port. |

---

## CLI (`cf`)

The `cf` CLI is invoked via the launcher in
[`packages/cli/launcher.ts`](../../packages/cli/launcher.ts), which discovers
the labs checkout and dispatches to `packages/cli/mod.ts`.

### Env vars

| Var | Default | Notes |
|---|---|---|
| `CF_IDENTITY` | _(none)_ | Path to identity keyfile. Required for `piece`, `acl`, `exec`, and `execution` against a remote toolshed. |
| `CF_API_URL` | _(none)_ | Toolshed URL. Required for the same commands as above. |
| `CF_LOG_LEVEL` | `error` | `debug` \| `info` \| `warn` \| `error` \| `silent`. Also settable per-invocation with `--log-level`. |
| `CF_CLI_NAME` | `cf` | Override the displayed CLI name (for branded builds). |
| `CF_CLI_TRACE_TIMINGS` | `0` | Set to `1` for detailed timing traces. |
| `CF_CLI_INTEGRATION_USE_LOCAL` | _(unset)_ | Used by integration tests to dispatch through local source rather than a built binary. |

### Global args

| Arg | Notes |
|---|---|
| `--log-level <level>` | Equivalent to `CF_LOG_LEVEL`. |
| `--help`, `help` | Usage text. |

### Per-command args

`piece`, `acl`, `exec`, `execution`, and `fuse` accept their own subcommand options
(`-i,--identity`, `-a,--api-url`, `-s,--space`, etc.). Use `cf <command> --help`
for the authoritative list — it's not duplicated here.

### Launcher args

Passed before the CLI args; rarely needed:

| Arg | Default | Notes |
|---|---|---|
| `--deno <path>` | system `deno` | Use a specific Deno binary. |
| `--labs-root <path>` | auto-detected from launcher location | Override the labs checkout root. |
| `--config <path>` | `<labs-root>/deno.jsonc` | Override the Deno config. |
| `--cli-entrypoint <path>` | `<labs-root>/packages/cli/mod.ts` | Override the CLI entry. |
| `--cwd <path>` | `INIT_CWD` env or `process.cwd()` | Override the working directory passed to the CLI. |

---

## Background piece service

| Var | Default | Notes |
|---|---|---|
| `OPERATOR_PASS` | `"implicit trust"` | Passphrase for implicit identity. Must match toolshed's identity in dev. |
| `IDENTITY` | _(unset)_ | Path to keyfile; takes precedence over `OPERATOR_PASS`. |
| `API_URL` | `http://localhost:8000` | Toolshed URL the service calls. |
| `EXPERIMENTAL_MODERN_CELL_REP` | _(unset)_ | See experimental flags. |
| `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` | _(unset = runtime on)_ | See experimental flags. |
| `EXPERIMENTAL_SERVER_PRIMARY_EXECUTION` | _(unset = runtime on)_ | Set `false` for rollback; see experimental flags. |
| `EXPERIMENTAL_EAGER_SOURCE_ANNOTATION` | _(unset)_ | See experimental flags. |

---

## Integration tests

[`packages/integration/env.ts`](../../packages/integration/env.ts) reads these
when you run `deno task integration`:

| Var | Default | Notes |
|---|---|---|
| `API_URL` | `http://localhost:8000/` | Toolshed under test. |
| `FRONTEND_URL` | `API_URL` | Override when testing the shell dev server directly (`http://localhost:5173`). |
| `HEADLESS` | `false` | Browser tests headless when `true`. |
| `PIPE_CONSOLE` | `false` | Pipe browser console output into the test runner. |
| `SPACE_NAME` | random UUID | Stable name for cross-run debugging. |

Additionally, [`tasks/integration.ts`](../../tasks/integration.ts) sets
`INTEGRATION_TEST_FLAGS` (default: unset; populated with `--junit-path=…` when
`--junit-dir` is passed, or passed through from the environment otherwise).
Per-package `deno.jsonc` `integration` scripts pick it up via `$INTEGRATION_TEST_FLAGS`
shell expansion to forward extra `deno test` flags (e.g. `--filter`).

---

## Tasks

### Workspace root (`deno task <name>` from repo root)

| Task | What it does |
|---|---|
| `check` | Type-check all packages (`./tasks/check.sh`). |
| `test` | Run all package tests (`./tasks/test.ts`). |
| `integration` | Run integration tests (`./tasks/integration.ts`). |
| `build-binaries` | Build standalone binaries (`cf`, `bg-piece-service`, etc.). |
| `cf` | Run the CLI via the launcher. |
| `initialize-db` | Initialize the local development database. |
| `install-hooks` | Install git pre-commit hooks. |
| `profile` | Restart local dev with `--inspect-brk` for profiling. |
| `cf-profile`, `cf-inspect-brk`, `cf-profile-brk` | Profile / debug the CF CLI. |

### Toolshed (`packages/toolshed`)

| Task | What it does |
|---|---|
| `dev` | Hot-reload server reading `.env` (`--watch`). |
| `production` | Server without `--watch`. |
| `test` | `ENV=test` with `.env.test`. |
| `llm-exercise` | Smoke-test configured LLM providers. |

### Shell (`packages/shell`)

| Task | What it does |
|---|---|
| `dev` | Build against the cloud toolshed at `toolshed.saga-castor.ts.net`. Use this for shell-only work. |
| `dev-local` | Build against `http://localhost:$TOOLSHED_PORT`. **Use this for local dev** — `dev` points at the cloud backend. |
| `dev-clusterduck` | Build against the clusterduck instance (`localhost:7001`). |
| `build` / `production` | Optimized build (`production` sets `PRODUCTION=1`). |
| `serve` | Serve pre-built `dist/` on `0.0.0.0:9099`. |
| `test`, `integration` | Test suites. |

### CLI (`packages/cli`)

| Task | What it does |
|---|---|
| `cli` | Run the CLI via the launcher (handles cwd / config discovery). |
| `cli-no-pwd-override` | Run `mod.ts` directly without the launcher. |
| `test` | Unit tests. |
| `integration`, `fuse-integration`, `acl-integration` | Integration suites against a local toolshed. |

### Background piece service (`packages/background-piece-service`)

| Task | What it does |
|---|---|
| `start` | Run from source. |
| `add-admin-piece` | One-time setup: cast the admin piece into the system space. |
| `test` | Run unit tests. |
| `check` | Type-check source files. |
| `lint` | Lint source files. |
| `fmt` | Format package files. |
| `help` | Service help. |

---

## Where defaults live

- **Numeric / boolean / string defaults**: in the Zod `.default(...)` clauses of
  the relevant `env.ts`.
- **URLs that vary per environment**:
  - `CFTS_AI_GATEWAY_URL` → `https://llm.stage.commontools.dev` (Tailscale-only).
  - `SANDBOX_SERVICE_URL` → `https://sandbox.stage.commontools.dev`.
  Both fall back gracefully when unreachable, but expect logs warning about
  the failed probes if you're off the corporate network.
- **`"implicit trust"`** appears as the identity-passphrase default in three
  places (toolshed `IDENTITY_PASSPHRASE`, bg-service `OPERATOR_PASS`, and the
  CLI dev recipe). They must match for those three processes to share an
  identity in local dev.

---

## Common scenarios (quick recipes)

**External contributor, local dev, no LLMs needed:**
```bash
# Just defaults work. The gateway probe will warn but is harmless.
./scripts/start-local-dev.sh
```

**Local dev with Anthropic models only:**
```bash
# In packages/toolshed/.env:
CFTS_AI_LLM_ANTHROPIC_API_KEY=sk-ant-...
CFTS_AI_GATEWAY_URL=""        # silence the off-Tailscale gateway probe
```

**Local dev, on Tailscale, using the gateway:**
```bash
# Defaults are fine. CFTS_AI_GATEWAY_URL already points at stage.
# default model resolves to gateway:claude-sonnet-4-6.
```

**Production deploy:**
```bash
ENV=production
TOOLSHED_GIT_SHA=<deploy-sha>
# Provider keys, OAuth secrets, MEMORY_URL, etc. as appropriate.
```
