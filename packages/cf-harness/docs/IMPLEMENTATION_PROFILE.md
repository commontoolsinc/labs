# cf-harness Implementation Profile

Status: draft conformance statement\
Profile date: 2026-08-14\
Implementation revision: Labs `114f8af286d16203a0fa7356fa6f1da1af6d57d2`

This document describes `@commonfabric/cf-harness` against the draft Common
Fabric
[Agent Harness specifications](../../../docs/specs/agent-harness/README.md). It
is deliberately more conservative than the feature list: protocol presence does
not imply full conformance or external dependency health.

## Claimed classes

| Class         | Status                                                     | Evidence boundary                                                                                                                                                                                                                     |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core batch    | implemented; provisional conformance                       | Package unit tests cover configuration, lifecycle, context management, tools, handles, attachment integrity, artifacts, resume, and diagnostics. Real Docker, Fabric, and other external-runtime behavior requires integration tests. |
| Delegation    | implemented; experimental                                  | Unit tests cover profiles, fresh child context, retained child artifacts, and sanitized/structured return handling. Only serial single-child orchestration is supported.                                                              |
| Interactive   | implemented; experimental                                  | NDJSON v1 and SQLite-backed sessions/turns/events/replay are covered by package and Loom adapter tests. The protocol is not yet declared stable.                                                                                      |
| CFC transport | partial; reduced assurance in current product integrations | Prompt-slot, invocation-context, model-influence, mediation, and deny/recovery behavior are tested. Loom and Pattern Factory still select `observe` because trusted mediation is not wired end to end.                                |

## Capability discovery

The machine-readable probe is:

```bash
deno task run -- --describe-capabilities
```

It reports CLI fields, repeatable fields, parent and built-in tools, child
profiles, native model tools, and optional features. Adapters should use this
probe to handle vendor skew.

The probe does not health-check Docker, the selected Docker runtime, Browser
Access, a model gateway, configured mount sources, or the Fabric session used by
`run_pattern`. Callers must not treat advertised capability as dependency
readiness.

## Trust and execution profile

- Model gateway: either an OpenAI-compatible gateway or the authenticated OpenAI
  Codex subscription transport. Gateway `gpt-*` turns use the Responses API,
  which accepts function tools together with reasoning; provider-native tools
  and non-OpenAI models use chat completions, which cannot serve that
  combination. Native model tools are declared separately in either case.
- Provider and credentials: versioned private provider configuration and Codex
  credentials live beneath `CF_HARNESS_HOME`. Provider resolution is explicit; a
  broken Codex binding does not fall back to gateway billing or retention. The
  dedicated local Loom host uses the fixed credential owner `local`, a canonical
  home identity, and the persisted provider/authentication source.
- Execution substrate: Docker; normally the sibling gVisor `runsc-cfc` runtime,
  with configurable image and runtime.
- CFC authority: Common Fabric runner/runtime evidence and trusted sandbox
  sidecars. Harness-local policy logic is conservative transport/enforcement,
  not the source of label meaning.
- Host execution: general parent host command execution is unavailable. The
  conditionally advertised `run_pattern` parent tool is a separate trusted-host
  capability: it holds the Fabric identity outside Docker and uses a lazy,
  authorized session constrained to one configured space. The browser child
  exposes only a constrained host command/script policy bound to an explicit
  local CDP lease.
- Network: explicit in configuration but still provisional. Sandboxed `bash`
  applies a direct-`curl` destination guard; `web_fetch` and web child profiles
  have their own bounded request policies.
- Gateway attribution: OpenAI-compatible requests carry bounded `x-cf-harness-*`
  and `User-Agent` provenance fields. These contain operational origin labels,
  not prompts, tool content, secrets, or personal identifiers. The Codex
  subscription transport does not use these gateway headers.
- Artifacts and observations: artifacts are retained under an explicit root and
  reserved from normal workspace discovery when the roots overlap. Run-start
  image inputs are integrity-locked. In-run `view_image` observations use
  content-addressed snapshots when an artifact store is present, so regenerating
  the source file does not change an earlier observation.

## Parent and child surfaces

Current selectable parent tools are `bash`, `read_file`, `view_image`,
`web_fetch`, `read_skill_resource`, `run_skill_script`, `edit_file`,
`write_file`, `delegate_task`, and the conditional `run_pattern`. Individual
runs receive only their configured subset; `web_fetch` and `run_skill_script`
are not in the ordinary default surface. `run_pattern` is absent unless its API
URL, identity, and space are all configured. `bash-no-sandbox` exists only as a
built-in used by authorized child profiles and cannot be selected as a parent
CLI tool.

`run_pattern` accepts at most 256 KiB of inline source. It resolves whole-string
LLM-friendly link inputs to live cells only within the configured space and
checks their current values against the compiled argument schema before piece
creation. Success returns a result reference and an optional schema-sanitized
value to the model while retaining raw identifiers and values only in the
artifact. The shared Common Fabric CLI parser accepts the same LLM-friendly
reference grammar at piece-intake seams, including validated embedded paths for
commands that operate on paths.

Current child profiles are `default`, `browser`, `web_fetch`, and `web_search`.
Each profile supplies an exact tool/network/skill policy. Parent skills and
authority do not transfer implicitly. Sandboxed children inherit the parent's
working directory within their host-backed mounts; host-command children begin
at the engine workspace rather than inheriting a parent directory they cannot
resolve.

## Lifecycle and evidence

Runs have stable identifiers and persist run-state, transcript, report,
capability, policy, tool, skill, and child evidence. Signal handling
terminalizes the active run. Product wrappers that create additional process
groups are responsible for forwarding cancellation and reaping the complete
owned group; Loom's batch wrapper implements and tests that integration
boundary.

Gateway Responses turns support server-side context compaction. The default
threshold is 75% of the input budget derived from the model's context window and
maximum output; `--compact-threshold` overrides it and `0` disables compaction.
Lazy budget discovery is bounded by a text-bearing input-size guard. Compaction
items remain transcript evidence, replay starts at the newest compatible
boundary, and function-call/output pairs remain intact. Transient discovery,
compaction, and abort failures are not permanently cached. A child that
overrides its model does not inherit parent provider controls; explicit run-wide
compaction disablement is the exception.

The session-local address handle table maps positively identified cell addresses
to deterministic per-run `cfh:a:` tokens. Model-bound tool output and
model-authored tool arguments pass through the table before policy evaluation
and dispatch. Bare Fabric IDs are not converted, delegation arguments carry
tokens only as inert text, raw artifacts retain canonical references, and the
table is persisted across batch resume.

Resume preserves recorded transcript/run configuration and rejects unsupported
new inputs such as image or skill changes. The local Loom host additionally
requires an exact recorded provider, model, authentication source,
credential-owner, and canonical-home binding before provider traffic; legacy,
incomplete, inconsistent, or switched bindings fail closed. This fixed-owner
host is for local single-user Loom. A hosted multi-user adapter must inject an
owner-bound credential resolver. Resume is not a general recovery system for an
in-flight external side effect.

## Known deviations and retirement conditions

1. **Dependency readiness.** The capability probe does not establish health for
   Docker, `runsc-cfc`, Browser Access, mounts, gateways, or Fabric sessions.
   Owner: `cf-harness` and each product adapter. Retirement: the selected run
   profile has a caller-visible preflight that checks every required dependency
   before the first model turn.
2. **Product `observe` bridges.** Loom and Pattern Factory select `observe` for
   workflows whose sandbox output does not yet carry trusted mediation metadata
   end to end. Owners: the respective product adapters plus the cf-harness/CFC
   integration. Retirement: real sidecar evidence is present for every exposed
   observation and enforcing-mode adapter suites pass without opaque-output
   regressions.
3. **Provisional network policy.** Package-default bridge networking and the
   shell `curl` guard are integration mechanisms, not a complete destination
   capability system. Owner: `cf-harness`. Retirement: network authority is
   represented and enforced as an explicit profile across sandbox and dedicated
   web tools.
4. **Incomplete opaque-reference boundary.** Address handles cover cell
   addresses but not the reserved value-handle form. Denial-path messages are
   not swapped, interactive restore does not persist the table, and there is no
   cross-agent transfer, dereference, release, or garbage-collection contract.
   Raw operator reports may expose artifact paths and canonical references.
   Owner: `cf-harness`. Retirement: every model-facing path uses held opaque
   handles with explicit lifetime and release/readback semantics while operator
   tooling retains resolvable provenance.
5. **Durable trusted-host pattern execution.** Each `run_pattern` call creates
   an unlisted, detached Fabric piece whose source revision remains a retention
   root. Abort stops the piece, but there is no deadline, resource ceiling,
   deletion, garbage collection, or outbound CFC flow check over the compiled
   source. Owner: `cf-harness` and Fabric runtime tooling. Retirement: callers
   can bound, enumerate, retain, and delete tool-created resources, and trusted
   CFC evidence covers the external read/write path.

## Test evidence

- `deno task test` — package contract suite.
- `deno task test:integration` — environment-gated real `runsc-cfc` paths.
- Handle-table, prompt-loop-handle, image-attachment, compaction, provenance,
  provider/auth, `run_pattern`, and local-Loom-host suites — model boundary,
  observation integrity, context continuity, request attribution, external side
  effects, and exact resume binding.
- Loom `tests/harness/` and dispatch tests — capability skew, commands,
  cancellation, mounts, structured results, interactive translation, and run
  review.
- Pattern Factory launcher tests and phase smokes — phase ownership, validation,
  repair routing, skills, browser leases, and finalization.
