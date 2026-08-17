# cf-harness Current State

Status: current implementation reference\
Last verified: 2026-08-14

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
- one child at a time through `default`, `browser`, `web_fetch`, `web_search`,
  and `pattern-author` profiles;
- schema-validated, sanitized child returns with raw child evidence retained
  outside the ordinary parent return channel;
- image inputs and structured top-level batch results;
- explicit skill preload, indexed supporting-resource reads, and exact
  allowlisted Deno/Bash skill scripts;
- recoverable rejection of a malformed tool call: a name no tool answers to,
  arguments that are not a JSON object, or a `delegate_task` argument of the
  wrong shape comes back as a `cf-harness.invalid-tool-call` tool result naming
  the field and the shape expected of it — never the value it rejected — and the
  run carries on; the call is recorded as a denied policy decision, a `not-run`
  tool activity, and an `invalid_tool_call` failure record. Only what the model
  cannot correct — transport, engine invariants, artifact persistence,
  cancellation, the turn cap — ends the run;
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
  and dispatch, `delegate_task` arguments excepted;
- cross-agent handles: a delegation seeds the child's own table with a verbatim
  copy of every parent entry whose token the `goal` or `context` names, and
  nothing else, so a child resolves exactly the references the delegation handed
  it while the tokens stay identical across the hierarchy; a reference the child
  produces is resolved through the child's table and minted through the parent's
  boundary, reaching the parent as a parent-resolvable token, and any
  token-shaped text still standing after that resolution is scrubbed to fixed
  inert text so it cannot resolve later in the parent's own table;
- shape captured where it is free and read back by token: a handle entry may
  carry the schema of its referent — a `run_pattern` result reference records
  the compiled pattern's result schema, marked `schemaSource: "harness"` — while
  no mint takes a schema off the reference it is handed or reads a cell to fill
  one in, so an entry without one is one whose shape was never free to capture
  and is answered from the fabric instead;
- a `describe_handle` tool, available in any run that has handles: given a token
  it reports the shape of the referent and its path segments, never the value,
  and reports an unknown token as unknown rather than as an error. The shape is
  what the referent declares in the session's fabric when the run has one — a
  piece's document schema is the result schema of the pattern behind it, which
  is what an agent building over that piece needs — and otherwise the
  harness-derived schema the mint recorded. Whatever the source, the reported
  schema is rebuilt from an allowlist of structural keywords at every depth, so
  `const`, `enum`, `default`, `examples`, and free-text annotations never leave
  the tool. Property names do cross, since code cannot be written over data
  without them, so they are bounded in count and length and the model-facing
  reply is scrubbed of bare fabric identifiers at every depth, keys included.
  Disclosing shape is a policy-governed read whose current default is
  permissive, bounded to addresses in the session's own space; answering from
  the fabric establishes the run's fabric session despite the tool's `read`
  effect class;
- an opt-in `run_pattern` tool (`--fabric-api-url`, `--fabric-identity`, and
  `--fabric-space` configured together, or their `CF_HARNESS_FABRIC_*`
  environment fallbacks): compiles and runs an inline `sourceText` pattern
  (capped at 256 KiB) against a deployed Fabric space from the trusted host side
  over a lazy per-run session that caches only a healthy, authorized
  construction; passes whole-string LLM-friendly link inputs as live cells,
  refusing links into another space, inputs the compiled pattern declares no
  argument for, input values that carry a sealed opaque link anywhere within
  them, values that mismatch the compiled argument schema whether a live cell or
  plain JSON supplies them, and a `register` slug that is unusable or that
  already names a piece in the space, all before any piece exists; honors the
  run's abort signal by stopping the created piece and returning a structured
  `cancelled` error; scrubs bare fabric identifiers from model-facing
  diagnostics; returns the result cell's canonical reference plus an optionally
  schema-sanitized value, and leaves the piece detached (no recorded origin)
  and, unless `register` asked for a named address, out of the space's
  registered piece list, with run→piece provenance carried by the run's
  persisted artifacts; without the session configuration the tool is absent from
  the tool surface, for a `default`- or `pattern-author`-profile subagent as
  much as for the parent — a child shares the one session the parent built;
- a `pattern-author` child profile that authors and runs Common Fabric pattern
  source: `run_pattern` under the same fabric-session gate, plus `read_file`,
  `bash`, and `read_skill_resource`, and no workspace writes, so its deliverable
  is a result reference rather than a file. It preloads whichever of
  `pattern-dev` and `pattern-schema` the run's skill registry carries — a run
  without them still gets the same child, without the guidance — and it is told
  that the references its delegation hands it are addresses to wire in as
  pattern inputs, that it owns the write/compile-error/fix loop, and that it
  returns the result reference plus an inert description rather than data. This
  is the division of labour a data question wants: the root orchestrates and
  never pays for pattern syntax or reads the data, and the child computes over
  references it cannot read out. It runs on its own turn budget of 24 rather
  than the default subagent cap of 8, since each compile-error iteration costs a
  turn, and it carries a return contract — a discriminated union of
  `{ ok: true, resultRef, describes }` and `{ ok: false, code, detail? }` —
  applied to any `pattern-author` delegation that declares no `returnSchema` of
  its own, so a failure and a success are different shapes and only the success
  branch carries a reference. The failure `code` comes from a fixed inert
  vocabulary, so a parent learns why without declassifying anything, and any
  child return saying `ok: false` reaches the parent as a coded failure rather
  than as a schema complaint.

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
- Every `run_pattern` invocation persists an unlisted piece in the configured
  space. An aborted run stops its piece, but no piece is ever deleted, and each
  piece's source-history revision is a storage-retention root the piece list
  does not reveal. Tooling that enumerates a space's contents from the piece
  list must not assume the list is exhaustive; there is no garbage collection
  for these pieces yet.
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
