# cf-harness Implementation Profile

Status: draft conformance statement\
Profile date: 2026-08-17

This document describes `@commonfabric/cf-harness` against the draft Common
Fabric
[Agent Harness specifications](https://github.com/commontoolsinc/specs/tree/main/agent-harness).
It is deliberately more conservative than the feature list: protocol presence
does not imply full conformance or external dependency health.

## Claimed classes

| Class         | Status                                                     | Evidence boundary                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core batch    | implemented; provisional conformance                       | Package unit tests cover configuration, lifecycle, tools, containment, artifacts, resume, and diagnostics. Real Docker/runtime behavior requires integration tests.                                    |
| Delegation    | implemented; experimental                                  | Unit tests cover profiles, fresh child context, retained child artifacts, and sanitized/structured return handling. Only serial single-child orchestration is supported.                               |
| Interactive   | implemented; experimental                                  | NDJSON v1 and SQLite-backed sessions/turns/events/replay are covered by package and Loom adapter tests. The protocol is not yet declared stable.                                                       |
| CFC transport | partial; reduced assurance in current product integrations | Prompt-slot, invocation-context, model-influence, mediation, and deny/recovery behavior are tested. Loom and Pattern Factory still select `observe` because trusted mediation is not wired end to end. |

## Capability discovery

The machine-readable probe is:

```bash
deno task run -- --describe-capabilities
```

It reports CLI fields, repeatable fields, parent and built-in tools, child
profiles, native model tools, and optional features. Adapters should use this
probe to handle vendor skew.

The probe does not health-check Docker, the selected Docker runtime, Browser
Access, a model gateway, or configured mount sources. This is a known deviation
from `AH-CAP-4` when a caller treats advertised capability as readiness. The
retirement condition is a caller-visible dependency preflight contract that
checks every dependency required by the selected run profile before the first
model turn.

## Trust and execution profile

- Model gateway: OpenAI-compatible. `gpt-*` turns use the Responses API, which
  accepts function tools together with reasoning; provider-native tools and
  non-OpenAI models use chat completions, which cannot serve that combination.
  Native model tools are declared separately in either case.
- Execution substrate: Docker; normally the sibling gVisor `runsc-cfc` runtime,
  with configurable image and runtime.
- CFC authority: Common Fabric runner/runtime evidence and trusted sandbox
  sidecars. Harness-local policy logic is conservative transport/enforcement,
  not the source of label meaning.
- Host execution: no parent-run shell reaches the host. Two bounded host-side
  surfaces exist beside the sandbox: the browser child profile's constrained
  command/script policy, bound to an explicit local CDP lease, and the
  `run_pattern` tool, which compiles model-authored pattern source and runs it
  against the configured Fabric space over a trusted host-side session. Neither
  admits arbitrary host commands, and `run_pattern` is present only when a
  fabric session is configured.
- Network: explicit in configuration but still provisional. Sandboxed `bash`
  applies a direct-`curl` destination guard; `web_fetch` and web child profiles
  have their own bounded request policies.
- Artifacts: retained under an explicit artifact root and reserved from normal
  workspace discovery when the roots overlap.

## Parent and child surfaces

Current selectable parent tools are `bash`, `read_file`, `view_image`,
`web_fetch`, `read_skill_resource`, `run_skill_script`, `edit_file`,
`write_file`, `delegate_task`, `describe_handle`, and `run_pattern`. Individual
runs receive only their configured subset; `web_fetch` and `run_skill_script`
are not in the ordinary default surface, and `run_pattern` additionally requires
the three `--fabric-*` session flags. `bash-no-sandbox` exists only as a
built-in used by authorized child profiles and cannot be selected as a parent
CLI tool.

Current child profiles are `default`, `browser`, `web_fetch`, `web_search`, and
`pattern-author`. Each profile supplies an exact tool/network/skill policy.
Parent skills and authority do not transfer implicitly.

## Lifecycle and evidence

Runs have stable identifiers and persist run-state, transcript, report,
capability, policy, tool, skill, and child evidence. Signal handling
terminalizes the active run. Product wrappers that create additional process
groups are responsible for forwarding cancellation and reaping the complete
owned group; Loom's batch wrapper implements and tests that integration
boundary.

Resume preserves recorded transcript/run configuration and rejects unsupported
new inputs such as image or skill changes. It is not a general recovery system
for an in-flight external side effect.

## CFC deviations and retirement conditions

1. **Product `observe` bridges.** Loom and Pattern Factory select `observe` for
   workflows whose sandbox output does not yet carry trusted mediation metadata
   end to end. Owners: the respective product adapters plus the cf-harness/CFC
   integration. Retirement: real sidecar evidence is present for every exposed
   observation and enforcing-mode adapter suites pass without opaque-output
   regressions.
2. **Provisional network policy.** Package-default bridge networking and the
   shell `curl` guard are integration mechanisms, not a complete destination
   capability system. Retirement: network authority is represented and enforced
   as an explicit profile across sandbox and dedicated web tools.
3. **Filesystem artifact references.** Operator reports may expose raw artifact
   paths. The session-local address handle table supplies deterministic per-run
   tokens for cell addresses, persisted in run state and carried across resume,
   and the prompt loop swaps model-bound tool output and model-authored tool
   arguments through it, but no release/readback step exists. Retirement:
   parent/model channels use opaque handles with an explicit release/readback
   step while operator tooling retains resolvable provenance.

## Test evidence

- `deno task test` — package contract suite.
- `deno task test:integration` — environment-gated real `runsc-cfc` paths.
- Loom `tests/harness/` and dispatch tests — capability skew, commands,
  cancellation, mounts, structured results, interactive translation, and run
  review.
- Pattern Factory launcher tests and phase smokes — phase ownership, validation,
  repair routing, skills, browser leases, and finalization.
