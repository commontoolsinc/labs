# @commonfabric/cf-harness

`cf-harness` is an in-house agent harness package for Common Fabric. It is being
built as a general Common Fabric agent runtime, with Loom as the first target
use case.

The package is intentionally early and experimental. It already has a real
execution core, a bounded prompt/tool loop, persistence, resumability, a thin
operator CLI, and the first pass of CFC-aware deny/recovery shaping.

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
- built-in tools:
  - `bash`
  - `read_file`
  - `write_file`
- whole-file replace/create plus append writes
- bounded OpenAI-compatible prompt/tool loop
- persisted run state, transcript, and tool outputs
- transcript-based resumability
- package-local operator CLI
- CFC mode plumbing with:
  - `disabled`
  - `observe`
  - `enforce-explicit`
  - `enforce-strict`
- first-pass policy events and deny/recovery behavior
- configurable gateway auth mode:
  - `bearer`
  - `none`

What is not done yet:

- real runner-driven CFC feedback integration
- richer opaque-handle/pass-through behavior
- subagents and parallel job orchestration
- app UI event provenance
- streaming model responses
- richer mid-turn resumability

## Package Layout

- [src/config.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/config.ts)
  - harness config, CFC mode resolution, gateway auth mode
- [src/engine.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/engine.ts)
  - core execution engine, run state, tool execution
- [src/prompt-loop.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/prompt-loop.ts)
  - bounded prompt/tool loop
- [src/cli.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/cli.ts)
  - package-local operator CLI
- [src/artifacts.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/artifacts.ts)
  - persisted run state, transcript, and tool output storage
- [src/contracts/](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/contracts)
  - prompt-slot, observation, policy, transcript, and tool-result contracts
- [integration/](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/integration)
  - environment-gated real `runsc-cfc` integration tests

## Commands

From
[packages/cf-harness](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness):

- `deno task help`
- `deno task run -- ...`
- `deno task test`
- `deno task test:integration`

## CLI Example

Standard bearer-auth mode:

```bash
cd /Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness
CF_HARNESS_API_KEY=... deno task run -- \
  --workspace /Users/gideonwald/coding/cf-pf-codex-1/labs \
  --prompt "Summarize the cf-harness package structure." \
  --print-transcript
```

No-auth gateway mode:

```bash
cd /Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness
deno task run -- \
  --workspace /Users/gideonwald/coding/cf-pf-codex-1/labs \
  --gateway-auth-mode none \
  --prompt "Summarize the cf-harness package structure." \
  --print-transcript
```

Current caveat:

- the stage gateway at
  [https://llm.stage.commontools.dev/](https://llm.stage.commontools.dev/)
  currently answers `GET /v1/models` but fails `POST /v1/chat/completions` even
  in no-auth mode; that is currently treated as a gateway-side issue rather than
  a `cf-harness` request-shape issue

## Testing

Unit/package tests:

```bash
cd /Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness
deno task test
```

Environment-gated integration tests:

```bash
cd /Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness
deno task test:integration
```

The integration suite requires a working local Docker + `runsc-cfc` environment.

## Related Docs

- [IMPLEMENTATION_PLAN.md](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/docs/IMPLEMENTATION_PLAN.md)
- [runner README](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/runner/README.md)
- [specs Chapter 18](/Users/gideonwald/coding/cf-pf-codex-1/specs/cfc/18-runtime-implementation-profiles.md)
