# @commonfabric/cf-harness

**Start here:** [ONBOARDING.md](ONBOARDING.md) is the single path from local
prerequisites to a console attached to a toolshed you already run, a first task
typed into its page, and the session, transcript, and run artifacts it leaves;
it carries the labeled-input-cell flow through to the CFC audit as one worked
example, and points to the experiment and measurement records without
duplicating them here.

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

## The model: handles and patterns

Two ideas carry this package, and nearly everything else in this document is one
of them wearing different clothes.

**An agent here works in handles, and a schema decides what becomes a value.** A
handle names something in a Fabric space without carrying it; the model composes
work out of these names, passing one to a tool, handing one to a subagent,
publishing one under a slug, asking what shape it has. What crosses as a value
is not whatever the agent asked for — it is what a declared schema admits.
`run_pattern` returns the fields its `resultSchema` models as inert (a number, a
boolean, an enum or const string) as themselves, and everything else as a
reference token addressing that position. So a total comes back as `42` and a
free-text description comes back as something to point at.

That is the useful shape of it: the declaration is the boundary, and it is a
narrow one by construction. A field typed as one of three enum values can carry
no more than those three values, whatever the data behind it turned out to be.
Widening what crosses means widening a schema on purpose, in the open, rather
than a value slipping through because nobody said it should not.

**Work happens by running patterns over those handles.** When an agent needs
something computed, it does not fetch the data and compute in its own context;
it writes a pattern, runs it in the space against references it holds, and
receives a handle to the result. The computation goes to the data. This is why
`run_pattern` is the central tool rather than one of many, and why a result is a
piece a person can open rather than a paragraph in a transcript.

Read the rest of this document through those two. Delegation gives a child a
fresh context seeded with handles. `describe_handle` answers what a reference is
shaped like without reading it. `assign_slug` names a piece the caller holds a
handle to. Sealed positions in a structured result cross as their own addresses.
The browser's `valueHandle` lets an action spend a value the model never held —
though a page that receives one can hand it back to whatever reads that page
next, which the browser section covers. None of these is a separate mechanism;
each is the same two ideas reaching a new surface.

**This is not a confidentiality feature.** It would be a mistake to read the
handle machinery as special handling for secrets, switched on when data is
sensitive. It is how everything works here. Confidentiality is one thing that
partly falls out of it — an agent cannot leak what it never held, though what a
schema admits it does hold — but so do the properties that matter when nothing
is secret at all: a transcript that stays small because it carries names rather
than payloads, results that are durable objects instead of prose, work that
composes because every step produces something the next step can refer to.
Treating it as a special case for sensitive values is the surest way to write a
tool that quietly breaks the model for everything else.

**What this asks of you when extending the harness.** A new tool that accepts a
reference should accept a handle. A new tool that produces something should
produce a handle to it rather than its contents. A new field that takes a value
should ask whether it also wants a handle sibling. The question to hold onto is
not "is this data sensitive" but "does this make the agent hold something it
could have merely named".

The place the model is not yet fully realized is delegation: `delegate_task`
passes its goal and context as free text, so what a parent tells a child is
prose rather than bound references, and a parent can put in it anything it
happens to know. Handles cross that boundary — a child resolves tokens its
parent minted — but the brief around them does not. Closing that is live work,
not a settled part of the design.

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
  - `browser` (structured host browser control for the browser subagent profile
    only)
  - `read_file`
  - `view_image`
  - `web_fetch` (explicit parent allowlist or `web_fetch` subagent profile only)
  - `read_skill_resource`
  - `run_skill_script`
  - `edit_file`
  - `write_file`
  - `delegate_task`
  - `describe_handle` (shape and labels of a handle's referent, never its value;
    see [Inspecting a handle's shape](#inspecting-a-handles-shape))
  - `run_pattern` (present only when the run configures a fabric session; see
    [Running patterns against a Fabric space](#running-patterns-against-a-fabric-space))
  - `search_patterns` (present only when the run configures a pattern index with
    `--pattern-index-url`; finds published patterns by hashtag or free text and
    reports each one's kind, evidence quality, declared shapes, and import
    specifier, never its source)
  - `record_feedback` (under the same pattern-index gate; votes a pattern up or
    down so the index learns which ones were worth offering)
  - `search_skills` (present only on the parent surface when the run configures
    the public registry with `--skills-registry-url`; returns sanitized
    identifiers, names, sources, registry-reported install counts, and the
    number of refused hits, never skill text. Install counts are unauthenticated
    and unverifiable telemetry, not a trust signal)
  - `acquire_skill` (present only on the parent surface when both the skills
    registry and a Fabric session are configured; resolves a discovery id to a
    full GitHub commit, checks the complete recursive tree, and returns a handle
    or a first-class refusal, never skill text)
  - `query_docs` (present when the run resolves a documentation corpus; asks one
    question of operator-provisioned reference material and returns a bounded
    answer plus inert citations, never the documents; see
    [Querying the documentation corpus](#querying-the-documentation-corpus))
- composing published patterns: source the model authors may
  `import Sub from "cf:pattern:<patternId>"`, and `run_pattern` fetches and
  compiles each named pattern into the space before compiling the source that
  imports it, so composition costs the import line and nothing else — and no
  part of an imported pattern's source reaches the conversation
- publishing back to that index: a pattern the model authored and ran
  successfully is recorded under the identity its compile recorded, with the
  `description` and `hashtags` the `run_pattern` call named, unless the run was
  started with `--no-pattern-index-publish`; it is not offered to search until
  evidence earns discoverability. Curated seeding may opt in with
  `CF_HARNESS_PATTERN_INDEX_PUBLISH_DISCOVERABLE=1`
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
  default/browser/web_fetch/web_search/pattern-author child profiles, retained
  child run references, and a sanitized summary/state return channel, plus the
  internal `explore` profile `query_docs` runs, which a delegation cannot name
- optional schema-validated subagent structured returns, with raw child return
  artifacts retained in the child run and open-ended strings linkified before
  the parent sees them
- persisted run state, model-facing transcript, transcript omission records, run
  reports, Loom run manifests, capability snapshots, and tool outputs, plus
  explicit skill registry and activation artifacts
- provider-neutral run-report model-attempt diagnostics, one record per attempt,
  naming the provider and the API operation that served it, and timing it twice
  — `durationMs` to the response headers, `responseCompleteDurationMs` to the
  end of the body or stream, which is the model's own working time — with the
  provider's stated reason for a failed attempt and, when the client issued the
  exchange again, why; see
  [Model attempts and transport retry](#model-attempts-and-transport-retry)
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
- an Agent Skills registry over `--skills-root`, defaulting to the checkout's
  own `skills/` tree, with repeatable `--skill` preloading by name
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
- default CFC mode of `enforce-explicit`, which fails closed on an observation
  whose trusted mediation metadata is absent
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
  cell addresses, minted per run, recorded in run state, carried across
  `--resume-run`, and seeded into a subagent's own table by the delegation that
  names them; see
  [Session-local address handles](#session-local-address-handles)
- an opt-in `run_pattern` tool (`--fabric-api-url`, `--fabric-identity`, and
  `--fabric-space` together) that compiles and runs a pattern against a deployed
  Fabric space from the trusted host side and returns a live result cell
  reference; `assign_slug` names and lists a piece afterwards, so a person can
  open it; see
  [Running patterns against a Fabric space](#running-patterns-against-a-fabric-space)

What is not done yet:

- real runner-driven CFC feedback integration
- session handle coverage beyond the wired seams: denial-path tool messages, and
  value handles (`cfh:v:`)
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
- [src/schema-shape.ts](src/schema-shape.ts)
  - allowlist rebuild that reduces a schema to structure for `describe_handle`
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
  - persisted run state, run manifest, transcript and its omission record, run
    report, capability snapshot, and tool output storage
- [src/skills/](src/skills/)
  - Agent Skills registry scanning, validation, and explicit preload context
- [src/contracts/](src/contracts/)
  - prompt-slot, run-manifest, observation, policy, run-report, subagent, skill,
    transcript, transcript-omission, tool-result, and handle-table contracts
- [audit/](audit/)
  - the CFC audit: a read-only checker that reads a run family's artifacts and
    reports, per clause of the agent-harness CFC profile, what they establish.
    See [The CFC audit](#the-cfc-audit)
- [console/](console/)
  - the console: a localhost page that starts a session, watches it live, and
    reads any run back as a map of its cells, calls and CFC verdicts. Its
    Timeline places the model-facing result beside the full fields withheld from
    it, labeled by omission rule. See [console/README.md](console/README.md)
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
- `deno task cfc-audit <runDir | artifactRoot> [more paths...] [--json]
  [--fail-on fail|warn|inconclusive] [--corpus] [--expect-refusals]
  [--expected-posture <spec.json>] [--toolshed-url <url>]`
  — audit session artifacts against the CFC integration profile. See
  [The CFC audit](#the-cfc-audit)
- `deno task cfc-audit-fixtures` — rewrite the committed artifact tree the audit
  suites read
- `deno task console` — build the console page and serve it on `127.0.0.1:8100`
- `deno task console:build`, `deno task console:watch` — the build on its own,
  and a rebuild on save while changing the page
- `deno task probe-skills-sh [--owner <owner>] "<query>"` — read a public skill
  registry's search route and print the identifiers, names, and sources it
  answers with, along with a count of the entries the client refused. It is the
  one thing here that calls the live registry, which is why it is a script you
  run rather than a test that runs itself; the committed tests use a captured
  response. It uses the same guarded client as the parent-only `search_skills`
  tool and prints no skill text. Configure discovery and pinned acquisition with
  `--skills-registry-url` or `CF_HARNESS_SKILLS_REGISTRY_URL`; without either,
  both tools are absent. `acquire_skill` additionally requires the three Fabric
  session flags because its successful result is a durable cell handle. The
  discovery half of
  [`../../docs/plans/external-skill-acquisition.md`](../../docs/plans/external-skill-acquisition.md)
  is what it exists to exercise.
- `scripts/hostile-skill-demo.sh` — the CT-2091 hostile-skill demo (CT-2066 Demo
  3). One direct batch run under `max-enforcement / enforce-strict` with a
  restricted parent surface (`delegate_task`, `describe_handle`,
  `search_skills`, `acquire_skill`) that runs two arms over one finance-labeled
  input cell: a real skill acquired from the registry and used by handle, and
  the malicious [`fixtures/hostile-skills-root/`](fixtures/README.md) skill
  delivered into a `pattern-author` child. After the run it emits the three
  receipts — the canary grep over the parent run directory, the release-refusal
  trace, and the persisted label plus `TransformedBy` on derived data. It reads
  the identity keyfile from `CF_HARNESS_FABRIC_IDENTITY` and never echoes it;
  override the toolshed, space, cell, and space-db through the environment
  variables it documents at the top.

## CLI Example

Every run selects a provider, and there is no default. The examples in this
section pass `--model-provider` for one run; `CF_HARNESS_MODEL_PROVIDER` selects
one for a shell and `config set` selects one for a machine, and the later
examples in this document assume a provider selected one of those two ways.

Standard bearer-auth mode:

```bash
cd packages/cf-harness
CF_HARNESS_API_KEY=... deno task run -- \
  --workspace ../.. \
  --model-provider openai-compatible-gateway \
  --prompt "Summarize the cf-harness package structure." \
  --print-transcript
```

No-auth gateway mode:

```bash
cd packages/cf-harness
deno task run -- \
  --workspace ../.. \
  --model-provider openai-compatible-gateway \
  --gateway-auth-mode none \
  --prompt "Summarize the cf-harness package structure." \
  --print-transcript
```

GPT-5.6 cache experiment:

```bash
cd packages/cf-harness
CF_HARNESS_API_KEY=... deno task run -- \
  --workspace ../.. \
  --model-provider openai-compatible-gateway \
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

Direct runs resolve a provider from explicit CLI, environment, then persistent
preference. Every provider is opt-in: a run that names none through
`--model-provider`, `CF_HARNESS_MODEL_PROVIDER`, or `config set` fails with
`provider-configuration-required` rather than billing a route it never chose.
Provider resolution does not resolve or rewrite model aliases. Resume retains
the recorded provider and ignores the persistent preference; an explicit
conflicting provider is a `provider-mismatch` failure. Structured config and
auth commands use versioned JSON result envelopes. Login emits a versioned
NDJSON authorization event before its terminal result. These responses expose
connection health but no tokens, full account identifiers, expiries, or raw
provider errors.

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
provider configuration, and reads only the persisted preference from that
home—the environment and CLI selections direct runs accept are not consulted.
Codex preflight reads bounded connection health without refreshing; an expired
credential refreshes only in the serialized resolver immediately before model
traffic. Disconnected and reconnect-required Codex configurations return
`provider-auth-required` without contacting Codex or the gateway. Resumed runs
must match the recorded provider, model, fixed owner, auth source, and an opaque
digest of the canonical home. The path itself is never written to provider
binding metadata. Runs and durable chat sessions created before this complete
binding existed are deliberately not resumable through the local adapter; it
fails closed instead of guessing which credential home or billing route created
them.

Batch argv is a prompt run and nothing else. `--help` and
`--describe-capabilities` answer without reading provider or auth state; every
other argv is bound and executed, so argv led by a CLI subcommand — `auth`,
`config`, `models`, `whoami` — is rejected as `invalid-request` rather than
billed as a prompt whose text happens to read like a command. Run those against
the cf-harness CLI itself. The leading token is what decides, so positional
prompt text opening on one of those four words is refused the same way; pass it
through `--prompt` to send it as prompt text.

Batch startup failures are one `cf-harness.host-failure` JSON object on stderr.
Interactive startup failures remain on the NDJSON chat protocol so hosts that do
not consume stderr still receive the stable provider error code. Those failures
carry `retryable` in HTTP's `Retry-After` sense — set only where waiting alone
can clear the blocker, which among startup blockers means an unreachable
provider and nothing else. An unauthenticated or unconfigured provider needs
someone to act before a retry means anything, so it stays unset, as does a host
that broke unexpectedly and cannot say. A failure is `invalid-request` only
while the argv and the recorded binding are still being checked; once a run
starts being built, an infrastructure fault reports `internal-error`, so a host
can keep a retry policy keyed on the code. Run state, manifests, reports, child
manifests, and structured batch results record only provider, the non-secret
auth-source label, and the fixed owner reference.

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

### Model attempts and transport retry

Every request a model client issues is one `cf-harness.model-attempt` record in
the run report's `modelAttempts`, whether it got a response or not. A record
names the provider and operation, numbers the attempt against
`maxTransportAttempts`, times it, summarizes the request, and says how it ended:
`outcome` is `transport_error` when no response arrived and `http_response`
otherwise, with the status and selected headers.

A failed attempt carries the provider's own reason wherever the provider stated
one. `providerError` holds the provider's `type`, `code`, and `message` as the
provider sent them — from the body of a non-2xx response, from an in-stream
`error` event, or from a failed terminal response — and the same three fields
are in the message of the error the turn fails with, so a turn failure record, a
console `turn_failed` event, and the CLI's control failure all say what the
provider said. A provider that returns a bare `503` states no reason, and the
record carries none rather than a guess.

A transient failure is issued again before anything reaches the harness. Three
kinds qualify, and only these: a transport error, where no response arrived; a
`429` or `5xx` status; and a provider-stated error whose type or code names
capacity, rate limiting, or a server-side fault — `server_is_overloaded` and
`service_unavailable_error` among them. Anything else ends the exchange on its
first attempt: a `4xx` refuses the request itself, a provider error naming the
request cannot be cleared by waiting, and a body that is not SSE-framed JSON is
a protocol failure, not a transient one.

Reissuing is safe because the harness dispatches nothing from an attempt that
did not complete: a model exchange has no side effect until a tool call from its
result is dispatched, and the client returns nothing until an attempt reaches a
completed terminal response. Whatever a failed attempt streamed, tool calls
included, is discarded with it. A `429` from the Codex provider is its usage
limit, which the backoff does not clear; the retry there is bounded by the same
schedule and costs seconds, not a turn.

The bound is `transportRetries` attempts beyond the first — three unless a
client is configured otherwise — with a backoff of `transportRetryDelayMs`
before the second attempt, doubling before each attempt after it. An attempt
that is followed by another says so: its record carries `retry`, naming the
`kind` of transient failure (`transport_error`, `http_status`, or
`provider_error`) and the `delayMs` waited before the next attempt. The last
attempt of an exchange never carries one, however it ended. The backoff is
waited out through an injected `transportRetryDelay`, which is how a test drives
a retry sequence without a timer.

### Session-local address handles

This is the mechanism behind the first half of
[the model](#the-model-handles-and-patterns): how a reference is rendered so
that naming something never means carrying it.

Every run keeps a session-local handle table: short opaque tokens that stand in
for cell addresses in model-visible text, so a transcript never has to carry a
full LLM-friendly link. This is how the harness renders references — there is no
flag or environment variable governing it, because it is not a mode. Artifacts
retain the raw bytes for operators, and the table itself is run state.

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
except for `delegate_task`, whose `goal` and `context` reach the child verbatim,
so a token there is inert text to the parent boundary. Its `skillHandle` and
`patternRefs` fields are resolved separately on the trusted side: materializing
stored skill text and rebuilding selected pattern-search records are those
parameters' whole point (see "Skill by handle" and "Pattern references by search
record" below). And a sealed subagent structured-return string whose raw value
names an address comes back as a token rather than an opaque `@link` object; the
return's `linkedStringCount` counts only the positions still sealed. Denial-path
tool messages are not swapped; that coverage, value handles, and an explicit
release/readback mechanism are listed in [docs/ROADMAP.md](docs/ROADMAP.md).

#### Well-known grants

A run configured with a Fabric session starts with a seeded handle: before the
first model turn, the CLI establishes the session, mints a token for the space's
piece registry — the same discovery root behind `cf piece ls` — and announces it
in a context message pairing the token with a fixed, harness-authored
description. The address stays trusted-side in the handle table like any other
entry. This is what lets an agent find pieces to compute over without an
operator handing it references one by one: discovery is `run_pattern` over the
granted token, not a tool of its own, and `describe_handle` answers the
registry's shape like any other reference.

What the model receives is a token and fixed prose, never data. Reading anything
behind the token means running a pattern over it, where the CFC boundary rules
as it does for every other flow — in particular, a piece's `$NAME` is a value,
and a name computed from labeled data taints a name-listing pattern's result,
which strict enforcement refuses whole. The announcement says so and names the
fallback: a pattern that returns the entry references without reading any
values, which cannot taint and whose addresses come back as tokens through the
ordinary outbound swap.

The grants are recorded in run state (`wellKnownGrants`), replayed rather than
re-minted on resume, and reported in the operator summary as `fabricGrants:`. A
session that cannot be established leaves the run to proceed without its grants,
and the CLI says so on stderr rather than staying silent. The grant list is
designed to grow; the identity's profile is the expected next entry.

#### Operator input cells

`--input-cell <name>=<link>` (repeatable) passes a cell into the run by
reference: a cell populated in the space before the run exists, handed to the
run as its input. Cells are the runtime's medium of exchange; the handle minted
for one is only how the harness names a cell to a model that cannot hold
addresses. The model is told the token and the operator's `<name>` for it,
nothing more: the run's inputs reach the model from its first turn while their
values stay in the fabric, so a prompt never holds a literal it could inline or
pass on by accident. No shape is stated on the flag, by rule: an input cell
carries its own declared schema in the fabric — the same place its CFC labels
live — and `describe_handle` answers from that declaration, so there is one
source of truth and nothing an operator-written view could drift from or quietly
claim.

Unlike a grant, an input cell is explicit configuration, so failure is closed
and loud rather than tolerated: a malformed argument is a usage error, and a
reference that does not parse, targets another space, or arrives on a run
without a fabric session fails the run before the model is involved. The cells
are recorded in run state (`inputCells`), replayed rather than re-minted on
resume, and reported in the operator summary as `inputCells:`.

#### Inspecting a handle's shape

A token says nothing about what it refers to, and an agent handed one cannot
write a line of code over it without knowing the shape of what is there.
`describe_handle` closes that gap without opening the data: given a token, it
reports the shape of the referent, the path segments — what field of what piece
the token names — the CFC labels the referent carries, and never the value.

```json
{
  "token": "cfh:a:k7m2q",
  "known": true,
  "hasSchema": true,
  "schema": {
    "type": "object",
    "properties": { "doubled": { "type": "number" } }
  },
  "path": ["doubled"],
  "labels": [
    {
      "confidentiality": [["https://commonfabric.org/cfc/atom/Space"]],
      "integrity": ["https://commonfabric.org/cfc/atom/ExternalIngest"]
    }
  ]
}
```

Labels answer from the same read as the shape, wherever the run has a session to
read through, and they are a different fact from the schema: a cell's labels
live in its own metadata rather than on its declaration, so a referent can carry
a full label map and state no shape at all. Only atom TYPES cross — the URLs
naming what a value requires and what it carries — and never an atom's other
fields, which say what a label was computed FROM. `confidentiality` holds one
entry per clause, each listing the atom types that satisfy it, because a clause
of several types is satisfied by any one of them and flattening that would
report a weaker requirement as a stronger one. An empty list says the space
holds no label; no list at all says the run had no session to ask.

Two sources can answer for the shape, in this order. The referent's own declared
schema, read through the run's fabric session when it has one: a piece's
document schema is the result schema of the pattern behind it, which is exactly
what an agent holding a handle to that piece would be wiring into a pattern of
its own. Failing that, the schema the mint recorded out of the harness's own
work — a `run_pattern` result reference carries the compiled pattern's result
schema, which compilation produced anyway, and the entry is marked
`schemaSource: "harness"`. A run with no session still answers from its own
table, so shape stays inspectable in every run that has handles at all. A token
the run's table does not hold comes back `known: false` rather than as an error,
since a token from another run simply names nothing here.

**What is disclosed is structure and only structure**: property names, types,
nesting, required-ness, array and object composition, a `type` from the schema
vocabulary, a `format` from the small known set, and a local `$ref` with the
`$defs` it points into. Definition names are not part of that: every `$defs` and
`definitions` key is replaced by an opaque `d0`, `d1`, … and every `$ref` that
resolves to one is rewritten to match, so the reported schema stays
referentially valid while no name its author chose for a definition crosses. A
`$ref` that resolves to nothing — a pointer into a `$defs` the schema does not
declare — is dropped rather than reported, since there is nothing left of it but
its author's text.

**What is not disclosed is anything a value or a word can hide in.** A JSON
Schema is a place to put data: `const`, `enum`, `default` and `examples` carry
values outright, and `title`, `description`, `$comment` and `pattern` carry free
text whoever authored the schema chose. Every schema this tool reports is
therefore REBUILT from an allowlist of structural keywords rather than copied
with a few keywords deleted — at every depth, through `properties`, `items`,
`$defs`, and every combinator — so a keyword nobody anticipated is absent rather
than disclosed. A `required` name that no property declares is dropped too: that
is a string, not structure. Numeric bounds, string patterns, and the Common
Fabric schema extensions do not cross either.

The schema is also reduced to a bounded depth. Past a nesting depth no authored
schema reaches, a subschema reports as the empty shape `{}`, the same answer a
schema that refers to itself gets. A deep or cyclic schema therefore yields a
smaller shape, never a failed call: reduction has no failure mode for
`describe_handle` to propagate.

That reduction is what makes the fabric-side read safe to allow. The schema a
piece declares was authored by someone other than this run — quite possibly a
person — and prose, values, and definition names do not cross the line at all.

**Property names are the residual channel, accepted deliberately.** They are
author-chosen text, and after the reduction above they are the only such text in
the output. They cross because they have to: an agent handed a reference cannot
write a line of code over the data without the names of its fields, which is the
entire purpose of this tool. So the honest statement is not that no authored
text crosses, but that exactly one kind does — the kind that carries structure —
and that a reader of a reported schema should treat property names as coming
from whoever wrote the schema.

Being the one channel that crosses, they are also the one channel that is
bounded. At most 200 properties of a single object are named, a property name
longer than 128 characters is not named at all, and an object that omitted any
of its properties for either reason reports `additionalProperties: true` — so a
shortened list is never presented as the whole of them. A name past the limit is
omitted rather than shortened: a truncated name is the name of nothing, and code
written against it would read a field that does not exist. Both bounds sit far
above any schema a person writes; they are there so that an arbitrarily wide one
cannot fill a model's context with names, not as a boundary on what may be
disclosed.

The reply is also scrubbed of bare fabric identifiers, exactly as
`run_pattern`'s diagnostics are, and the scrub reaches property names at every
depth as well as the reply's own text. A property name is author-chosen, so a
document whose schema names a field with a DID or a bare tagged hash would
otherwise put that identifier into model context through the one channel that
crosses.

Disclosing shape is permissive and fixed rather than configurable: a run that
holds a token gets an answer for any address in the session's own space, and
there is no setting that says otherwise. The handle's own address is checked
against the session's space, and an address outside it is not read at all — the
session's authority ends at its space. That check is on the address, not on
everything reachable from it: reading the document's declared schema resolves
whatever links the document itself carries, and link resolution is not
space-bounded. What bounds it in practice is that the model chooses the handle
and never the path taken from it, and that whatever comes back is reduced to
structure before any of it crosses. An address the session can state no shape
for is reported as shapeless rather than as a failed call.

`describe_handle` is declared `effectClass: "read"` and reads no value, but
answering from the fabric establishes the run's fabric session — loading the
identity key and opening a remote connection. The first call in a run therefore
carries that cost and that effect.

Shape is also what makes a chain of steps checkable. An orchestrator that passes
a reference from one step to the next can confirm the reference is the kind of
thing the next step expects — before it runs, and without reading the data
flowing through it.

#### Handles across a delegation

A child resolves the parent's tokens through its own boundary, against a table
the delegation seeds. When the parent delegates, the tokens written into the
`goal` and `context` are looked up in the parent's table, and each entry that
resolves is copied verbatim — same token, same reference — into a fresh table
salted with the child's run id. Nothing else crosses. A token the parent held
but did not write into the delegation is not in the child's table, so the child
cannot resolve it; it stays the inert text an unknown token always is. This is
the privilege boundary: what a subagent can reach by reference is exactly what
its delegation handed it, and the decomposition structure is therefore the
opacity structure.

Copying entries verbatim keeps a reference stable across the hierarchy. Minting
looks up by address, so a child minting a handle for a seeded address gets the
parent's token back, and the same address is the same token in both runs.

Returns come back the other way. The child's final text is resolved through the
child's table into canonical references, and the parent's ordinary outbound swap
mints those into parent tokens. A seeded address mints to the token the parent
already holds, so a token the child echoes round-trips unchanged. An address
only the child ever saw — a `run_pattern` result cell it created, say — becomes
a new entry in the parent's table and reaches the parent as a token the parent
can pass straight back into its own tools. The child's raw tokens never appear
in parent-facing text.

Whatever still looks like a token after that resolution is scrubbed to fixed
inert text, irreversibly. The two tables share a token grammar but not a salt,
and the parent's table is the larger one, so token-shaped text a child writes
for itself would otherwise cross the boundary untouched — the child's table
resolves nothing, and the parent's outbound pass swaps addresses rather than
tokens — and then resolve in the PARENT's table, naming an entry the delegation
deliberately withheld. A token the child holds legitimately has already become
an address by that point, so the scrub costs nothing real.

A `default`- or `pattern-author`-profile subagent inherits the parent's fabric
session, so it can call `run_pattern` itself, under the same gate as the parent:
with no session configured the tool is absent from the child's surface rather
than present-but-failing. The `browser`, `web_fetch`, and `web_search` profiles
do not offer it.

#### Skill by handle

`acquire_skill` fills this path without exposing its payload to the chooser. It
takes an exact id returned by `search_skills`, resolves the source repository's
default branch to a full commit SHA, reads GitHub's recursive tree at that
commit, and derives the candidate root from exact path-segment equality with the
discovery slug. No case folding or path normalization participates. Zero or
multiple candidates refuse, and a tree response marked `truncated` refuses
because an unread inventory is not evidence of absence.

The instructions-only whitelist is scoped to the selected candidate root's
subtree, so sibling skills and repository files outside that root do not leak
into the payload decision. Within the subtree, exactly root `SKILL.md` is
admitted. Every other path — including a directory, script, reference, asset, or
package file — refuses the whole acquisition and is returned as sanitized, inert
refusal metadata. Nothing is silently stripped: prose referring to a missing
script would be a different and misleading skill. Only after this check does the
host require root `SKILL.md` to be a regular Git tree file, stream at most 256
KiB of pinned raw bytes, require non-empty UTF-8, and write them to a cell.

The successful write carries the weaker `kind: "fetch"` `ExternalIngest`
provenance variant. It records the exact pinned raw URL, commit SHA, fetch time,
and the harness-computed SHA-256 of the fetched bytes. It has no channel or
audience claim, grants no permission, and declassifies nothing. A registry hash
is not a pin and never enters provenance. The tool returns the handle and this
inert acquisition metadata; loading the handle remains a separate
`delegate_task` decision.

`delegate_task` takes an optional `skillHandle`: a handle the parent holds,
naming a cell whose string value is skill text for the child. The text is
materialized on the trusted host side at child spawn. Acquired handles carry the
`skill-context` capability and only this exact slot can consume one:
`describe_handle`, browser value binding, ordinary tool-input resolution,
delegation goal/context seeding, and child-return resolution all refuse or keep
it opaque. The authorized resolution still requires table membership, a string
value, and the same Fabric space, with a structured refusal naming the reference
on any miss before any child exists. The text is injected into the child's
context as a `<skill_context source="handle:<token>">` block beside the
profile's registry preload. The parent never reads the text, and the child never
holds the handle. The return path is mediated too: every parent-facing return of
such a delegation has the exact injected payload (and its JSON-escaped spelling)
scrubbed to fixed inert text, so a child that echoes its instructions verbatim
cannot walk the payload into the parent transcript. The scrub is deliberately no
more than that — the child exists to act on the skill, so what it did because of
the text is its ordinary, policy-mediated output.

The tree the registry scans comes from `--skills-root`, or, when the run names
none and is running out of a labs checkout, from that checkout's own `skills/`
directory — the same resolution the documentation corpus makes, and for the same
reason: a run started with no skills flag is not a run whose `pattern-author`
children were meant to author patterns with no authoring guidance. A named tree
is held to the sandbox-path rules (it must exist and stay within the workspace
or a host mount, and it is addressed inside the sandbox by that resolution); the
checkout default is read on the host only, so `--allow-skill-script`, whose
scripts run in the sandbox, still asks for the flag. Either way the resolved
tree and where it came from are recorded in `run-state.json` under `skillsRoot`
and printed in operator output as a `skillsRoot:` line.

A handle-delivered skill bypasses the registry entirely: it is transient run
state from a cell, the untrusted-acquisition complement to the trusted operator
`--skills-root`, and for the delegated path it retires selection by name — the
name-squat surface — in favor of an unforgeable table entry. It carries no
directory, so it has no supporting-resource index and no scripts;
`run_skill_script`'s operator allowlist cannot name it, and the skill-context
preamble that keeps a skill from authorizing tools applies to it unchanged. The
child's activation record carries `source: "skill-handle"`, the token, and the
digest of the exact text injected, so the artifacts say which reference supplied
the skill and what it said.

#### Pattern references by search record

`delegate_task` also takes up to eight optional `patternRefs`, each containing a
`patternId` and an optional bounded parent note. The harness resolves an id only
from successful `search_patterns` results retained by that parent run and
restored from its persisted transcript on resume; it neither trusts
model-retyped metadata nor fetches the index during delegation. A known id gives
the child a neutral generated block with the record's kind, quality,
description, match evidence, import hint, argument shape, result shape, and the
note verbatim. An id absent from the parent's record is omitted from child
context and returned by name in `patternRefRefusals` with reason
`not-searched-by-parent`.

Cell handles passed as tokens, `skillHandle`, and `patternRefs` are sibling
channels of one conceptual kind: an id names hashed information stored
somewhere, attached metadata accompanies it, and trusted-side code resolves it.
They deliberately remain separate until experience supplies a concrete reason to
unify them.

### Querying the documentation corpus

`query_docs` takes one question and returns a short answer with the sections it
came from. It is on the parent surface and on the `pattern-author` child's,
which is where it matters: that child has no `delegate_task` and the subagent
manifest pins the depth at one, so an explore agent is a tool on its surface or
it is unreachable from the one context that needs it.

The corpus is Markdown split at headings into sections, read on the host from
the roots the run resolved and never through the sandbox mount. Configure them
with a repeatable `--docs-corpus-root <path>`. A run that names none and is
running out of a labs checkout defaults to that checkout's `docs/common`,
`docs/development`, and `skills`, so a console started with no documentation
configuration is not documentation-blind. Either way the resolved roots and
where they came from are recorded in `run-state.json` under `docsCorpus` and
printed in operator output as a `docsCorpus:` line; a run that resolved none
says so on that line, and `query_docs` is absent from its tool surface.

Every section the loader admits carries an integrity endorsement — a `Resource`
atom of class `CommonFabricHarnessOperatorProvisionedReference` whose subject is
the root it was read under, minted from the operator's own configuration and
never from the read bytes. Only an endorsed section is eligible for an answer,
so text written into the workspace by an earlier child is not corpus and cannot
reach one. Operator-provisioned documentation is trusted for confidentiality —
we mount it, and it carries no secret — and endorsed for integrity provenance,
which is what lets a reader of a run tell reference material apart from
workspace text rather than trusting the mount.

The answer is produced by the `explore` profile: a cheap model with no tools at
all, one turn, handed the selected sections and nothing else. It is one model
call rather than a child run, so no subagent is spawned and the depth-one
invariant is untouched; the call is recorded like every other, as a model
attempt in the run report and with its tokens in the run's descendant usage.
Which cheap model answers is the run's transport's to say — a transport serves
only its own models, and a name it does not serve is a refused request rather
than a fallback — so the gateway answers on `gemini-3.5-flash` and the Codex
Responses transport on `gpt-5.6-luna`. The model that answered is on the
artifact, in `exploreRecord.model`. A call that ended with no answer — the
provider refused it, or what came back was not a reply the tool could read — is
counted on the run, its children's included, and printed in operator output as a
`docsQueryFailures:` line: the model reads an ordinary tool error and carries
on, so without that count a documentation-blind run leaves no trace an operator
sees. What was sent — the model, the question, each section by path and heading
with the endorsement atoms it carries, and the two messages verbatim — is kept
on the tool-output artifact under the call's output id as `exploreRecord`, and
stripped before the answer reaches the caller.

A citation is a path and a heading. It carries no text and no handle, so
following one is a separate `read_file`. A citation naming a section the corpus
does not hold is dropped rather than returned.

Not built yet: the optional `fullTextRef`, a capability-scoped handle over the
retrieved text minted by the route `acquire_skill` uses, and any policy that
would declassify it.

### Running patterns against a Fabric space

This is the second half of [the model](#the-model-handles-and-patterns): the
agent sends a computation to the data rather than pulling the data into its own
context, and gets a handle to the result.

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
`--describe-capabilities` reports `runPattern` among its features. The `default`
and `pattern-author` profiles are offered the tool under the same gate and work
through the parent's session; the `browser`, `web_fetch`, and `web_search`
profiles never receive it.

`run_pattern` executes on the trusted host side — it never enters the docker
sandbox. The session (a `PiecesController` against the deployed API) is built
lazily on the tool's first invocation; construction verifies the configured
space's authorization, and only a healthy session is cached for the run. A
session that fails to build surfaces as an ordinary tool-output error rather
than a run failure, and the next tool call retries the construction.

Three further flags set the session runtime's CFC dials, and each needs the
three session flags present. `--fabric-cfc-enforcement-mode`
(`CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE`) accepts `enforce-explicit` or
`enforce-strict` — raise-only, since the session's runtime preset already pins
`enforce-explicit`; under `enforce-strict`, a pattern whose writes carry
confidentiality its target's declared policy does not admit has its commit
refused. `--fabric-cfc-flow-labels` (`CF_HARNESS_FABRIC_CFC_FLOW_LABELS`)
accepts `off`, `observe`, or `persist`; `persist` stamps the derived flow labels
onto everything a pattern's transaction writes, which is what makes a labeled
read visible to that refusal. `--fabric-cfc-posture`
(`CF_HARNESS_FABRIC_CFC_POSTURE`) accepts `max-enforcement` and opts the
session's runtime into the named CFC posture bundle
(`MAX_ENFORCEMENT_CFC_OPTIONS` in the runner's presets): every staged
enforcement dial on, the standard prompt-caveat policy loaded, and public-only
ceilings on the network-fetch sinks (the llm sinks carry no ceiling and are
ungoverned by the posture, pending a boundary-scoped admission mechanism). The
two per-dial flags still apply over the bundle, so
`--fabric-cfc-posture max-enforcement
--fabric-cfc-enforcement-mode enforce-strict`
is the full-strictness configuration. These dials govern the fabric session's
runtime only — `--cfc-enforcement-mode` remains the harness's own dial for tool
policy and the sandbox. The two are set independently up to one tie: under a
session raised to `enforce-strict`, a harness dial nobody set follows the
session rather than the harness default (recorded as source `fabric-session`),
and a harness dial stated weaker than the session refuses startup naming both
flags. Nothing else about the two families is derived; `--fabric-cfc-posture`
sets the flow-label dial, not the enforcement mode.

A run states both postures rather than leaving them to be inferred: the resolved
fabric-session posture — each dial's value and whether the operator configured
it, the named posture bundle supplied it, or the preset's default stood — is
recorded as `fabricSessionCfc` in `run-state.json` and the run report (with the
selected bundle, when there is one, as its `posture` field), and the operator
summary prints it beside the harness's own `cfcMode`.

The tool takes `sourceText` (inline pattern source, at most 256 KiB — an
over-cap source is a structured tool error), an optional `inputs` object, and an
optional `resultSchema`. An `inputs` string value that is a whole-string
LLM-friendly link (`/of:fid1:.../path`) is passed to the pattern as a live cell
reference; everything else passes through as plain JSON. A link that resolves
into a space other than the configured session space is refused with a
structured error before anything is created, and an input whose value does not
match the compiled pattern's argument schema for its key is refused the same way
— named after the offending key, with no piece persisted. What supplies the
value does not change that question: a live cell is measured by what it
currently holds, and a plain JSON value by itself. So is an input the pattern's
argument schema does not declare at all, listing the names the pattern does
declare: a misnamed input is the mismatch a shape check cannot see, since the
pattern then runs with that argument undefined and renders a complete page
holding no values. Only a pattern whose argument schema names its properties,
and does not admit further ones, is measured that way — an
`additionalProperties` that is `true`, or that is a schema describing what an
undeclared key may hold, admits undeclared inputs by name. What such an input's
value is measured against is whatever that `additionalProperties` states:
against the schema when it is one, since admitting a key says what the key may
hold rather than exempting it from being checked, and against nothing when it is
`true`, which declares the argument open and states no shape any value could
miss.

An input value carrying a sealed opaque link is refused before anything is
created too, at the top level or nested anywhere inside a plain-JSON value, and
the refusal names the path it was found at. The seal is the reserved
`opaque:<handle-id>` target string a `resultSchema` sanitization leaves at a
position it seals — optionally followed by `#` and a JSON pointer — and it is
refused wherever it appears: as the `@link` of an object, whatever else that
object carries alongside it, and as a bare string value a model lifted out of
that wrapper. A seal is a redaction rather than an address: it marks a position
an earlier result withheld, and it names nothing any reader resolves, so storing
one would leave a dead literal where the pattern declared a live reference. The
reference for that same data is the `cfh:a:` handle token, or the LLM-friendly
link it stands for, passed as the input's own whole string value — which is what
the refusal tells the model to do instead. The deployed piece is unregistered by
default — it never appears in the space's piece list — and always detached: no
origin is recorded, because model-authored source starts detached under the
piece source-lifecycle spec. Run→piece provenance is carried by the run's
persisted artifacts instead — run-state and the tool-output artifact record the
`pieceId`. When the run's abort signal fires after the piece exists — while the
tool is waiting for the pattern to settle — the tool stops the created piece and
returns a structured `cancelled` error; the signal is the only cancellation
source — there is no timeout.

Naming is a separate operation. `assign_slug` takes a handle token referring to
a piece — a `run_pattern` `resultRef`, or any granted or discovered piece
reference — and a `slug`, the named address the piece is reachable at, in the
same lowercase-hyphen form every fabric slug uses. It registers the piece in the
space's piece list through the default pattern and then points the slug at it,
the same two steps `cf piece new` performs. Keeping the two tools apart is
deliberate: whether a piece deserves a public name is a decision the caller can
make later, about any piece it can reference, and revise by naming a replacement
under a fresh slug — and the operation discloses nothing, since the slug is the
caller's own word and the address behind the token stays trusted-side. The token
must name a piece itself, in the run's own space: a position inside one, a
reference into another space, and a document with no pattern identity are each
refused with a structured error.

The slug is validated, then checked for availability, before anything is
written, so an unusable slug and a slug already naming another piece are both
structured errors that change nothing. The availability question fails closed: a
slug is free only on the outcomes that say nothing is there — no document, a
malformed one, one that is not a piece, one carrying no piece id. A slug that
resolves into a piece rather than to one names a collection, and is refused the
way a taken name is: it is an address a person opens. Any other failure refuses
the call saying the availability could not be established, because reporting a
storage error as a free name would write over whatever is there. That check is
what stops a caller from taking over a name a person already opens: assigning a
slug is a blind write, so without it a model naming `home` would repoint `home`
at whatever it referenced. It is a check and not a lock — resolution and
assignment are not atomic, so a slug that becomes taken in between is still
overwritten — and it closes the case that arises rather than a race against a
concurrent writer. A slug that already points at the very piece the token names
answers `ok` rather than a refusal: the request is already true. `assign_slug`
sets the address, not the title: what the piece list displays is the pattern's
own `NAME` result, so a pattern that wants a title sets `NAME` in its source.

Every `run_pattern` invocation persists a piece in the configured space, named
or not. A cancelled run stops its piece, but no piece is ever deleted, and each
piece's source-history revision is a storage-retention root the piece list does
not reveal. Naming changes only whether a piece is findable, never whether it is
retained: an unnamed piece is exactly as durable as a named one, and naming
makes a retained piece visible to the tooling that could otherwise not see it.
Tooling that enumerates a space's contents from the piece list must not assume
the list is exhaustive, and there is no garbage collection for these pieces yet.

A successful run returns `{ status: "ok", resultRef }` to the model, where
`resultRef` is the canonical LLM-friendly link to the piece's result cell, plus
the schema-sanitized `value` (with `linkedStringCount`) when `resultSchema` was
given. `resultSchema` is how a caller reads what the pattern computed: without
one there is no `value` at all, and with one the inert positions the schema
models — numbers, booleans, `enum` and `const` strings — come back as
themselves, while unconstrained strings and anything unmodeled are withheld as
text and come back as the ADDRESS of the withheld position — the result
reference plus the sealed path, which the outbound swap renders as a `cfh:a:`
token. A run_pattern result is fabric-backed by construction, so every position
the schema cannot release still names a place: `describe_handle` answers its
shape, and a later `run_pattern` wires it by reference, following whatever links
sit on the path. (`linkedStringCount` still counts the string positions withheld
as text.) A sealed `opaque:` link an author declared in the schema, or one
lifted out of another output, is not this run's to address and passes through —
and remains refused as an input. The result is measured as it arrived: the
framework's own result keys (`$NAME`, `$UI` and the other rendering variants)
are named to the sanitizer as reserved, so a schema describing only the computed
fields does not have to declare them and does not lose its numbers to the
whole-object seal an unmodeled key would otherwise cause. Reserved only excuses
a key from the unmodeled-key rules: one the schema does model — through a `$ref`
or a combinator branch as readily as at the top level — is measured against what
the schema says about it and kept, and one it does not model is dropped rather
than shown. The ordinary outbound swap turns `resultRef` (and any link strings
inside `value`) into `cfh:a:` tokens at the model boundary, and the ordinary
inbound swap resolves such a token passed back through `inputs`; the tool itself
carries no handle code. The persisted tool-output artifact keeps the raw
reference, the raw result value, and the `pieceId` — a bare fabric identifier
the handle boundary never swaps, so it stays out of the model-facing rendering.

What the answer's values may carry is measured against the ceiling a model's
context has, which admits nothing: a model's context is outside every space, so
no confidentiality clause names an audience it belongs to. The reference is not
measured, because it is not a disclosure. `resultRef` names the result without
carrying it, and an agent holding one can wire it into a later run, hand it to a
child, or publish it under a slug without ever reading it — the
[CFC integration profile](../../docs/specs/agent-harness/02-cfc-integration.md)
states this as AH-CFC-18. So a run that asks for no `resultSchema` gets
`resultRef` whatever labels its result carries, and the ceiling is consulted
only when a `resultSchema` asks for values. The measurement reads the result
through a transaction — the result document and every computed cell it links to
— and fits that transaction's consumed join to the ceiling. Under an enforcing
mode a clause outside it withholds `value`, and the answer is still
`{ status: "ok", resultRef }`: `valueError` states the refusal as an
instruction, and `policyRefusal` carries it as data — the gates and sinks that
refused, the offending atoms (a structured atom is counted rather than named,
since it can carry the principal that introduced it), the keys of this call's
own `inputs` whose values carried those atoms in, and whether dropping those
keys is the whole remedy (`complete`), narrows the flow (`partial`), or reaches
none of it (`none`). An input is attributed by the label-map entry the refused
read consumed, so a link addressing a labeled field of a document is named for
that entry whether the read landed on the field or on the document root. The
refusal's reason names labels and documents, so it stays in the artifact's
`rawCauseMessage` and out of the model-facing text. At `disabled` and `observe`
nothing withholds: the values go out, and the same measurement is recorded on
the artifact as `releaseObservation`, so an operator staging the ladder can size
what raising it would withhold. The measurement applies no exchange-rule
rewriting, so a clause a policy evaluation would have discharged is withheld
here.

Whichever way it went, the measurement is also a decision in the run's
`policy-trace.json`, in the same record every tool-policy decision is written
as: `cfc_release_allowed` where the ceiling admitted the values,
`cfc_release_observed` where a rung below enforcement measured a refusal it did
not act on, `cfc_release_withheld` where it did, and `cfc_commit_refused` for
the other boundary, a commit the runner refused. Each states its own outcome:
`allowed`, `warned`, `withheld`, and `denied` in that order, counted in the
trace's `decisionCounts` under those names. `withheld` is its own outcome
because the call ran and answered with the reference to the result whose values
were held back; `denied` names a call that did not run, which is what a refused
commit is. The decision carries a `release` record — the boundary, the sink and
ceiling the flow was fitted against, and the refusal with its attribution —
beside the reference to the tool output it decided about. It is appended AFTER
the allow-side decision for the same call, because that decision answers whether
the call may run and is recorded before it does; a boundary that refuses inside
the call cannot appear there at all. A call that asks for no values makes no
release decision, since nothing was measured. Nothing of this reaches the model:
the refusal already reaches it as `valueError` and `policyRefusal`, and the
trace is where an operator reads it.

A result that settles to nothing names its cause when one was observed: when the
settled result fails the declared `resultSchema` or holds no fields of its own
beyond the framework keys, the tool consults what the session's runtime reported
during that invocation's settle window. An action error attributed to the
created piece names the failing computation; a convergence-budget episode whose
deferred-action labels name this pattern's module identity names the other
observed shape, which a reactive cycle, a non-idempotent computation, and a
policy-refused commit all produce. The refusal reason itself has no channel of
its own, so the message names the shapes rather than claiming to know which one
happened, and the failing computation's own text is withheld from model context
— a computation over data the model cannot read may carry that data in what it
throws — while the run artifact keeps it. An empty result with no observed cause
still reports ok, since silence is not evidence of failure.

A successful `assign_slug` returns `{ slug }`, plus `url` when the harness can
compose one honestly. The URL is the session's API URL, the space, and the slug
— the address `cf piece new` prints — and it appears only when `--fabric-space`
names the space. A space configured as a `did:key` has no URL that is not built
from that DID, and a bare fabric identifier does not cross the model boundary,
so the output carries the slug alone rather than a fabricated link. Nothing in
that output is swapped for a handle token, because nothing in it is a fabric
reference: the slug is the model's own word and the URL is the operator's API
URL and space name. Its error `message`, which can carry a DID from an
authorization failure, is scrubbed for bare fabric identifiers like the other
free-text fields. Compiler diagnostics come back as
`{ status: "compile-error", message }` so the model can iterate on the source;
bare fabric identifiers a diagnostic can embed (compiler-generated `fid1:`
module roots, DIDs, `data:` URIs) are replaced with a `[fabric-id]` placeholder
in the model-facing message, while the persisted artifact keeps the raw text.

Only the newest such diagnostic is carried at full length. When a `run_pattern`
result arrives, every earlier failed `run_pattern` result in that loop's
transcript has its `message` replaced with a one-line summary naming the
attempt, the status, how many errors the diagnostic reports and what they say —
or the message's first line, where it reports no compiler error — and the tool
output holding the full text; the summary is marked with `messageCollapsed` and
the length it replaced. The newest failure is what the model writes its next
source against, and the ones before it are re-read on every remaining turn
without being acted on. Every other field of the result, a policy refusal among
them, is left as it stands, as is a diagnostic already shorter than its own
summary. The rewrite happens in the transcript itself, so the persisted
transcript records the context the model was given, and the tool-output
artifacts keep every diagnostic in full.

The source those attempts carried is collapsed on the same terms. A
`run_pattern` call arriving in the transcript replaces the `sourceText` of every
earlier `run_pattern` call with a marker naming the attempt, how long its source
ran, and the tool output holding it — the loop edits against the source it wrote
last, and the drafts before it are re-sent whole on every remaining turn. Each
call's source is written to `tool-outputs` under that call's own `outputId` as
it runs, so the marker names an artifact that exists; a call whose result
reported no `outputId`, one naming a `patternId` rather than source, and one
whose source is shorter than the marker are all left as they stand, along with
every other argument of a call that is collapsed.

What a tool result may weigh in model context is bounded per tool. A `bash` or
`run_skill_script` stream keeps 60,000 characters of head and 20,000 of tail; a
`read_file` result keeps 8,000 and 2,000, because a file is read for a passage
and the whole document would otherwise sit in context for every later turn.
Either way the omitted middle is replaced by a marker counting the characters
dropped and naming the tool output that holds the whole text, the result carries
the original length beside the truncated field, and the artifact is written
before the bound is applied.

Every persisted tool result also has an entry in `transcript-omissions.json`.
That sibling record names the transcript step, output id, omission rule, full
tool-output artifact path, and JSON pointer; it never copies the withheld
content. The rule vocabulary is `artifact-only`, `bare-fabric-identifier-scrub`,
`model-context-truncation`, `observation-denied`, and
`superseded-run-pattern-diagnostic-collapse`. The console joins those locations
to the full `tool-outputs/*.json` files only for retrospective display. CFC
denials remain fixed redaction markers and scrubbed bare Fabric identifiers
remain `[fabric-id]`, never their withheld values. This reader-side join does
not change `transcript.json`, provider requests, resume, or replay. Runs created
before the sibling record existed are labeled as unrecorded rather than
reconstructed by guesswork.

Superseded `run_pattern` source collapse is not a tool-result omission and is
therefore outside this record: it replaces an earlier assistant tool-call
argument. Its transcript marker says which run-pattern-source sidecar retains
the draft, and the Timeline labels the marker “source replaced by a later
attempt” rather than presenting it as the original input.

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

The browser profile is the only path to the `browser` tool. The tool drives the
host `agent-browser` CLI one structured action per call, while the parent still
receives only the normal sanitized subagent result. Together with the profile's
allowlisted host skill scripts below, it is the whole of the harness's host
execution surface. Browser/page output is treated as untrusted child-local data;
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

The `browser` tool's input is typed rather than shell-shaped, so anything
outside its action vocabulary is unrepresentable rather than denied: `open` for
HTTP(S) URLs, `snapshot`, `get title/url/text`, read-only `console` / `errors`
inspection, bounded `wait`, and ref-based `fill`, `type`, `select`, `check`,
`click`, and `press`. The harness attaches every action to the run's Browser
Access lease itself and refuses actions when the lease is absent, expired, or
malformed — the CDP endpoint never crosses the model boundary in either
direction, so the child can neither point the browser elsewhere nor learn the
host's topology, and a bare browser launch that would race the host's live
browser profile has no verb to arrive through.

The browser is where [the model](#the-model-handles-and-patterns) meets a
surface that genuinely needs a value: a form field has to receive text. So a
field that takes a value has a sibling that takes a handle: `valueHandle` for
`fill`, `type`, and `select`, and `urlHandle` for `open`. The handle is resolved
trusted-side at the moment of use, so the model composes the action while
holding only a reference and the value never enters the conversation. A
value-bearing field and its handle sibling are alternatives — set together, the
call is refused rather than one winning silently.

Two checks stand between a handle and a materialized value, and both refuse by
default. The reference must be one the run actually holds: the inbound swap
rewrites a handle token into an address before a tool sees it, so an expanded
token and an address the model composed are indistinguishable by then, and only
membership in the run's handle table tells them apart. And the destination must
be allowlisted: `--handle-value-origin` names the origins where a value may be
spent, the page's own origin is read immediately before a `fill`, `type`, or
`select`, and a `urlHandle` is checked against the origin it resolves to. A run
with no allowlist cannot materialize a handle at all.

That destination check is a policy control, not a race-free guarantee, and the
distinction matters. The origin is read and then the value is typed; a page that
navigates in between — a redirect, or another child driving the same leased
browser — is not caught. The allowlist is also per-run rather than per-handle,
so any allowlisted origin can receive any handle the run holds: allowing a mail
origin for a mail credential does not stop a banking credential going there too.
Binding permitted destinations to the handle itself, at mint time, is the shape
that closes both, and it is not what this does.

A materialized value can come back. The page holds what was typed into it, so a
later snapshot, a read of the filled field, or a skill script driving the same
browser will carry it into model context. Nothing here prevents that: what a
handle buys is that the model never held the value beforehand and could only
spend it at an operator-named origin, not that the value stays unseen
afterwards. Governing the read is the labels' job, and it is not yet wired.

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
and `edit_file` treat that artifact tree as reserved from model-facing file
tools.

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

The `pattern-author` profile is where Common Fabric pattern source gets written
and run. Its child receives `run_pattern` (under the ordinary fabric-session
gate), plus `read_file`, `bash`, and `read_skill_resource` for reading existing
patterns and documentation in the workspace, and `describe_handle` for the shape
of the references it was handed. It receives neither `write_file` nor
`edit_file`: pattern source goes inline into `run_pattern`'s `sourceText`, and
the deliverable is a result reference rather than a file. When the run has a
skill registry, the child preloads the `pattern-dev`, `pattern-schema`, and
`pattern-ui` skills from it. That preload is best-effort — a run whose skills
root does not carry them, or that resolved no skills root at all, still gets the
same child with the same tools, just without the preloaded guidance.

The child's job is author, run, and hand back a reference: a pattern it did not
run is not an answer, and source never crosses back in any form. Its guidance
says so as a refusal rather than a preference — a delegation that asks for
source, in text or in an encoding of text, is answered with the
`unsupported-request` failure code. What a parent does with the result is
`assign_slug` or a `run_pattern` input, neither of which needs source, and reuse
of the pattern itself travels through the index rather than through the parent:
a later searcher finds the atom by its hashtags and composes it by its import
specifier, with no source in anyone's context.

That is also why the guidance asks for atoms rather than applications. The child
is steered to author the smallest thing that does one job, run it, and build the
next piece against the reference that run produced — each atom published under
its own description and hashtags, because the atom is the reusable part and the
composition on top of it is usually specific to the task that asked for it. A
search hit is a component to wire, not a specification to rebuild: importing it
costs the import line, and rewriting it from its description publishes a second
pattern doing the same job under a different id.

The profile carries its own turn budget of 24, in place of the default subagent
cap of 8. Authoring is a write, compile-error, fix loop and each iteration costs
a turn; at the default the loop runs out before a non-trivial pattern compiles,
and a child that ran out of turns has nothing to return. A delegation may still
name its own `maxModelTurns`, bounded by the same maximum of 64 every profile
is.

The profile also carries a return contract, and it is the profile's rather than
a default: a `pattern-author` delegation that declares a `returnSchema` of its
own is refused, naming the field and the contract it must answer instead. A
narrow return channel is only as narrow as the widest schema anyone may declare
against it, and a caller-written schema can ask for a shape the profile's own
contract admits no field for. Every other profile leaves the schema to the
caller, which is the ordinary case; this one holds it, because the shape of what
it hands back is the point of the profile.

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "ok": { "type": "boolean", "const": true },
        "resultRef": { "type": "string" },
        "describes": { "type": "string" },
        "hashtags": {
          "type": "array",
          "items": { "type": "string" }
        }
      },
      "required": ["ok", "resultRef", "describes"],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "ok": { "type": "boolean", "const": false },
        "code": {
          "type": "string",
          "enum": [
            "compile-error",
            "turn-budget-exhausted",
            "schema-mismatch",
            "missing-input-shape",
            "unsupported-request",
            "other"
          ]
        },
        "detail": { "type": "string" }
      },
      "required": ["ok", "code"],
      "additionalProperties": false
    }
  ]
}
```

Success and failure are different shapes, not different prose. A child that
cannot produce a working pattern — the compile loop does not converge, the task
is impossible against the references it holds, its turns run out — returns the
failure branch, and a failure carries no `resultRef` at all. That is what stops
a failed delegation from being answered with some other step's reference: the
parent reads `ok`, and a reference exists only on the branch that produced one.

The failure branch says why in a fixed vocabulary rather than in prose. A `code`
is inert by construction — one of a closed set, carrying nothing read out of a
space — so it survives sanitization as itself and the parent learns why without
any declassification. The optional `detail` elaborates in free text and reaches
the parent as an opaque link, which is the right treatment: the code is the
actionable part, and the detail is for a reader entitled to open it. The
free-form `describes` string on the success branch travels the same way, as do
the `hashtags` beside it — which a run with no pattern index, publishing
nothing, omits; the discriminant, the `code`, and the minted `resultRef` token
are what the parent acts on.

The success branch is closed, and there is no field on it for source under any
name. That is the durable half of the fix: a channel a parent cannot ask source
through is one a parent stops wanting source through, and the encodings that
walk text past a sealing rule — code points, bytes, base64, a string split
across fields — have nowhere on the branch to land.

`ok: false` is heard as a failure whatever else about a child's return is
malformed. When a return says it failed but does not fit the declared schema,
the parent gets `structuredReturn.status: "child-reported-failure"` carrying
`failureCode`, not a schema complaint — a child that correctly reports failure
is never turned into a validation error. A `failureCode` is recorded on a
validating `ok: false` return too, so the code reaches the parent by the same
name either way.

The same discipline is what the parent-facing guidance asks of any delegation:
declare the return shape up front, say what the child should do when it cannot
succeed, and treat a returned reference as meaningful only together with the
contract it satisfied. `describe_handle` is how the parent checks that a
returned reference is the shape the next step needs.

```bash
deno task run -- \
  --workspace /path/to/workspace \
  --fabric-api-url https://toolshed.example/ \
  --fabric-identity ~/.cf/agent.pkcs8 \
  --fabric-space my-space \
  --skills-root labs/skills \
  --allow-subagent-profile pattern-author \
  --prompt "Answer the question about my space by delegating a pattern to a pattern-author child."
```

The division of labour is the point. Pattern syntax is expensive to learn from
the repository and cheap to preload, so a root agent that pays for it once per
question runs out of turns before it runs a pattern. The root stays an
orchestrator: it holds the addresses, decides what to compute, and delegates.
The child holds the pattern knowledge: it writes the source, owns the write,
compile-error, fix loop against `run_pattern`, and returns the result reference
plus a short inert description.

Neither side reads the data. The references a delegation hands the child are
addresses to wire into the pattern as `run_pattern` inputs, not values to fetch
and transcribe, and the child's return is a reference for the same reason. The
handle machinery makes that work in both directions: a token the parent writes
into the goal is seeded into the child's table and resolves inside the child's
own `run_pattern` call, and the result reference the child returns arrives at
the parent as a token the parent can pass straight into its next `run_pattern`.

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
  - `--skill` names a skill in the resolved tree, which is `--skills-root` or
    the checkout default; a run that resolves neither refuses the flag
  - skill preload is not supported with `--resume-run`
  - dynamic `load_skill` activation is still planned

## The CFC audit

`deno task cfc-audit` reads a run's artifacts and reports what they establish
about the CFC clauses the harness answers to. It reads only: no live runtime, no
space database, no network, and it writes nothing into an artifact tree.

```bash
cd packages/cf-harness
deno task cfc-audit .cf-harness-console/runs
deno task cfc-audit .cf-harness-console/runs/<runId> --json
deno task cfc-audit .cf-harness-console/runs --fail-on fail
deno task cfc-audit .cf-harness-console/runs --corpus --expect-refusals
deno task cfc-audit .cf-harness-console/runs \
  --expected-posture audit/profiles/max-enforcement.json \
  --toolshed-url https://toolshed.example
```

A run directory audits that run together with the `delegate_task` children
written beside it; an artifact root, or a directory of run directories, audits
every run under it.

The per-run checks are in
[audit/checks/structural.ts](audit/checks/structural.ts) (Group A: what a run
did) and [audit/checks/posture.ts](audit/checks/posture.ts) (Group C: what it
declared it was doing), one per clause family:

| Check   | Subject                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Clauses                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| AUD-1   | one enforcement mode, present in both the run state and the run report and agreeing across every decision record and invocation context                                                                                                                                                                                                                                                                                                                                              | AH-CFC-14                                  |
| AUD-2   | decision reason codes belong to the claimed mode, and its side effects carry invocation contexts. A run whose side effects all took paths that record none warns: the claim went untested                                                                                                                                                                                                                                                                                            | AH-CFC-14, AH-CFC-15                       |
| AUD-3   | every side effect joins to a policy decision, and the counts reconcile                                                                                                                                                                                                                                                                                                                                                                                                               | AH-CFC-9, AH-CFC-11, AH-TOOL-3             |
| AUD-4   | every denial was recorded as a policy event and reached the model only as a typed denial carrying no payload                                                                                                                                                                                                                                                                                                                                                                         | AH-CFC-6, AH-CFC-11                        |
| AUD-5   | the handle table is well formed, no token precedes its disclosure, no parent token crosses into a child untransferred                                                                                                                                                                                                                                                                                                                                                                | AH-CFC-12, AH-CFC-13, AH-CFC-18, AH-CFC-19 |
| AUD-6   | tool calls and tool results pair                                                                                                                                                                                                                                                                                                                                                                                                                                                     | AH-CFC-16, AH-LIFE-6                       |
| AUD-7   | a run with a dial at `observe` warns rather than passes, so its evidence is never read as enforcement. Disagreement about the mode is AUD-1's finding                                                                                                                                                                                                                                                                                                                                | AH-CFC-15, §6                              |
| AUD-8   | labeled observations the model read are accumulated as influence, and denied ones are not                                                                                                                                                                                                                                                                                                                                                                                            | AH-CFC-7, AH-CFC-8                         |
| AUD-9   | the artifacts that would explain why a result was exposed or denied are present; what each holds is not read here. An invocation context is required of a side effect that reached the substrate minting one, read as AUD-2 reads it; a run that recorded no context at all warns, its artifacts being unable to tell a host-side effect from lost evidence                                                                                                                          | AH-CFC-16                                  |
| AUD-13  | the run's recorded fabric-session dial tuple is a point the enforcement matrix admits: `enforce-strict` without persisted flow labels fails, and a dial that is sound anywhere but credits nothing at this flow setting warns                                                                                                                                                                                                                                                        | matrix §2, §3                              |
| AUD-14  | under a claimed enforcement posture, every sink releasing with no confidentiality ceiling is named with its recorded reason; a record publishing no deviation while a sink is ungated fails                                                                                                                                                                                                                                                                                          | AH-CFC-14, AH-CFC-15                       |
| AUD-15  | a run whose enforcement **mode** came from a default and landed weaker than the mode its session claims — a silent fallback from an enforcing mode                                                                                                                                                                                                                                                                                                                                   | AH-CFC-15                                  |
| AUD-15a | a run whose **flow-label dial** came from a default and landed weaker than the named posture bundle it claims asserts. Ours: no clause names the dial                                                                                                                                                                                                                                                                                                                                |                                            |
| AUD-20  | counts each model-boundary omission by its recorded rule and rejects duplicated or transcript-mismatched results, duplicated rules, and rules with no artifact location. Ours: AH-CFC-16 motivates retained evidence but does not require this accounting artifact                                                                                                                                                                                                                   |                                            |
| AUD-21  | **known defect (CT-2175).** a side effect that produced a result and was admitted by a decision that could not have consulted a label. The predicate is the `release` record, which only a boundary that measured a flow against a sink writes; every `cfc_*` reason code comes from the authority switch instead. A call that produced no result reached no boundary and is not counted, and a run where none did is `not-applicable` rather than `pass`. Ours: no clause states it |                                            |
| AUD-22  | **known defect (CT-2216).** a `direct-command` prompt-slot binding carrying no digest of the value, or a subject that is not a principal — a workspace path or a resume-run id occupying the field                                                                                                                                                                                                                                                                                   | AH-CFC-3                                   |
| AUD-23  | **known defect (CT-2217).** a delegation whose manifest binds tools, skills and a turn budget and no confidentiality ceiling, so nothing bounds what the child may observe through what it inherits. `warn`, which is the clause's own weight                                                                                                                                                                                                                                        | AH-CFC-12a                                 |

Five verdicts, and the distinctions between them are the point. `inconclusive`
is a check whose evidence was absent or unreadable — it is never `pass`, and
`--fail-on` treats it as failure unless told otherwise, so an audit over a tree
missing its artifacts cannot exit green. A path naming no run at all exits `2`
whatever the threshold: nothing was audited, so no threshold applies.
`not-applicable` is stronger: the evidence was there and said the check's
subject does not arise. `warn` is a run whose posture makes its own assurance
weaker than an enforcing run's.

### The deployment questions

Four flags ask something no single run's artifacts answer, and they are what
turns the Group D checks
([audit/checks/deployment.ts](audit/checks/deployment.ts)) on. Without one of
them the audit stays what it is above — a per-run reading of an artifact tree —
so an ordinary audit's exit code is not spent on a question nobody asked. A
Group D finding is stamped `(corpus)` rather than with a run id.

| Check  | Subject                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Turned on by                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| AUD-16 | how many release refusals the corpus recorded — a `policy-trace.json` decision carrying a `release` record, naming the gate (`sink-ceiling`, `writer-fit`) that refused — beside the count of releases the same boundary measured and admitted, and the counts of runs recording `not-attested` and `permissive-if-absent`. Zero warns, and fails when the corpus is declared adversarial                                                                                                                    | `--corpus`, `--expect-refusals` |
| AUD-17 | the posture a deployment publishes on `/api/meta`, against the expected-posture spec. A deployment publishing none fails: what it enforces is indistinguishable from the default. So does one publishing a `projected` record — a prediction where an attestation was asked for                                                                                                                                                                                                                              | `--toolshed-url`                |
| AUD-18 | whether every posture record in the corpus is the same one. A run carries no surface identity, so this reads uniformity across records, not a named comparison of two surfaces; the harness's console and CLI diverge by default, so a mixed corpus surfaces that. **Unexercised today:** every corpus it has been pointed at records no posture, so it has only ever returned `inconclusive`. It is kept because a posture record appearing is what it is waiting for, not because it has said anything yet | `--corpus`                      |

`--expected-posture` names a JSON profile stating what a posture record is
supposed to hold — dial rungs, which sinks must carry a ceiling, which may
release ungated, whether every ungated sink must be published as a deviation.
[audit/profiles/max-enforcement.json](audit/profiles/max-enforcement.json) is
the first. A profile asserts only the fields it carries, and one asserting
nothing is refused rather than passing: a spec that checks nothing is
indistinguishable, in every line the audit prints, from a deployment whose every
field held.

### The known-defect checks, and the register they make

AUD-1 through AUD-18 encode the specification's requirements where evidence
exists. They detect a regression and they surface an anomaly, and there is a
question they cannot answer: **is the system still broken in the ways we already
know about, and is that list getting shorter?**

Group E ([audit/checks/known-defects.ts](audit/checks/known-defects.ts)) is that
question. Each check is one defect we have found, written so it fails today for
a named reason with the issue tracking it, and passes the day the defect is
fixed. A finding from one of these is not news; its value is the day it stops
appearing.

That makes falsifiability in **both** directions the whole of their worth. A
check that only ever fails is a constant wearing a check's clothes: it reports
the same thing about a fixed system as about a broken one, so it can never say
the work landed. Every Group E check is therefore seeded twice in
[audit/test/seeded-violations.test.ts](audit/test/seeded-violations.test.ts) —
once with the defect, where it fails, and once with the shape a fix would
produce, where it passes — and the second seeding is the one that matters. The
same file's clean-fixture case names the exact set of findings a captured tree
still produces, so a Group A or Group C finding appearing there is a regression
rather than noise.

**Why a `cfc-audit` run over any real tree is red today, and why that is not
something broken.** These checks fail by design. The ledger that records a
failing check as already-known — the expected-failures list a nightly reconciles
its findings against — arrives with the nightly job that needs it, and no job in
CI runs `cfc-audit` yet. Until then the audit reports the defects and nothing
excuses them, which is the honest intermediate state: the checks exist and say
what they find, and a reader seeing three red Group E checks and no ledger is
looking at the register working rather than at a regression.

So that wiring is data entry rather than rediscovery, each Group E finding
carries what such an entry needs. `KNOWN_DEFECT_REGISTRATIONS` in the same file
holds, per check, the stable substring of the finding's message to match on, the
run shape in prose, the reason it is open, and the issue; the finding carries
that block, and its `runId` is what a run selector is written from.
[audit/test/known-defects.test.ts](audit/test/known-defects.test.ts) holds the
one property that makes them usable — that the detail really is a substring of
the message beside it, and carries no count that a busier run would change. An
entry copied from a finding whose detail was not in its message would match
nothing, be reported stale forever, and the fix would look like the gap closing.

One gap is deliberately **not** checked. H7 asks how an opaque handle is passed
without revealing payload bytes, and the half that is missing is resolution: six
sites mint a handle for a blocked observation and nothing reads a `handleId`. No
per-run artifact predicate separates a run whose model never needed a denied
value from a run that could not resolve one, so any check would pass on most
runs for the wrong reason. It is carried in the manifest with that stated
instead. A check that passes for the wrong reason is worse than an honest gap,
because it converts a known hole into a green line.

### Where we stand against `CfcAgentHarnessProfile`

[audit/conformance-manifest.ts](audit/conformance-manifest.ts) holds, per
§18.3.3 obligation, the obligation in the specification's words, our status, the
code the answer rests on, the checks covering it, and the issue. Every audit run
prints that position — the headline is that `@commonfabric/cf-harness` does not
satisfy the profile, with the counts — so our conformance position is what the
tool says rather than something buried in a document nobody re-reads.

**The manifest is itself audited.** Where an obligation names covering checks,
its status is held to their verdicts, and a disagreement fails the run whatever
the threshold. The rule runs both ways: an obligation recorded as answered whose
covering check is failing is the manifest overclaiming, and an obligation
recorded as unmet whose every covering check now passes is a gap that closed
while the manifest stood still. The second is the direction that keeps this from
rotting — a reconciliation that only caught overclaiming would let every entry
sit at `absent` forever, describing a system that had since been fixed.

An obligation no check covers is reported **unreconciled**, never as agreement.
Counting it as agreement would report the absence of a check as a check that
passed, which is the error `inconclusive` exists to prevent. Four of the nine
are in that state, and H3 is `mechanized` by the type system rather than by
anything an artifact tree can show.

The obligations are quoted from the CFC specification, which is another
repository, so a quote from it cannot carry what
[audit/citations.ts](audit/citations.ts) gives an in-tree clause: nothing here
re-reads that document and breaks when the words change. The pin is one constant
— repository, commit, section — so moving it is a single visible edit, and the
printed position marks it `external: not drift-guarded` so a reader can tell
which authority is guarded and which is pinned by reference. The trade-off taken
is that a CFC clause can be reworded without anything in this repository
noticing.

`docs/IMPLEMENTATION_PROFILE.md` points at the manifest and does not restate a
status. Two encodings of one truth is the disease this audit exists to document:
the copy nobody runs is the one that goes stale, and a check comparing two
copies passes on whatever wrong answer they agree on.

### What AUD-16 reads

A **release refusal** is a denial a label decided: the boundary records one as a
decision in `policy-trace.json` carrying a `release` record, naming the gate
that refused (`sink-ceiling` — an egress whose confidentiality ceiling the flow
exceeded; `writer-fit` — a write whose target does not admit what it carries),
the sink and ceiling it was fitted against, the offending atoms, and the input
keys that carried them in. That is the channel AUD-16 counts. The same boundary
records the releases it admitted, which is what tells a gate that passed from a
gate that never ran; AUD-16 reports those beside the refusals and counts neither
as the other.

The policy-decision reason codes ALONE are deliberately **not** that channel.
Every `cfc_observe_*`, `cfc_enforce_*` and `cfc_disabled` code comes from one
switch in `src/prompt-loop.ts` that turns on the tool descriptor's static
`effectClass` and on whether the invocation carries direct-command evidence —
authority, not a label — and the loop records its allow-side decision _before_
the tool runs. What tells a release decision apart is the `release` record on
it, which only a boundary that consulted a label writes. A check that counted
`cfc_`-prefixed codes on denials would report capability denials as release
refusals, including ones where the `cfc_` code present is the allow-side one
that passed.

A call the loop rejected for its arguments is not a denied call either: nothing
about policy refused it, so its decision is recorded with the outcome `invalid`
and the reason code `invalid_tool_call`, and AUD-4 does not ask it for a policy
event or a typed deny observation.

A release refusal is also not a denied CALL, and AUD-4 leaves it alone for that
reason: the call completed and answered with a reference to the result whose
values it withheld, so there is no denied call for the typed deny channel to
carry. Its decision records the outcome `withheld` for the same reason.

AUD-16 reports `inconclusive` where a run's policy decisions could not be read
from the trace, the run report, or the run state — missing, unparseable, or
parsed without the list, which is as unreadable as the other two and is not the
same fact as a run that decided nothing. An unreadable channel is not an empty
one.

### What a recorded posture is

A posture record carries its own `provenance`. `resolved` was read off a
constructed Runtime — an attestation. `projected` was computed from the options
a runtime will be built with, before it exists — a prediction. `inherited` is
the record of the run whose fabric session this run shares, and establishes what
that run's record establishes. A parent run records `projected`: its fabric
session's runtime is built lazily on the first `run_pattern` and may never be
built at all. A delegated child runs on the session its parent built, so it
records that parent's record as `inherited` — which is what gives AUD-13 and
AUD-14 something to read on the run where `run_pattern` actually runs. A host
that injects a session the harness knows nothing else about supplies no record,
and its run publishes none. So AUD-13, AUD-14 and AUD-15 over harness artifacts
report on what a run **declared it would be at**, and every one of their
messages says so. Only AUD-17, reading `/api/meta`, weighs an attestation.
Re-stamping the run state's record from the real runtime once one exists is what
would make the harness's records attestations too; until then the field is what
stops the audit reading one for the other.

The matrix itself is data: [audit/matrix.ts](audit/matrix.ts) holds the
conforming states and the ordering rules of
[`docs/specs/cfc-enforcement-matrix.md`](../../docs/specs/cfc-enforcement-matrix.md),
each rule carrying the clause it turns on.

Every check carries the clauses it rests on and an exact quote from each, both
printed with the finding and included in `--json`, **and how it rests on them**.
A citation is `required-by` when the clause states the requirement the check
enforces, and `extends` when the check serves the clause's purpose without the
clause stating it. A finding with no `required-by` citation renders as
`[our requirement, not the specification's]`, because citing a clause that does
not state the requirement lends specification authority to a check the
specification never asked for — the same divergence the citation table exists to
prevent, pointed inward.

Today AUD-1 through AUD-9, AUD-13, and AUD-15 rest on clauses that state what
they enforce, as do AUD-22 and AUD-23. AUD-14, AUD-15a, AUD-16 through AUD-21,
and AUD-24 are ours: no clause requires that an ungated sink be published as a
deviation, that a deployment answer on `/api/meta`, that a corpus hold one
posture, that the render ceiling be published, that model-boundary omissions
have their own accounting artifact, that the decision admitting a side effect be
one that could have consulted a label, or that a run snapshot the labels its
space carried. They are worth checking anyway, and the report says whose
requirement they are.

**AUD-24 is what AUD-9 used to overclaim.** AUD-9 cites AH-CFC-16 as
`required-by`, and that clause enumerates exactly six things to retain —
prompt-slot evidence, invocation-context references, mediation dispositions,
policy events, model-context influence state, and side-effect decisions. A
cell-labels snapshot is not among them, so demanding one under that citation was
one check answering to two authorities, which is the shape AUD-15 and AUD-15a
are already split along. AUD-9 now expresses the six and nothing else; AUD-24
carries the snapshot as `extends`, and a finding from it renders as ours.

[audit/citations.ts](audit/citations.ts) holds that table and
`audit/test/citation-drift.test.ts` reads every cited document and requires each
quote to still be in it, so a specification edit that invalidates a check breaks
the suite rather than leaving the check quietly wrong.

### The property suite

`test/cfc-properties/` produces the evidence the checks read, in both
directions, so the audit is exercised rather than merely present. Each property
runs a scripted adversarial episode against the real engine and prompt loop — no
live model, no network — writes artifacts into a fresh root, and then runs the
audit over its own artifacts and asserts the verdict. The checker is the
assertion library; a property that hand-rolled its own artifact assertions would
prove that the test can read JSON.

```bash
cd packages/cf-harness
deno test -A test/cfc-properties/

# What the nightly does: one root for the whole suite, then the corpus checks
# over it. AUD-16's refusal count and AUD-18's posture uniformity are questions
# about a population, which a single run cannot answer.
CF_HARNESS_PROPERTY_ARTIFACT_ROOT=/tmp/cfc-properties \
  deno test -A test/cfc-properties/
deno task cfc-audit /tmp/cfc-properties \
  --corpus --expect-refusals \
  --expected-posture audit/profiles/max-enforcement.json --fail-on warn
```

| Property             | What it establishes                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-deny-egress        | A pattern reading a `Confidential` input has its answer withheld by the answer sink's ceiling. The refusal is written twice — as `policyRefusal` on the tool output, which carries it to the model as data, and as a `release` decision in `policy-trace.json`, which is the channel AUD-16 counts — both naming `sink-ceiling`. No payload reaches any model-visible message                                                                                                     |
| P-allow              | The same pattern with that one input dropped releases its answer, and the audit fails only the two checks a permitted run is known to fail. The guard against a gate that refuses everything, and against the audit becoming an always-fails alarm                                                                                                                                                                                                                                |
| P-influence          | A mediated `bash` call whose `stdout` is observed under a confidentiality label accumulates as influence, and whose `stderr` is denied does not. AUD-8 reaches `pass`, which no run of the historic corpus ever gave it                                                                                                                                                                                                                                                           |
| P-prompt-authority   | A side effect is allowed under a `direct-command` prompt slot and refused under `context`, under `quote`, and under no binding at all, each with `cfc_enforce_explicit_requires_direct_command`                                                                                                                                                                                                                                                                                   |
| P-no-silent-fallback | An enforcing run whose `bash` result carries no mediation returns the typed denial, keeps recording the mode it was asked for, and reaches for no reason code from another mode's family. AUD-2 and AUD-7 both reach `pass`, which is what leaves a quiet drop to observe behavior nowhere to land                                                                                                                                                                                |
| P-delegation         | A child resolves only the handle the delegation named, and the bound token is swapped for the bare reference in what the child dispatches — so at the address layer a handle is an indirection, not a boundary (AH-CFC-12 binds capabilities; §18.2.4.3 bounds observation). What bounds the observation is the output layer: the child's unmediated read returns as a typed denial. AUD-5 catches a child carrying a handle nobody transferred, and stays clean when it does not |

Two properties the brief for this suite named are established elsewhere, and a
second copy would be a second encoding rather than more coverage:

- **P-refuse-start** — `assertDockerRunscCfcTransportForMode` refuses to start
  an enforcing run whose CFC transports are unwired, and
  `test/docker-runsc-sandbox.test.ts` covers both enforcing modes, each
  transport missing on its own, and both present.
- **P-dial-order** and **P-posture-parity** — `audit/test/seeded-violations.ts`
  turns AUD-13 to `fail` and to `warn` on non-conforming matrix points, and
  `audit/test/deployment.test.ts` covers AUD-18. These are the stronger form for
  these two: a posture is a declaration, and a live episode can only produce
  postures the harness is willing to emit, so it cannot reach a non-conforming
  matrix point at all without the same seeded mutation.

One caveat on AUD-9 before its numbers are quoted anywhere. AH-CFC-16 enumerates
what a run must retain — prompt-slot evidence, invocation-context references,
mediation dispositions, policy events, model-context influence state, and
side-effect decisions — and a cell-labels read is not among them. The snapshot
is worth having and is the CT-2076/E3 bridge, but it is our requirement rather
than the specification's, so AUD-9 today carries two subjects under two
authorities: the same shape the citation discriminator exposed in AUD-15.
CT-2210 splits it, AUD-9 keeping the enumerated six as `required-by` and a
companion carrying the snapshot as `extends`.

The consequence is worth knowing in advance, because it moves a headline: **113
of the 239 historic runs that fail AUD-9 fail only on its cell-labels
component**, so they pass the spec-backed check once the split lands. The
retention gap against the specification is narrower than today's number
suggests. The history documents are not edited for this — they record the
checker as it stood, and a later run disagreeing with them is what they are for.

No check fails on a fresh permitted run. Two did when this suite was first
pointed at one — AUD-3 counted the `run-pattern-source` sidecar as an unrecorded
effect, and AUD-9 demanded an invocation context from a side effect that reaches
the fabric rather than the substrate that mints one — and both were the check
overclaiming rather than the harness underdelivering. Both are fixed.

What a permitted run still cannot settle, P-allow asserts as an exact set, so a
check that starts warning is caught rather than absorbed: AUD-2 and AUD-9 warn
because the run's one side effect reaches the fabric, so nothing exercised its
enforcing claim and nothing minted a context to retain; AUD-13, AUD-18 and
AUD-19 are inconclusive over a single run. The nightly's
`audit/expected-failures.json` names the same findings for the corpus, each with
the issue that closes it — and fails both on a finding no entry covers and on an
entry that stopped occurring, so the list shrinking is the progress signal
rather than a growing excuse.

### A consistency check cannot detect a consistent wrong answer

Two encodings of one policy drift, and the repair is to collapse them so that
one derivation feeds both the code that acts and the record that reports. That
repair has a cost which is easy to miss: it also removes the disagreement a test
was reading. Before the collapse, a wrong value in one encoding showed up as a
mismatch against the other; after it, the two move together, and a test that
only compares them passes on whatever answer they now agree on.

So a collapse converts a detectable bug into an undetectable one unless it is
paired with an anchor to something outside the system — a specification clause,
a quoted requirement, a fact the code cannot restate for itself. **Every
collapse of two encodings into one must ship with that anchor.** The
correspondence test proves the halves cannot disagree; the anchor is what stops
them agreeing on the wrong thing. Neither is sufficient alone, and of the two
the anchor is the one that catches a deliberate but mistaken edit.

The worked example is the absence policy. `enforce-explicit` published
`permissive-if-absent` while failing closed, because the model-facing output
path branched on the mode and the capability snapshot described the mode
separately. `cfcAbsenceBehaviorForMode` is now the single derivation both read.
Reverting the label after that collapse still passes the per-mode agreement test
in `test/cfc-absence-policy.test.ts` — descriptor and behavior move together
now, exactly as intended. What fails is the assertion anchored to AH-CFC-6,
which states that absence of metadata must not read as an unlabeled successful
observation. That clause is outside the code and cannot be moved by editing it,
which is the whole of why it works.

### Asserting the absence of failures asserts nothing on its own

The companion mistake, and the easier one to make, because it reads as
carefulness. A test that collects a check's findings, filters them for failures,
and asserts the list is empty passes for two different reasons: the check ran
and found nothing wrong, or the check never ran at all. A renamed id, a run
directory that held no run, a check dropped from the registry — each produces a
green test that has established nothing, and none of them looks different from
success.

It is the same defect the audit's own verdict vocabulary exists to prevent.
`inconclusive` is never `pass` precisely because a check that could not look at
anything has not found anything; a test that treats an empty result set as a
pass reintroduces at the assertion layer the confusion the verdicts removed at
the reporting layer.

So a property here reaches a check's findings through `checkThatRan` in
`test/cfc-properties/support/episode.ts`, which fails when a check reported
nothing over the artifacts it was given. Assert what a check said, not merely
that it said nothing bad — and where the whole verdict set is the subject,
assert the set rather than its emptiness, which is what P-allow does.

Both rules above are instances of one habit, and it is worth naming because this
work has now hit it three separate times: **a test that passes needs a reason,
and "nothing bad happened" is not one.** Each time the test was green and the
thing it named was not being checked — an agreement test comparing two halves
that had been collapsed into one, an empty-failure assertion over a check that
never ran, and a delegation property reading its witness out of the wrong
transcript. None of the three could have failed, and none of them looked any
different from a test that could.

What catches it is to ask, of a green test, what would have to break for this to
go red — and where the answer should be "the thing it is named after", to prove
it by breaking that thing once. Two of the three were found that way; the third
was found in review, by someone asking the question the author had not.

### Three things a check rests on, and each needs its own pin

A check is an expression of a rule about evidence, and three separate things
have to keep holding for it to go on meaning what it meant: **the words** of the
rule it enforces, **the location** the evidence it reads lives at, and **the
shape** of what it finds there. They move independently — a spec is reworded by
one team, a channel is relocated by another, a field's meaning changes under a
third — so a guard on one says nothing whatever about the other two. Each needs
pinning separately, and a check with only one of the three pinned is guarded
against one third of the ways it can quietly stop being true.

The failure mode is the same in all three cases and is the reason to care: the
check does not start failing. It goes on passing, against a document that no
longer says what it quotes, or a place nothing writes to any more, or a field
that no longer carries what it carried. A check that has silently stopped
testing anything is worse than an absent one, because the report it appears in
reads as coverage.

1. **The words — pinned.** Every citation carries the clause's text copied
   verbatim, and `audit/test/citation-drift.test.ts` reads each cited document
   back and requires the quote to still be in it. A rewording breaks the suite,
   which is the notice that the check resting on it needs rewriting too.

2. **The location — pinned.** A check names where it reads, and AUD-16 is the
   sharp case: it counts release refusals in `policy-trace.json` at
   `decisions[].release`. `P-deny-egress` asserts that AUD-16's evidence carries
   that artifact and that pointer, so a channel move breaks the property rather
   than passing quietly. That guard exists because the move happened: CT-2200
   relocated exactly this channel while the property suite was being written,
   and a check reading a relocated channel finds nothing there and reports
   nothing wrong — which is indistinguishable, in every line the audit prints,
   from a corpus that had nothing to report.

3. **The shape — not pinned.** A field can keep its name and its place and
   change what it carries, and no check would notice. AUD-16's own reading turns
   on `release` being written only by a boundary that consulted a label, and
   AUD-21's turns on the same fact; neither would fail if something else started
   writing that field, and both would go on reporting confidently about a
   distinction that had stopped existing. Nothing pins the meaning of any field
   the audit depends on.

   `audit/test/regenerate-fixtures.ts` is the closest thing to a pin and is not
   one: it builds the committed fixture from the real harness through the real
   artifact store, precisely so the tree cannot drift from what the harness
   persists — but regenerating is a manual act, so a shape that moves is noticed
   only when somebody happens to run it.

The third is stated here as a gap rather than described as covered, and
deliberately: an honest gap in a document is worth more than a rule nobody
implemented, and a reader deciding how much weight a green audit carries needs
to know which of the three pins is holding it up.

This is the same family as the two rules below — "a consistency check cannot
detect a consistent wrong answer" and "a test that passes needs a reason". All
three are about a check that has stopped testing its subject while still
reporting on it, and each names a different way that happens.

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

No continuous-integration job dispatches that task, and it is meant to stay that
way: `integration/engine.integration.test.ts` wants a Docker daemon carrying the
`runsc-cfc` gVisor runtime, and
`integration/pattern-index-live.integration.test.ts` wants a deployed pattern
index plus a keyfile that deployment authorizes. Neither is a runner's to hold.
Both files are type-checked by `deno task check` along with the rest of the
package, so they answer for the interfaces they use whether or not anyone runs
them; what they do not answer for is behavior, and a person running the task is
the only thing that asks them to.

The integration suite requires a working local Docker + `runsc-cfc` environment.
By default it also uses the published kitchen-sink image above, unless you
override `CF_HARNESS_INTEGRATION_IMAGE`.

Every case in `engine.integration.test.ts` is skipped unless
`CF_HARNESS_INTEGRATION=1` is set, which the task sets for you; the narrower
opt-ins below each add a further variable. The pattern-index cases take a
separate flag and are skipped even under that task:

```bash
cd packages/cf-harness
CF_PATTERN_INDEX_LIVE_E2E=1 \
CF_PATTERN_INDEX_LIVE_IDENTITY=/path/to/pattern-index.key \
deno task test:integration
```

`CF_PATTERN_INDEX_LIVE_URL` names the deployment and defaults to the standing
one. `CF_PATTERN_INDEX_LIVE_IDENTITY` has no default: which identity an index
admits is a fact about that deployment, so the run fails rather than guess at a
keyfile.

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
`cfcInputLabels`. Both env vars gate on being set, not on the installed Docker
`runsc-cfc` runtime being registered against the same directories; register it
with the matching `--cfc-invocation-context-dir` as well, or an enforcing case
refuses at `docker create` rather than exercising the labels it seeds.

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

Configuring `cfcInvocationContextDir` says where `cf-harness` writes; it says
nothing about whether the runtime reads there, and the two sidecar directories
are registered independently, so a host can have a working result transport —
sidecars arrive, output mediation succeeds — while every input label goes into a
directory nothing reads. Under an `enforce-*` mode `cf-harness` therefore reads
the runtime's registered arguments from `docker info` before starting a
container, and refuses the invocation when no valid absolute invocation-context
directory is registered, because that half fails open: nothing downstream
notices a sandbox that started untainted. `unregistered` is the only status that
states a fact about the world: no valid absolute directory is registered.
`registered` means only that something absolute is registered, never that the
transport works; the snapshot reports both paths without comparing them because
path text cannot establish that the daemon and harness resolve two names to the
same directory. Moby shell-parses the registered argument strings before runsc
sees them, so `cf-harness` trusts a registration only when every argument
consists of characters in `[A-Za-z0-9._/=:,-]`. Any other character produces the
distinct `unsafe-runtime-arguments` decline-to-affirm and refuses an enforcing
invocation; a legitimate directory containing an excluded character must be
renamed. A registration that could not be read at all is reported as
`indeterminate` and the run proceeds, so an unreachable Docker daemon cannot
pass for evidence of a misconfiguration. The CFC policy snapshot carries that
reading as `cfc.invocationContextTransportReadiness` — `registered`,
`unregistered`, `unsafe-runtime-arguments`, `indeterminate`, or `unverified`
before any enforcing invocation has probed.

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
- [Agent Harness specifications](../../docs/specs/agent-harness/README.md)
- `specs/cfc/18-runtime-implementation-profiles.md` in the sibling `specs` repo
