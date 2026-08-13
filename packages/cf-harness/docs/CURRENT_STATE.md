# cf-harness Current State

Status: current implementation reference\
Last verified: 2026-07-30

`cf-harness` is an experimental but product-integrated Common Fabric agent
runtime. Loom is its first product adapter and Pattern Factory is its first
multi-phase orchestration adapter.

## Architecture

The runtime has four main boundaries:

1. The caller supplies prompt-slot roles, model and gateway configuration,
   tools, child profiles, mounts, resource bounds, skills, policy mode, and
   optional structured-result schemas.
2. The prompt loop performs bounded OpenAI-compatible model turns and invokes
   only the configured tool/profile surface.
3. Tool execution uses Docker with a configurable runtime, normally `runsc-cfc`.
   The browser child is the exceptional host-adjacent profile and is constrained
   to a leased local CDP endpoint and a narrow command policy.
4. The artifact store records run state, transcript, reports, capability and
   policy snapshots, tool outputs, child references, skills provenance, and
   optional product run manifests.

The Common Fabric runner or another trusted mediator owns authoritative CFC
meaning. The harness transports prompt-slot and invocation evidence, applies the
selected exposure/side-effect policy, and records its decisions. It does not ask
the model to make policy decisions.

## Supported surfaces

The current package provides:

- batch CLI execution with bounded model turns and optional streamed events;
- machine-readable capability discovery with `--describe-capabilities`;
- persistent provider configuration and structured config/auth control, with
  durable bounded Codex refresh health;
- workspace, Fabric, and explicit host mounts with path containment;
- sandboxed shell, file, image, web-fetch, skills, edit/write, and delegation
  tools;
- one child at a time through `default`, `browser`, `web_fetch`, and
  `web_search` profiles;
- schema-validated, sanitized child returns with raw child evidence retained
  outside the ordinary parent return channel;
- image inputs and structured top-level batch results;
- explicit skill preload, indexed supporting-resource reads, and exact
  allowlisted Deno/Bash skill scripts;
- transcript-based resume and durable run artifacts;
- per-turn and aggregate token/cache usage in run reports, operator output,
  batch metadata, and interactive turn-completion events;
- stable interactive prompt-cache affinity, configurable reasoning effort, and
  opt-in GPT-5.6 gateway cache controls; the ChatGPT/Codex subscription backend
  uses implicit caching because it rejects the API `prompt_cache_options` field;
- interactive NDJSON stdio sessions with optional SQLite session, turn, event,
  replay, cancellation, and restore state;
- CFC modes `disabled`, `observe`, `enforce-explicit`, and `enforce-strict`,
  plus prompt-slot, invocation-context, policy-event, and model-influence
  evidence;
- a session-local address handle table: deterministic `cfh:a:` tokens minted per
  run for cell addresses, recorded in `run-state.json`, and carried across
  resume; the prompt loop swaps addresses to tokens in model-bound tool output
  and resolves tokens in model-authored tool arguments before policy evaluation
  and dispatch, `delegate_task` arguments excepted.

Run the capability probe instead of copying this list into adapters:

```bash
deno task run -- --describe-capabilities
```

## Product integrations

### Loom

Loom's batch adapter dynamically probes capabilities, constructs a run manifest,
creates a narrow temporary workspace, supplies explicit mounts and skills,
requests structured capture results, and retains reviewable run artifacts.
Autonomous wish dispatch currently routes through `cf-harness` when Loom's Page
authority prerequisites are considered available.

Loom also has an opt-in adapter for the interactive NDJSON protocol. It is not
the default interactive harness, and browser automation is not yet wired into
that interactive product path.

Loom currently forces autonomous `cf-harness` runs to `observe` mode while
trusted `runsc-cfc` observation metadata is not wired through every local tool
path. This is a product-integration deviation, not the package default.

### Pattern Factory

Pattern Factory runs each supported phase as a separate batch invocation. The
launcher owns phase ordering, validation, bounded critic/manual-test repair
passes, and finalization; `cf-harness` owns the phase-local model/tool loop and
evidence. All default Pattern Factory phase profiles currently use CFC `observe`
mode.

## Known limitations

- End-to-end runner-owned CFC mediation is incomplete in the current product
  integrations; enforcing modes therefore cannot yet replace their `observe`
  bridges.
- Capability discovery does not prove that Docker, `runsc-cfc`, a browser lease,
  or another external dependency is healthy. Callers must perform dependency
  preflight for workflows that require them.
- Package-default sandbox networking is a provisional bridge-oriented posture,
  not the final destination policy model. Product adapters may narrow it.
- Delegation is serial: only one child runs at a time.
- Model-driven dynamic skill activation is not implemented. Skills are
  explicitly preloaded by the caller; child skills are profile-controlled.
- Resume is transcript-oriented and does not recover an arbitrary partially
  executed tool or orchestration state machine.
- Raw operator artifacts use filesystem paths. Parent-visible child returns are
  sanitized, and the prompt loop swaps model-bound tool output and
  model-authored tool arguments through the address handle table; denial-path
  tool messages are not swapped.
- The session-local handle table covers cell addresses only. Value handles
  (`cfh:v:`) are reserved in the token grammar but not implemented, and there is
  no explicit dereference/release mechanism.
- `estimatedCostUsd` is available only for known GPT-5.6 gateway models when the
  response includes cache reads and writes. It uses public OpenAI pricing;
  gateway markup, subscription quota accounting, and provider invoices remain
  outside the harness. `estimateWithheldReason` distinguishes missing provider
  detail, unknown models, invalid counters, subscription pricing, and incomplete
  aggregate estimates. Aggregate dollar costs are omitted unless every included
  usage record reports one, so a partial cost is never presented as the whole
  run's.

## Verification

Package behavior is covered by the unit suite:

```bash
deno task test
```

Real sandbox/CFC paths are separately environment-gated:

```bash
deno task test:integration
```

Product adapters maintain their own contract and cancellation tests; package
tests alone are not evidence that Docker, Browser Access, or a live product
instance is healthy.
