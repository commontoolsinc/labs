# cf-harness Implementation Plan

This document is the checked-in package-local implementation plan for
`@commonfabric/cf-harness`. It is meant for engineers and agents who do not have
access to local session notes.

## Purpose

Build a Common Fabric-native agent harness that can support Loom and future
Common Fabric products without forcing CFC to be retrofitted onto an unrelated
runtime.

The key architectural principle is:

- `runner` owns authoritative CFC meaning
- `cf-harness` should not invent a second semantic layer
- the harness implements mechanisms that respect and transport those semantics
- sandbox layers enforce conservative low-level mediation where needed

## Product Direction

The current intended v1 shape is:

- general Common Fabric agent runtime, not just an internal coding harness
- shell-centric and mostly headless
- static trusted built-in tools
- long-running unattended tasks supported
- Loom as the first practical rollout target

## Design Principles

### 1. CFC-shaped from day one

The harness should not be built as a separate “normal” agent runtime first and
then later retrofitted for CFC. Instead:

- the interfaces should be CFC-shaped from the beginning
- enforcement can move from permissive/advisory toward blocking over time

### 2. Mechanistic harness

The harness itself should be deterministic:

- explicit mode handling
- explicit preflight heuristics
- explicit deny/recovery behavior
- explicit routing and boundary handling

The model consumes these signals; it does not create them.

### 3. Narrow tools first

The initial built-in tool floor is intentionally small:

- `bash`
- `read_file`
- `write_file`

That keeps the execution surface understandable while the core runtime shape is
still settling.

### 4. Sandbox-first execution path

The current execution path targets the practical `runsc-cfc` sandbox route. FUSE
and `fabricd`/space projection are intentionally out of scope for the first
core.

## Current Implementation Status

The package already includes:

### Stage A: Package skeleton and contracts

- package scaffold under
  [packages/cf-harness](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness)
- package exports and tasks in
  [deno.json](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/deno.json)
- initial contract surfaces:
  - [prompt-slot.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/contracts/prompt-slot.ts)
  - [observation.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/contracts/observation.ts)
  - [policy.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/contracts/policy.ts)
  - [transcript.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/contracts/transcript.ts)
  - [tool-result.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/contracts/tool-result.ts)

Why this was done first:

- to stabilize the internal runtime vocabulary before broader orchestration work

### Stage B: Execution core

- sandbox adapter in
  [src/sandbox](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/sandbox)
- engine in
  [engine.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/engine.ts)
- built-in tool implementations in
  [src/tools](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/tools)

Why:

- to get real shell/file execution working against `runsc-cfc` early
- to validate the VM/sandbox boundary before adding richer agent behavior

### Stage C: Prompt/tool loop

- bounded prompt loop in
  [prompt-loop.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/prompt-loop.ts)
- OpenAI-compatible client in
  [openai-client.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/gateway/openai-client.ts)

Why:

- to move from “tool runtime” into “actual harness”
- to expose message/tool-call/transcript requirements early

### Stage D: Persistence and resumability

- artifact store in
  [artifacts.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/artifacts.ts)
- run-state tracking in
  [run-state.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/run-state.ts)
- transcript-based resume support in the prompt loop and CLI

Why:

- to make runs inspectable
- to make debugging and iterative development feasible

### Stage E: Operator CLI

- package-local CLI in
  [cli.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/cli.ts)
- entrypoint in
  [main.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/main.ts)

Why:

- to make the harness manually operable before product integration

### Stage F: First CFC-aware shaping

- persisted `policyEvents`
- prompt-loop policy evaluation for:
  - `disabled`
  - `observe`
  - `enforce-explicit`
  - `enforce-strict`
- deny/recovery via JSON `ObservationDenied` tool messages
- CLI summaries of accumulated policy events

Why:

- to make the runtime meaningfully CFC-shaped before broader orchestration work

### Stage G: Gateway auth controls

- improved API-key diagnostics
- `gatewayAuthMode: bearer|none`
- caller-no-auth path for the stage gateway
- auth-mode-aware `401` messaging

Why:

- to support current Common Tools gateway expectations
- to make local operator debugging less ambiguous

## Current Verified State

At the current checkpoint, the package has:

- package-local verification green
- real `runsc-cfc` integration tests green
- a local commit checkpoint on `codex/cf-harness-skeleton`:
  - `9208ac17a` `Add cf-harness policy and gateway controls`

The stage gateway caveat is important:

- unauthenticated `GET /v1/models` works
- unauthenticated `POST /v1/chat/completions` currently fails
- current evidence points to a gateway-side issue on chat completions rather
  than a `cf-harness` request-shape bug

## What Comes Next

The next implementation step is not fully fixed yet. The main candidates are:

### Option 1: Debug/operator path without direct-command binding

Add a deliberate way to run the prompt loop without the default CLI
direct-command binding.

Why:

- easier manual testing of deny/recovery behavior
- helps exercise the current policy layer more directly

Tradeoff:

- useful for operator experiments, but not the most product-facing work

### Option 2: Runner-aware CFC feedback integration

Start consuming real `runner`-side CFC signals instead of relying only on local
harness heuristics.

Why:

- moves `cf-harness` closer to the intended architectural split
- reduces the risk of harness-local semantic drift

Tradeoff:

- more design-sensitive
- likely needs shared contract refinement across harness, `runner`, and the
  sandbox side

My current recommendation is Option 2 after the gateway situation is stable.
Option 1 is still a useful short-term debug affordance if the team wants it.

## Open Questions

These are the main unresolved questions that still matter:

### 1. How quickly should runner-aware CFC feedback be wired in?

Current deny/recovery behavior is harness-local and intentionally conservative.
That is useful, but it is not the final architecture.

### 2. Should `llm.stage.commontools.dev` become a special-case default?

Right now `gatewayAuthMode` defaults to `bearer`, with `none` as an explicit
opt-in. If the stage gateway remains caller-unauthenticated, we may want a more
ergonomic defaulting strategy.

### 3. Do we want a first-class `--api-key` flag?

At the moment the harness uses environment variables only:

- `CF_HARNESS_API_KEY`
- `OPENAI_API_KEY`

That is acceptable, but not the only plausible UX.

### 4. How much resumability do we want before product integration?

Current resumability is transcript-based and useful, but still limited:

- no rich partial tool-call recovery
- no richer orchestration state-machine resume

### 5. When do subagents start mattering?

The current package is intentionally single-loop and sequential. That is the
right choice so far, but it is not the end state.

## Suggested Reading Order

For a new engineer or agent:

1. [README.md](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/README.md)
2. [config.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/config.ts)
3. [engine.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/engine.ts)
4. [prompt-loop.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/prompt-loop.ts)
5. [cli.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/src/cli.ts)
6. [integration/engine.integration.test.ts](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/cf-harness/integration/engine.integration.test.ts)

For the broader architectural context:

- [runner README](/Users/gideonwald/coding/cf-pf-codex-1/labs/packages/runner/README.md)
- [specs Chapter 18](/Users/gideonwald/coding/cf-pf-codex-1/specs/cfc/18-runtime-implementation-profiles.md)
