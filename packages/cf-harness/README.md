# @commonfabric/cf-harness

`cf-harness` is an in-house agent harness package for Common Fabric. It is being
built as a general Common Fabric agent runtime, with Loom as the first target
use case.

The package is experimental but already integrated into Loom and Pattern
Factory. It has a real execution core, bounded batch and interactive prompt/tool
loops, durable artifacts and resumability, an operator CLI, explicit Agent
Skills support, constrained delegation profiles, and CFC-aware mediation and
deny/recovery shaping.

For a concise status and lifecycle-aware documentation map, start with
[docs/README.md](docs/README.md) and
[docs/CURRENT_STATE.md](docs/CURRENT_STATE.md). The package's draft conformance
claim is in [docs/IMPLEMENTATION_PROFILE.md](docs/IMPLEMENTATION_PROFILE.md);
remaining work is in [docs/ROADMAP.md](docs/ROADMAP.md).

## Why This Exists

Common Fabric needs an agent harness that can become CFC-aware without
retrofitting CFC semantics awkwardly onto a third-party runtime.

The current design direction is:

- `runner` owns authoritative CFC meaning
- `cf-harness` transports and respects those semantics
- lower layers such as the gVisor-backed sandbox enforce conservative mediation
- the harness itself stays mechanistic rather than asking models to make policy
  decisions

## Current Scope

What works today:

- shell-centric execution against the local `runsc-cfc` sandbox path
- sandbox containers default to Docker `--network bridge` so local Loom/Fabric
  helper services can be reached through Docker Desktop's `host.docker.internal`
  host alias during early integration work; set
  `CF_HARNESS_DOCKER_NETWORK_MODE=host` when a runtime should explicitly use
  host networking
- default sandbox image aligned with the public CFC kitchen-sink image published
  from the sibling `gvisor` repo:
  - `us-docker.pkg.dev/commontools-core/common-fabric/sandbox-kitchensink:latest`
  - override per run with `--sandbox-image` or `CF_HARNESS_SANDBOX_IMAGE`
- built-in tools:
  - `bash`
  - `bash-no-sandbox` (provisional host shell for named subagent profiles only)
  - `read_file`
  - `view_image`
  - `web_fetch` (explicit parent allowlist or `web_fetch` subagent profile only)
  - `read_skill_resource`
  - `run_skill_script`
  - `edit_file`
  - `write_file`
  - `delegate_task`
  - `run_pattern` (present only when the run configures a fabric session; see
    [Running patterns against a Fabric space](#running-patterns-against-a-fabric-space))
- targeted exact-string edits plus whole-file replace/create and append writes
- initial and in-run image attachments for model vision-capable flows
- bounded public HTTP(S) fetches through `web_fetch`, with redirect validation,
  local/private target blocking, extracted text/links, and raw bounded response
  retention in tool-output artifacts; `web_fetch` is intentionally not part of
  the default parent tool surface
- provider-neutral bounded prompt/tool loop with OpenAI-compatible gateway and
  opt-in ChatGPT/Codex subscription transports
- interactive chat NDJSON stdio transport with opt-in SQLite session, turn, and
  event persistence
- single-child subagent delegation with fresh child prompt context, explicit
  default/browser/web_fetch/web_search child profiles, retained child run
  references, and a sanitized summary/state return channel
- optional schema-validated subagent structured returns, with raw child return
  artifacts retained in the child run and open-ended strings linkified before
  the parent sees them
- persisted run state, transcript, run reports, Loom run manifests, capability
  snapshots, and tool outputs, plus explicit skill registry and activation
  artifacts
- provider-neutral run-report model-attempt diagnostics, one record per attempt,
  naming the provider and the API operation that served it
- provider-reported per-turn token usage in run reports, with aggregate input,
  cached-input, cache-write, output, reasoning, and total tokens surfaced in
  operator and batch results
- GPT-5.6 gateway cost estimates when the provider returns complete cache usage
  detail; estimates use the public OpenAI token schedule and are kept distinct
  from provider-reported cost
- stable prompt-cache affinity across an interactive session, plus opt-in
  reasoning effort and GPT-5.6 gateway implicit/explicit cache-mode controls
- transcript-based resumability
- package-local operator CLI
- explicit Agent Skills preload via `--skills-root` and repeatable `--skill`
- runtime-generated supporting-resource indexes in `skill-registry.json`
- text-first supporting-resource reads through `read_skill_resource`, recorded
  in `skill-resource-reads.json`
- exact-allowlisted skill script execution through `run_skill_script`, recorded
  in `skill-script-executions.json`

The sandbox `bash` tool has a provisional direct-`curl` guard while sandbox
networking is enabled: explicit `curl` invocations may target loopback HTTP(S)
hosts such as `localhost`, `127.0.0.1`, and Docker Desktop's
`host.docker.internal` host alias, but obvious external `curl` targets are
denied before sandbox execution. This is an integration unblock, not a complete
network confinement model.

- CFC mode plumbing with:
  - `disabled`
  - `observe`
  - `enforce-explicit`
  - `enforce-strict`
- default CFC mode aligned with the runner's permissive-if-absent
  `enforce-explicit` rollout behavior
- spec-aligned `PromptSlotBound` prompt-slot evidence
- Loom run manifest intake through `--run-manifest`
- first-pass policy events and deny/recovery behavior
- configurable gateway auth mode:
  - `bearer`
  - `none`
- explicit `openai-codex` subscription provider with browser PKCE and headless
  device login, refresh-token rotation, live model discovery, resume, and
  owner-bound Loom integration
- a session-local address handle table: deterministic short `cfh:a:` tokens for
  cell addresses, minted per run, recorded in run state, and carried across
  `--resume-run`; see
  [Session-local address handles](#session-local-address-handles)
- an opt-in `run_pattern` tool (`--fabric-api-url`, `--fabric-identity`, and
  `--fabric-space` together) that compiles and runs a pattern against a deployed
  Fabric space from the trusted host side and returns a live result cell
  reference; see
  [Running patterns against a Fabric space](#running-patterns-against-a-fabric-space)

What is not done yet:

- real runner-driven CFC feedback integration
- session handle coverage beyond the wired seams: denial-path tool messages,
  cross-agent handle semantics for `delegate_task` arguments, and value handles
  (`cfh:v:`)
- richer opaque-handle/pass-through behavior outside schema-validated subagent
  returns, including an explicit release/readback mechanism
- first-class browser operation policy on top of the provisional browser
  subagent profile
- dynamic/model-driven Agent Skills activation
- parallel child orchestration
- app UI event provenance
- streaming model responses
- richer mid-turn resumability

## Package Layout

- [src/config.ts](src/config.ts)
  - harness config, CFC mode resolution, gateway auth mode
- [src/engine.ts](src/engine.ts)
  - core execution engine, run state, tool execution
- [src/handle-table.ts](src/handle-table.ts)
  - session-local address handle table: token minting and both swap directions
- [src/fabric-session.ts](src/fabric-session.ts)
  - lazy, cached trusted Fabric session behind the `run_pattern` tool
- [src/prompt-loop.ts](src/prompt-loop.ts)
  - bounded prompt/tool loop
- [src/model/](src/model)
  - provider-neutral model client, gateway adapter, and Codex Responses adapter
- [src/auth/](src/auth)
  - persistent provider settings, owner-keyed credential storage, bounded
    credential health, and OpenAI Codex OAuth flows
- [src/cli.ts](src/cli.ts)
  - package-local operator CLI
- [src/provenance.ts](src/provenance.ts)
  - what caused a gateway request, reported on the request
- [src/interactive-chat-stdio.ts](src/interactive-chat-stdio.ts)
  - NDJSON stdio transport for the interactive chat protocol
- [src/loom-local-host.ts](src/loom-local-host.ts)
  - strict, fixed-owner host factory for local single-user Loom
- [src/loom-local-host-main.ts](src/loom-local-host-main.ts)
  - one batch/interactive executable boundary for Loom-owned runs
- [src/sqlite-session-store.ts](src/sqlite-session-store.ts)
  - SQLite-backed interactive chat session, turn, and event persistence
- [src/artifacts.ts](src/artifacts.ts)
  - persisted run state, run manifest, transcript, run report, capability
    snapshot, and tool output storage
- [src/skills/](src/skills/)
  - Agent Skills registry scanning, validation, and explicit preload context
- [src/contracts/](src/contracts/)
  - prompt-slot, run-manifest, observation, policy, run-report, subagent, skill,
    transcript, tool-result, and handle-table contracts
- [integration/](integration/)
  - environment-gated real `runsc-cfc` integration tests
- [docs/SKILLS_SUPPORT_SPEC.md](docs/SKILLS_SUPPORT_SPEC.md)
  - staged Agent Skills support design
- [../../docs/plans/cf-harness-codex-subscription-auth.md](../../docs/plans/cf-harness-codex-subscription-auth.md)
  - researched implementation plan for opt-in local and Loom Codex subscription
    auth with per-user credential ownership

## Commands

From [packages/cf-harness](.):

- `deno task help`
- `deno task run -- ...`
- `deno task test`
- `deno task test:integration`

## CLI Example

Standard bearer-auth mode:

```bash
cd packages/cf-harness
CF_HARNESS_API_KEY=... deno task run -- \
  --workspace ../.. \
  --prompt "Summarize the cf-harness package structure." \
  --print-transcript
```

No-auth gateway mode:

```bash
cd packages/cf-harness
deno task run -- \
  --workspace ../.. \
  --gateway-auth-mode none \
  --prompt "Summarize the cf-harness package structure." \
  --print-transcript
```

GPT-5.6 cache experiment:

```bash
cd packages/cf-harness
CF_HARNESS_API_KEY=... deno task run -- \
  --workspace ../.. \
  --model gpt-5.6-terra \
  --reasoning-effort low \
  --prompt-cache-mode explicit \
  --prompt "Inspect the cf-harness package and summarize its model adapters."
```

Operator output includes one aggregate `usage:` line covering the parent and
completed descendant runs. The persisted `run-report.json` keeps `usage` and
`modelUsage` for the direct run, plus `totalUsage` including completed
descendants. The batch result JSON carries that total usage object. `costUsd`,
when present, came from the provider; `estimatedCostUsd` is an estimate based on
the public OpenAI GPT-5.6 price schedule and is not an invoice or a subscription
quota conversion.

The API gateway's default cache mode remains the provider's implicit mode.
Explicit mode pins a breakpoint to the first user-message prefix, which is
stable while the harness appends assistant and tool messages. Use identical
prompts and tool surfaces when comparing modes, since exact prefix identity is
required for a cache hit. The ChatGPT/Codex subscription backend rejects the API
`prompt_cache_options` field, so `--prompt-cache-mode` is not supported with
`--model-provider openai-codex`; that provider continues to use implicit caching
with stable affinity and reports the resulting cache usage. OpenAI documents the
current cache fields and semantics in its
[prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

ChatGPT/Codex subscription mode is a separate, explicit provider. It does not
use an OpenAI Platform API key:

```bash
cd packages/cf-harness

# Browser PKCE login (default) or headless device login.
deno task run -- auth login openai-codex
deno task run -- auth login openai-codex --device

# Inspect or persist the provider preference used by new direct runs.
deno task run -- config inspect --json
deno task run -- config init openai-compatible-gateway --json
deno task run -- config set openai-codex --json

# Inspect local credential status and the live, subscription-scoped model catalog.
deno task run -- auth status openai-codex
deno task run -- models openai-codex

# Run through the same bounded loop and CFC mediation as the gateway provider.
deno task run -- \
  --workspace ../.. \
  --model-provider openai-codex \
  --model gpt-5.5 \
  --prompt "Summarize the cf-harness package structure."

deno task run -- auth logout openai-codex
```

The provider preference lives in `CF_HARNESS_HOME/config.json`; local
credentials and bounded refresh health live in `CF_HARNESS_HOME/auth.json` (by
default under `~/.cf-harness`). The home and files use private permissions, and
mutations serialize through advisory locks before atomic replacement. The
canonical home path and its ancestor chain are a trusted host configuration; the
stores reject a symlink at the home, target, or lock path but do not claim
descriptor-relative protection against an attacker who can replace trusted
ancestors concurrently. `cf-harness` never imports or shares
`~/.codex/auth.json`. A failed refresh does not fall back to `OPENAI_API_KEY`,
the Common Tools gateway, or unauthenticated mode.

Direct runs resolve a provider from explicit CLI, environment, persistent
preference, then the historical gateway default. Provider resolution does not
resolve or rewrite model aliases. Resume retains the recorded provider and
ignores the persistent preference; an explicit conflicting provider is a
`provider-mismatch` failure. Structured config and auth commands use versioned
JSON result envelopes. Login emits a versioned NDJSON authorization event before
its terminal result. These responses expose connection health but no tokens,
full account identifiers, expiries, or raw provider errors.

Resume a root run with `--resume-run <run-root-or-run-state.json>`. Codex resume
keeps the recorded provider, model, exact credential owner, and encrypted
provider continuation; requesting another model is rejected before credentials
or provider traffic. Child runs are recorded with their root/parent lineage and
cannot be resumed directly as top-level runs—resume the root run instead.
Library callers receive the same guards: `runTranscript()` binds the first
selected Codex model into run state and cannot override a resumed binding, while
a whole-tree restorer must supply a matching typed `subagentResumeContext` when
it reconstructs a child beneath its trusted root/parent session.

The gateway and subscription routes have different billing, workspace policy,
retention, and model availability. The model catalog is read live from the
selected subscription; an explicit unavailable model fails instead of being
silently substituted.

### Loom subscription binding

Local single-user Loom uses the exported `createLoomLocalCfHarnessHost()`
factory and the package entrypoint in `src/loom-local-host-main.ts`. The host
requires an explicit, absolute, normalized `CF_HARNESS_HOME`; strictly resolves
the persisted provider from that home's `config.json`; and fixes the credential
owner to `local`. It uses that same home's `auth.json` only through cf-harness's
credential-store and resolver APIs. It never reads or imports the ordinary Codex
CLI login.

```bash
CF_HARNESS_HOME=/canonical/private/home \
  deno run --no-lock -A src/loom-local-host-main.ts batch -- \
  --workspace ../.. --prompt "Summarize this workspace."

CF_HARNESS_HOME=/canonical/private/home \
  deno run --no-lock -A src/loom-local-host-main.ts interactive -- \
  --chat-session-db /private/runtime/chat.sqlite
```

The entrypoint serves both execution shapes. It rejects missing or invalid
provider configuration instead of applying the historical gateway default. Codex
preflight reads bounded connection health without refreshing; an expired
credential refreshes only in the serialized resolver immediately before model
traffic. Disconnected and reconnect-required Codex configurations return
`provider-auth-required` without contacting Codex or the gateway. Resumed runs
must match the recorded provider, model, fixed owner, auth source, and an opaque
digest of the canonical home. The path itself is never written to provider
binding metadata. Runs and durable chat sessions created before this complete
binding existed are deliberately not resumable through the local adapter; it
fails closed instead of guessing which credential home or billing route created
them.

Batch startup failures are one `cf-harness.host-failure` JSON object on stderr.
Interactive startup failures remain on the NDJSON chat protocol so hosts that do
not consume stderr still receive the stable provider error code. Run state,
manifests, reports, child manifests, and structured batch results record only
provider, the non-secret auth-source label, and the fixed owner reference.

Hosted or multi-user Loom must not reuse this single-user adapter. A trusted
multi-user host must instead:

- require the initiating user to connect ChatGPT/Codex explicitly;
- put `modelProvider: "openai-codex"` and a `cf-harness.credential-owner-ref` in
  the Loom run manifest;
- resolve that opaque owner in Loom's encrypted secret backend and inject an
  owner-bound credential resolver/model client into `cf-harness`;
- create one interactive service instance per authenticated credential owner; do
  not multiplex owners through one service process;
- apply the same host-verified binding to batch dispatch before enabling Loom.

Tokens and account ids must not be placed in manifests, Cells, Spaces, stdio
messages, session databases, command lines, or artifacts. A Loom Codex run
without an authenticated owner reference or injected resolver fails closed. For
interactive service processes, inject the owner-bound client through
`basePromptLoopOptions` and its matching full owner reference through
`credentialOwner`. The service constructor rejects Codex without this fixed
process owner. Do not accept an owner or token through the NDJSON request.

The multi-user library seam remains available, but its host still must
authenticate the initiating principal, enforce workspace policy, and prove
cross-user isolation before product rollout.

The manifest-side, non-secret selection looks like:

```json
{
  "type": "cf-harness.loom-run-manifest",
  "version": 1,
  "source": "loom",
  "modelProvider": "openai-codex",
  "credentialOwner": {
    "type": "cf-harness.credential-owner-ref",
    "version": 1,
    "ownerKey": "loom:principal-opaque-id",
    "tenantKey": "loom:tenant-opaque-id"
  }
}
```

Local open-weight model via any OpenAI-compatible server (llama.cpp shown; LM
Studio, vLLM, and Ollama's `/v1` endpoint work the same way):

```bash
# Serve the model locally (downloads on first run, ~63GB):
llama-server -hf ggml-org/gpt-oss-120b-GGUF --ctx-size 0 --jinja --port 8080

cd packages/cf-harness
deno task run -- \
  --workspace ../.. \
  --gateway-base-url http://localhost:8080/ \
  --gateway-auth-mode none \
  --model gpt-oss-120b \
  --prompt "Summarize the cf-harness package structure." \
  --print-transcript
```

The gateway can also be selected via environment, which lets callers (loom,
pattern-factory) switch to a local model without threading new flags:

```bash
export CF_HARNESS_GATEWAY_BASE_URL=http://localhost:8080/
export CF_HARNESS_GATEWAY_AUTH_MODE=none
export CF_HARNESS_MODEL=gpt-oss-120b
```

CLI flags take precedence over these variables. `CF_HARNESS_MODEL` is ignored on
`--resume-run`; an explicitly different `--model` is also rejected for Codex
runs because its encrypted continuation is model-bound.

### Request provenance

Every request the harness sends to the gateway says what caused it, so gateway
traffic can be read by the workload behind it rather than as one undivided
stream. The values travel as `x-cf-harness-*` headers and, condensed, inside the
`User-Agent`:

| Field       | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `invoker`   | `cli`, `test`, `integration-test`, `ci`, `loom`, or `service`        |
| `command`   | the subcommand: `auth`, `models`, `whoami`, or `prompt`              |
| `principal` | a random label for this machine, drawn once and kept                 |
| `session`   | a fresh identifier per process, so one run's requests group together |
| `ci`        | `github:<workflow>:<run id>`, naming one continuous-integration run  |
| `dispatch`  | the dispatch class, when a Loom run manifest asked for one           |
| `agent`     | `claude-code` or `codex`, when running inside one of their sessions  |
| `service`   | the service that launched the harness, when one did                  |

`invoker` is worked out from the environment: `CF_HARNESS_INTEGRATION=1` means
the integration suite, `ENV=test` the unit suite, `GITHUB_ACTIONS` or `CI` a
continuous-integration run, `OTEL_SERVICE_NAME` a service, and anything else a
person at a terminal. A Loom run manifest sets it to `loom`, along with the
dispatch class. `CF_HARNESS_PRINCIPAL` supplies a principal.

`agent` says which coding agent's session the harness is running inside, from
`CLAUDECODE` for Claude Code and `CODEX_SANDBOX` for the Codex CLI, both of
which those tools export to every process they spawn. Only which variable was
found is reported, never its value. An absent `agent` says no coding agent is in
the picture, which is what a person at a shell or a locally launched service
reports. The field is orthogonal to `invoker`, so a Loom dispatch started from
inside a Claude Code session reports both.

A service reaches this through `OTEL_SERVICE_NAME`, which it already sets to
name itself for tracing. Every process it spawns inherits the variable, so a
harness a service launches reports `invoker=service` and carries the service's
own name in `service`. The local dev launcher sets the name for both toolshed
and the background piece service.

No filesystem path and no git metadata contributes to any field. An absent field
means the value was not there to read.

The principal is generated on first use and kept in
`$CF_HARNESS_HOME/principal`, so nothing about the machine determines it. A
principal that could not be stored is reported as `unstable-<label>`; it lasts
for that process alone, so grouping by it undercounts.

Nothing derived from a prompt, a message, a tool argument, or a command line is
included. The subcommand comes from a closed set, so an unrecognized argument
reports `prompt`, and every value is bounded to a short run of characters that
cannot break a header or carry structure into one. A Loom manifest contributes
only its dispatch class.
[`docs/features/gateway-request-provenance.md`](../../docs/features/gateway-request-provenance.md)
holds the invariants these follow from.

The gateway's access log records the user agent of every request, so the
`User-Agent` copy is readable against the gateway as deployed. In Cloud Logging:

```text
resource.type="k8s_container"
resource.labels.namespace_name="envoy-gateway-system"
jsonPayload.method="POST"
jsonPayload."user-agent"=~"^cf-harness "
```

Requests through the Codex path (`--model-provider openai-codex`) address a
different endpoint and carry no provenance. Subagents share their parent's
client, so their requests carry the parent's session.

The harness is not the only sender. Toolshed imports these fields through
`@commonfabric/cf-harness/provenance` for the gateway requests its LLM routes
make, and opens its `User-Agent` with `toolshed` in place of `cf-harness`;
[`packages/toolshed/README.md`](../toolshed/README.md#gateway-request-provenance)
says what it reports. A field added here is a field both send, and the gateway
removes these headers from the request by name, so adding one takes a matching
change to the gateway manifests in the infra repository.

A principal names a machine and nothing else, so putting a name to one means
asking. Each person can read their own:

```bash
deno task run -- whoami
```

Each machine prints its own principal, and the command addresses whoever ran it.
The values below stand in for that; no two machines report the same ones:

```text
principal  <this machine's principal>
invoker    cli
session    <a fresh identifier for this process>
agent      claude-code
command    whoami

The principal is a random label drawn once for this machine and kept in
the harness home. It is what the LLM gateway records for requests from
here, so when a run is traced to a principal, <that principal> is yours.

user agent  cf-harness (principal=<principal>; invoker=cli; session=<first 8 characters>; agent=claude-code; command=whoami)
```

`whoami --json` prints the same fields for a script to read. A principal covers
one harness home, so someone who runs the harness from a laptop and a dev box
has one for each, and a home that is wiped starts a new one.

No real principal appears in this document. A principal published next to the
name of whoever committed it is tied to a person for good.

On hosts without the `runsc-cfc` Docker runtime (or where the installed CFC
policy does not label the workspace mount, which makes in-sandbox file reads
fail with SIGSYS), run with the plain `runc` runtime and observe-mode CFC:

```bash
export CF_HARNESS_SANDBOX_DOCKER_RUNTIME=runc
export CF_HARNESS_CFC_ENFORCEMENT_MODE=observe
```

Tool outputs are then exposed raw with policy warnings recorded in the run
report instead of being denied for missing trusted mediation metadata.

### Session-local address handles

Every run keeps a session-local handle table: short opaque tokens that stand in
for cell addresses in model-visible text, so a transcript never has to carry a
full LLM-friendly link. This is how the harness renders references — there is no
flag or environment variable governing it. Artifacts retain the raw bytes for
operators, and the table itself is run state.

An address token is `cfh:a:<suffix>`, where the suffix is exactly five
characters drawn from a 30-character alphabet — the digits `2`–`9` and the
lowercase letters minus `i`, `l`, `o`, and `u` — chosen so a token survives
being retyped. The `cfh:v:` prefix is reserved for a future value-handle kind
and is not implemented. Token derivation is deterministic: the suffix is
computed from the table's salt (the run id) and the normalized address, so the
same referent yields the same token within a run and two spellings of one
address (an LLM-friendly link and the bare entity URI, say) share one token. A
suffix collision re-derives a fresh five-character suffix with a counter mixed
into the hash, so no token is ever a prefix of another.

The table supports swapping in both directions:

- Outbound, positively-marked address forms become tokens: LLM-friendly link
  strings, standalone `of:`/`computed:`-schemed entity URIs (any tagged hash
  after the scheme, `fid1:` among them), and whole single-key
  `{"@link": "<address>"}` objects. A bare tagged hash without a scheme is never
  treated as an address — schema hashes, blob ids, and slugs share that
  encoding, so only the schemed forms are positively an address. Occurrences the
  runner cannot parse, and `@link` strings that are not entity addresses
  (`opaque:` handles among them), pass through unchanged.
- Inbound, every token the table holds becomes its canonical LLM-friendly
  reference string; a well-formed token the table does not hold is left
  untouched.

The table is per-run state: it is persisted in `run-state.json` alongside the
transcript and policy evidence, and a resumed run (`--resume-run`) carries its
table, so tokens stay stable across resume.

The prompt/tool loop applies the swaps at three seams. Successful tool output
bound for model context carries tokens, while the persisted tool-output artifact
keeps the raw addresses. Model-authored tool arguments resolve tokens back to
canonical references before policy evaluation, summarization, and dispatch —
except for `delegate_task`, whose arguments reach the child verbatim, so a token
there is inert text. And a sealed subagent structured-return string whose raw
value names an address comes back as a token rather than an opaque `@link`
object; the return's `linkedStringCount` counts only the positions still sealed.
Denial-path tool messages are not swapped; that coverage, cross-agent handle
semantics, value handles, and an explicit release/readback mechanism are listed
in [docs/ROADMAP.md](docs/ROADMAP.md).

### Running patterns against a Fabric space

Three flags configure one trusted Fabric session, and all of them go together:

```bash
cd packages/cf-harness
deno task run -- \
  --workspace /path/to/workspace \
  --fabric-api-url https://toolshed.example/ \
  --fabric-identity ~/.cf/agent.pkcs8 \
  --fabric-space my-space \
  --prompt "Deploy a pattern that doubles its input and report the result."
```

With all three present (`CF_HARNESS_FABRIC_API_URL`,
`CF_HARNESS_FABRIC_IDENTITY`, and `CF_HARNESS_FABRIC_SPACE` are the environment
fallbacks), the `run_pattern` tool joins the parent tool surface; with none, the
tool is absent and runs behave exactly as before; a partial set is a
configuration error naming the missing flags. The same holds under an explicit
allowlist: `--allow-tool run_pattern` without the three session flags is a
configuration error, and the tool is never offered to the model without a
session. `--fabric-space` accepts a space name or a `did:key`, and
`--describe-capabilities` reports `runPattern` among its features.

`run_pattern` executes on the trusted host side — it never enters the docker
sandbox. The session (a `PiecesController` against the deployed API) is built
lazily on the tool's first invocation; construction verifies the configured
space's authorization, and only a healthy session is cached for the run. A
session that fails to build surfaces as an ordinary tool-output error rather
than a run failure, and the next tool call retries the construction.

The tool takes `sourceText` (inline pattern source, at most 256 KiB — an
over-cap source is a structured tool error), an optional `inputs` object, and an
optional `resultSchema`. An `inputs` string value that is a whole-string
LLM-friendly link (`/of:fid1:.../path`) is passed to the pattern as a live cell
reference; everything else passes through as plain JSON. A link that resolves
into a space other than the configured session space is refused with a
structured error before anything is created, and a live-cell input whose current
value does not match the compiled pattern's argument schema for its key is
refused the same way — named after the offending key, with no piece persisted.
The deployed piece is deliberately unregistered — it never appears in the
space's piece list — and deliberately detached: no origin is recorded, because
model-authored source starts detached under the piece source-lifecycle spec.
Run→piece provenance is carried by the run's persisted artifacts instead —
run-state and the tool-output artifact record the `pieceId`. When the run's
abort signal fires while the tool is waiting for the pattern to settle, the tool
stops the created piece and returns a structured `cancelled` error; the signal
is the only cancellation source — there is no timeout.

Every `run_pattern` invocation persists such a piece in the configured space. A
cancelled run stops its piece, but no piece is ever deleted, and each piece's
source-history revision is a storage-retention root the piece list does not
reveal. Tooling that enumerates a space's contents from the piece list must not
assume the list is exhaustive, and there is no garbage collection for these
pieces yet.

A successful run returns `{ status: "ok", resultRef }` to the model, where
`resultRef` is the canonical LLM-friendly link to the piece's result cell, plus
the schema-sanitized `value` (with `linkedStringCount`) when `resultSchema` was
given. The ordinary outbound swap turns `resultRef` (and any link strings inside
`value`) into `cfh:a:` tokens at the model boundary, and the ordinary inbound
swap resolves such a token passed back through `inputs`; the tool itself carries
no handle code. The persisted tool-output artifact keeps the raw reference, the
raw result value, and the `pieceId` — a bare fabric identifier the handle
boundary never swaps, so it stays out of the model-facing rendering. Compiler
diagnostics come back as `{ status: "compile-error", message }` so the model can
iterate on the source; bare fabric identifiers a diagnostic can embed
(compiler-generated `fid1:` module roots, DIDs, `data:` URIs) are replaced with
a `[fabric-id]` placeholder in the model-facing message, while the persisted
artifact keeps the raw text.

Interactive chat stdio transport:

```bash
cd packages/cf-harness
deno run -A src/interactive-chat-stdio.ts \
  --chat-session-db /tmp/cf-harness-chat.sqlite
```

The stdio transport reads one interactive chat request envelope per line from
stdin and writes response/event envelopes as newline-delimited JSON. Pass
`--chat-session-db` or set `CF_HARNESS_CHAT_SESSION_DB` to persist sessions,
turn records, and replayable events across process restarts. Pass
`--chat-max-in-memory-events` or set `CF_HARNESS_CHAT_MAX_IN_MEMORY_EVENTS` to
bound the transport's in-memory event cache while keeping durable replay
available through SQLite.

Initial prompt image attachments:

```bash
cd packages/cf-harness
deno task run -- \
  --workspace /path/to/workspace \
  --gateway-auth-mode none \
  --image captures/example.png \
  --prompt "Describe the attached capture image and summarize useful next steps."
```

`--image` is repeatable and accepts `png`, `jpeg`, `gif`, and `webp` files
inside the workspace. Relative image paths are resolved from `--workspace`. The
transcript retains only image metadata (`hostPath`, media type, byte count,
digest); base64 pixels are materialized only for the gateway request.

Explicit skill preload:

```bash
deno task run -- \
  --workspace /path/to/common-fabric-2 \
  --cwd pattern-factory \
  --gateway-auth-mode none \
  --skills-root labs/skills \
  --skill pattern-dev \
  --skill pattern-implement \
  --prompt "Build this pattern."
```

Sandbox image override:

```bash
deno task run -- \
  --workspace /path/to/common-fabric-2 \
  --cwd pattern-factory \
  --gateway-auth-mode none \
  --sandbox-image registry.example/cf-harness-sandbox:deno2 \
  --prompt "Run deno task cf --help and report whether it works."
```

Use this for Deno 2 / Common Fabric CLI validation while keeping the mounted
workspace as the source of truth for Labs, Pattern Factory, and Loom code. Run
reports include the selected sandbox image in the capability snapshot.

Loom-backed batch runs may also pass a retained manifest:

```bash
deno task run -- \
  --workspace /path/to/workspace \
  --gateway-auth-mode none \
  --run-manifest /path/to/loom-run-manifest.json \
  --prompt "Handle this Loom wish."
```

Batch runs can require the agent to produce a schema-validated JSON sidecar
before the CLI exits successfully. `--result-json-path` remains the harness
metadata output; `--structured-result-path` is the agent-authored JSON file to
validate:

```bash
deno task run -- \
  --workspace /path/to/workspace \
  --gateway-auth-mode none \
  --output-mode batch \
  --result-json-path /tmp/cf-harness-result.json \
  --structured-result-path capture.results.json \
  --structured-result-schema-file /path/to/result.schema.json \
  --prompt "Write capture.results.json with the requested structured result."
```

The structured result path must stay inside the workspace. The schema may be
provided inline with `--structured-result-schema` or read from
`--structured-result-schema-file`. After the run, cf-harness reads the sidecar,
validates it with the same JSON Schema validation primitives used by subagent
`returnSchema`, records `structured_result` in the batch metadata, and exits
nonzero when the file is missing, invalid JSON, or schema-invalid.

When constraining the parent tool surface to `delegate_task`, authorize the
child profile separately so the delegation policy transition is explicit:

```bash
deno task run -- \
  --workspace /path/to/workspace \
  --gateway-auth-mode none \
  --allow-tool delegate_task \
  --allow-subagent-profile default \
  --prompt "Delegate a focused inspection and summarize the result."
```

The provisional browser profile is the only CLI-supported path to
`bash-no-sandbox`. It gives the child a host shell so it can invoke
`agent-browser`, while the parent still receives only the normal sanitized
subagent result. Browser/page output is treated as untrusted child-local data;
with a `returnSchema`, parent-visible free-form strings are replaced by opaque
links while raw observations stay in child artifacts. The browser child can read
workspace files but does not receive `edit_file` or `write_file`, so it should
return findings through the structured return channel rather than by writing
browser observations into the workspace.

When the parent run has a skill registry, the browser profile activates the
`agent-browser` skill in the child run, exposes `read_skill_resource`, and
allows these exact skill scripts through `run_skill_script`:
`agent-browser:scripts/form-automation.sh`,
`agent-browser:scripts/capture-workflow.sh`. Those browser-profile scripts run
through host execution because they need the host `agent-browser` CLI. They
still use the normal skill-script safeguards: activated skill, run-start
registry snapshot, exact script allowlist, digest/size match, and provenance
artifacts.

The host shell is policy-restricted to `agent-browser` attached through the
exact Loom Browser Access CDP endpoint supplied to the child task,
`agent-browser` discovery (`which agent-browser`, `command -v agent-browser`),
`pwd`, `ls`, and bounded workspace-local `find` commands. Page commands should
use the leased endpoint, for example
`agent-browser --cdp http://host.docker.internal:9362 snapshot -i`. Bare
`agent-browser open` / `snapshot` launches are denied so the child cannot race
the host's live browser profile. `agent-browser` is fail-closed to a small
positive allowlist: `open` for HTTP(S) URLs, `snapshot`, `get title/url/text`,
read-only `console` / `errors` inspection without mutation flags, bounded
`wait`, and ref-based `fill`, `type`, `select`, `check`, `click`, and `press`.

Host-target skill scripts run with a cleared subprocess environment plus a
controlled `PATH` and explicit `CF_HARNESS_*` / `SKILL_*` variables. They do not
inherit ambient provider tokens, developer secrets, app credentials, or other
parent process environment. Credential-bearing workflows such as
`agent-browser:scripts/authenticated-session.sh` are intentionally not in the
default browser-profile allowlist; adding them should go through an explicit
credential grant and origin-binding design.

For browser-profile runs, prefer a host artifact root outside the workspace. Raw
child artifacts are retained for operator analysis, but they are not meant to
become ordinary workspace inputs for the parent model. If an artifact root is
physically placed under the workspace, `read_file`, `view_image`, `write_file`,
and `edit_file`, plus browser-profile `ls`/`find`, treat that artifact tree as
reserved from model-facing file and discovery tools.

```bash
ROOT=/tmp/cf-harness-browser-demo
mkdir -p "$ROOT/workspace" "$ROOT/artifacts"

deno task run -- \
  --workspace "$ROOT/workspace" \
  --artifact-root "$ROOT/artifacts" \
  --gateway-auth-mode none \
  --allow-tool delegate_task \
  --allow-subagent-profile browser \
  --prompt "Delegate browser inspection of the local app and summarize the result."
```

The `web_fetch` profile is the preferred first-pass path for web page
inspection. It gives the child only the `web_fetch` tool: no shell, no browser,
no workspace reads, and no workspace writes. This keeps external web content in
the child run and returns only the normal sanitized subagent summary/state to
the parent. Use this profile when a task needs to inspect public HTTP(S) pages
but does not need authenticated browser state or general web search.

```bash
deno task run -- \
  --workspace /path/to/workspace \
  --gateway-auth-mode none \
  --allow-tool delegate_task \
  --allow-subagent-profile web_fetch \
  --prompt "Delegate inspection of https://example.com and summarize the result."
```

The `web_search` profile is the provider-native search profile. It runs the
child on the configured Gemini search model, requests the gateway's
`google_search` native model tool, and gives the child no built-in file, shell,
browser, or fetch tools. The intended use is the same CFC boundary as browser
and web_fetch subagents: the parent delegates a focused search task, raw search
observations stay in child artifacts, and the parent receives only the sanitized
subagent return channel. Because this profile overrides the parent model, parent
`--reasoning-effort` and `--prompt-cache-mode` settings remain on
model-inheriting loops and do not apply to the search child.

Programmatic `delegate_task` calls may include `returnSchema`, a JSON Schema
object or boolean. In that mode the child is required to return a single JSON
value. The harness validates it, stores the raw child return under the child
artifact root, and exposes `subagent.structuredReturn.value` to the parent with
free-form strings and objects with unmodeled keys replaced by opaque `@link`
objects such as `opaque:<child-run-id>#/json/pointer`:

```json
{
  "goal": "Assess the briefing and return only the decision facts.",
  "returnSchema": {
    "type": "object",
    "properties": {
      "approved": { "type": "boolean" },
      "status": { "type": "string", "enum": ["approved", "not_approved"] },
      "summary": { "type": "string" }
    },
    "required": ["approved", "status", "summary"],
    "additionalProperties": false
  }
}
```

Current caveat:

- the default gateway target is still the stage endpoint at
  [https://llm.stage.commontools.dev/](https://llm.stage.commontools.dev/)
- gateway auth defaults remain an ergonomics question:
  - standalone `cf-harness` still defaults to `bearer`
  - Loom's `cf-harness` adapter defaults to `none`
- confirm the intended gateway/auth mode for the environment you are testing
  against
- skills support is explicit preload only for now:
  - `--skill` requires `--skills-root`
  - skill preload is not supported with `--resume-run`
  - dynamic `load_skill` activation is still planned

## Testing

Unit/package tests:

```bash
cd packages/cf-harness
deno task test
```

Environment-gated integration tests:

```bash
cd packages/cf-harness
deno task test:integration
```

The integration suite requires a working local Docker + `runsc-cfc` environment.
By default it also uses the published kitchen-sink image above, unless you
override `CF_HARNESS_INTEGRATION_IMAGE`.

To opt into a local Labs CLI smoke inside the sandbox, use a Deno 2-compatible
image and enable the CF CLI case:

```bash
cd packages/cf-harness
CF_HARNESS_INTEGRATION_IMAGE=registry.example/cf-harness-sandbox:deno2 \
CF_HARNESS_INTEGRATION_CF_CLI=1 \
deno task test:integration
```

That case mounts the current Labs checkout as `/workspace` and runs
`deno task cf --help` inside the `runsc-cfc` sandbox. It is skipped by default
because the published kitchen-sink image may not have the required Deno version
or cache state.

To also exercise a real host Fabric FUSE mount bind-mounted into the sandbox at
`/fabric`, start `cf fuse mount` separately and pass the mountpoint:

```bash
cd packages/cf-harness
CF_HARNESS_INTEGRATION_FABRIC_MOUNT=/tmp/cf deno task test:integration
```

That opt-in case verifies that cf-harness can navigate `/fabric` through
`runsc-cfc` and read the FUSE `.status` file. Without
`CF_HARNESS_INTEGRATION_FABRIC_MOUNT`, the Fabric mount case is skipped.

To exercise label flow through a live Fabric FUSE projection, enable the
additional CFC flow tests and provide concrete read/write projection paths under
`/fabric`:

```bash
# In another terminal, mount FUSE with Docker traversal enabled.
cf fuse mount /tmp/cf --allow-other --cfc-mode=observe --cfc-writeback-xattrs

cd packages/cf-harness
CF_HARNESS_RUNSC_CFC_RESULT_DIR="$HOME/.local/share/runsc-cfc/cfc-results" \
CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR="$HOME/.local/share/runsc-cfc/cfc-invocations" \
CF_HARNESS_INTEGRATION_FABRIC_MOUNT=/tmp/cf \
CF_HARNESS_INTEGRATION_FABRIC_CFC_FLOW=1 \
CF_HARNESS_INTEGRATION_FABRIC_CFC_READ_PATH=/fabric/home/pieces/example/result/secret \
CF_HARNESS_INTEGRATION_FABRIC_CFC_WRITE_PATH=/fabric/home/pieces/example/result/output \
CF_HARNESS_INTEGRATION_FABRIC_CFC_LABEL_SUBJECT=did:key:fabric \
deno task test:integration
```

When those env vars point at a real labeled FUSE fixture, the extra tests probe
FUSE-to-sandbox taint, command completion after a FUSE read, FUSE write
attempts, and joins between explicit `cfcInputLabels` and a prior FUSE read. The
result sidecar env var is required for all CFC flow assertions, and the
invocation context sidecar env var is required for the cases that seed
`cfcInputLabels`. The installed Docker `runsc-cfc` runtime must also be
configured with the same `--cfc-invocation-context-dir`, otherwise those
invocation-label cases are skipped even if cf-harness writes sidecars.

The default Fabric CFC flow gate exercises the immediate result sidecar after a
FUSE read. The stricter host-bind readback probe is opt-in with
`CF_HARNESS_INTEGRATION_FABRIC_CFC_DURABLE_HOST_LABEL=1` because durable
`FUSE -> sandbox -> host -> sandbox` label persistence is still a live-stack
validation target. FUSE write assertions are also probes of the live stack:
durable cell-label writeback depends on the runner/runtime emitting FUSE
prepare/finalize metadata, not arbitrary direct writes to
`trusted.cfc.contentLabel`.

On Linux, Docker/runsc runs default to the host UID/GID. On macOS, the default
omits `--user` because Docker Desktop bind mounts may expose host files as
`root:root`, which prevents non-root container users from writing mounted Loom
workspaces. An explicit `containerUser` still overrides the platform default.

CFC sandbox result mediation requires the installed `runsc-cfc` runtime to use
the same host result directory that `cf-harness` reads. Configure runsc with
`--cfc-result-dir=/path/to/results`, then set
`CF_HARNESS_RUNSC_CFC_RESULT_DIR=/path/to/results` or pass `cfcResultDir` in the
explicit sandbox config.

CFC invocation context transport is similarly coordinated through a host sidecar
directory. Configure runsc with
`--cfc-invocation-context-dir=/path/to/invocations`, then set
`CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR=/path/to/invocations` or pass
`cfcInvocationContextDir` in the explicit sandbox config. `cf-harness` writes
`<containerID>.json` after `docker create` and before `docker start`; the
payload contains audit/provenance context plus optional trusted `cfcInputLabels`
for supported startup inputs (`command`, `argv`, `args`, `env`, `cwd`, and
`stdin`). `stdin` labels are modeled as labels on the stdin source and taint
only after the sandbox reads or maps fd 0, not as automatic startup task taint.
When a trusted prompt-slot binding is present, `cf-harness` also derives
confidentiality-only prompt influence labels for model-authored invocation
inputs such as shell commands, structured file-tool arguments, and stdin
payloads. These labels are taint evidence, not integrity or authorization
claims. When CFC-mediated bash output is released to the model, `cf-harness`
records the observed output labels in run state and merges those confidentiality
labels into later model-authored invocation inputs. Opaque and denied outputs
are not added to this model-context accumulator.

The persisted model-context accumulator is sensitive retained run metadata. It
does not store raw stdout/stderr bytes, but its labels and observation refs can
still disclose which confidential sources influenced model-visible context.
Handle it under the same access and retention boundary as transcripts, tool
outputs, run state, and CFC policy traces.

On Docker Desktop for macOS, use the host path for `cf-harness` and the
`/host_mnt/...` projection for Docker's runtime args. The gVisor
`docker-desktop-cfc-setup` helper defaults to:

```bash
export CF_HARNESS_RUNSC_CFC_RESULT_DIR="$HOME/.local/share/runsc-cfc/cfc-results"
export CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR="$HOME/.local/share/runsc-cfc/cfc-invocations"
```

## Related Docs

- [cf-harness documentation map](docs/README.md)
- [current implementation state](docs/CURRENT_STATE.md)
- [Agent Harness implementation profile](docs/IMPLEMENTATION_PROFILE.md)
- [roadmap](docs/ROADMAP.md)
- [skills support design and contract](docs/SKILLS_SUPPORT_SPEC.md)
- [runner README](../runner/README.md)
- `specs/agent-harness/` in the sibling `specs` repo
- `specs/cfc/18-runtime-implementation-profiles.md` in the sibling `specs` repo
