# cf-harness Current State

Status: current implementation reference\
Last verified: 2026-09-03

The [system map](system-map/README.md) moves in lockstep with this current-state
reference.

`cf-harness` is an experimental but product-integrated Common Fabric agent
runtime. Loom is its first product adapter and Pattern Factory is its first
multi-phase orchestration adapter.

## Architecture

The runtime has four main boundaries:

1. The caller supplies prompt-slot roles, model and gateway configuration,
   tools, child profiles, mounts, resource bounds, skills, policy mode, and
   optional structured-result schemas.
2. The prompt loop performs bounded turns through the selected model provider
   and invokes only the configured tool/profile surface.
3. Most tool execution uses Docker with a configurable runtime, normally
   `runsc-cfc`. The browser child is a constrained host-adjacent profile whose
   typed `browser` tool the harness binds to a leased local CDP endpoint itself.
   The optional `run_pattern` tool is a distinct trusted-host path whose Fabric
   identity stays outside Docker and whose authority is constrained to one
   configured space.
4. The artifact store records run state, the model-facing transcript, a sibling
   record of the omission rules and full-artifact locations applied to each tool
   result, reports, capability and policy snapshots, tool outputs, child
   references, skills provenance, and optional product run manifests. The
   omission record carries no withheld values and is read only for retrospective
   display and audit accounting. The store also records the per-cell CFC labels
   the run's space holds for the cells the run touched — the one artifact a run
   does not write out of its own knowledge, read back from the space so a reader
   working from the tree alone can see what a cell is labelled.

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
  and `pattern-author` profiles, beside the internal `explore` profile that
  `query_docs` runs and no delegation may name;
- documentation a child can look something up in: `query_docs` takes one
  question, selects the matching sections of the operator-provisioned corpus on
  the host, and returns a bounded answer with inert path-and-heading citations.
  A run configures the corpus with a repeatable `--docs-corpus-root`, and a run
  out of a labs checkout that names none defaults to that checkout's
  `docs/common`, `docs/development`, and `skills`; the resolved roots and their
  source are recorded in run state and printed in operator output, and a run
  that resolves none does not offer the tool. Every admitted section carries a
  `Resource` integrity endorsement of class
  `CommonFabricHarnessOperatorProvisionedReference` naming the root it was read
  under, and only an endorsed section is eligible for an answer, so workspace
  text cannot reach one. The answer comes from one model call under a profile
  with no tools, recorded as a model attempt with its tokens in descendant
  usage, and what was sent is kept on the tool-output artifact and stripped
  before the caller sees it. That call carries no declaration ceiling and runs
  no boundary policy evaluation, so it sits outside the posture's caveat policy:
  the corpus is trusted for confidentiality, which is what makes a sink with no
  ceiling the right shape for it and also the whole of what holds it — the
  endorsement is an integrity claim and gates nothing on the way out. Which
  cheap model answers is resolved from the run's transport, since a transport
  serves only its own models, and a call that ended with no answer is counted on
  the run, its children's included, and printed in the operator summary;
- schema-validated, sanitized child returns with raw child evidence retained
  outside the ordinary parent return channel;
- image inputs and structured top-level batch results;
- a skills registry over `--skills-root`, defaulting for a run out of a labs
  checkout to that checkout's own `skills/` tree, with the resolved tree and its
  source recorded in run state and printed in operator output; skill preload by
  name, indexed supporting-resource reads, and exact allowlisted Deno/Bash skill
  scripts (which run in the sandbox, and so still ask for the flag);
- recoverable rejection of a malformed tool call: a name no tool answers to,
  arguments that are not a JSON object, or a `delegate_task` argument of the
  wrong shape comes back as a `cf-harness.invalid-tool-call` tool result naming
  the field and the shape expected of it — never the value it rejected — and the
  run carries on; the call is recorded as a policy decision with the outcome
  `invalid` rather than `denied` — nothing about policy refused it — plus a
  `not-run` tool activity and an `invalid_tool_call` failure record. Only what
  the model cannot correct — transport, engine invariants, artifact persistence,
  cancellation, the turn cap — ends the run;
- a release a confidentiality boundary refused is recorded as a policy decision
  with the outcome `withheld` rather than `denied`: the call ran and answered
  with the reference to the result whose values were held back, so the trace
  counts it in its own bucket, and the console renders the step as the success
  its answer states with a withheld marker beside the CFC line. `denied` names a
  call that did not run;
- transcript-based resume and durable run artifacts, with retrospective omission
  joins kept outside the transcript and provider context;
- server-side Responses context compaction with a default threshold derived from
  the model's input budget, an explicit override/disable control, retained
  compaction evidence, and tool-call/result-safe transcript pruning;
- per-turn and aggregate token/cache usage in run reports, operator output,
  batch metadata, and interactive turn-completion events;
- stable interactive prompt-cache affinity, configurable reasoning effort, and
  opt-in GPT-5.6 gateway cache controls; the ChatGPT/Codex subscription backend
  uses implicit caching because it rejects the API `prompt_cache_options` field;
- interactive NDJSON stdio sessions with optional SQLite session, turn, event,
  replay, cancellation, and restore state; a session's durable transcript
  advances only at a completed turn, so a failed, canceled, or interrupted turn
  retains the transcript from before it while its tool and event history stays
  on the audit trail; a completed turn's history is checked before it is
  promoted, and promotion commits with the completion or not at all; and a
  restored session whose recorded history does not pair its tool calls with tool
  results preserves that history and adds explicit unknown-outcome results for
  missing results, while orphan results and duplicate call IDs refuse the
  session locally rather than sending malformed history to a provider; and a
  listener that cannot take an event is reported to the host as a delivery
  failure and does not change the outcome of the turn that produced it;
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
- skill by handle: `delegate_task` takes an optional `skillHandle` naming a cell
  whose string value is skill text for the child, materialized trusted-side at
  child spawn under `resolveHandleValue`'s contract (table membership,
  string-only, same-space-only, structured refusal before any child exists) and
  injected as a `<skill_context source="handle:<token>">` block beside the
  profile preload; it bypasses the registry — no resource index, no scripts,
  name-based selection retired for the delegated path — and the child's
  activation records `source: "skill-handle"` with the token and the digest of
  the injected text;
- pattern references by search record: `delegate_task` takes up to eight
  optional `{ patternId, note? }` entries and resolves each id only from
  successful `search_patterns` results retained by that parent run and restored
  from its persisted transcript on resume. A known id contributes a neutral
  child-context block containing the trusted record's kind, quality,
  description, match evidence, import hint, argument shape, result shape, and
  the parent note verbatim; an unknown id is omitted and named in
  `patternRefRefusals` as `not-searched-by-parent`. Delegation does not refetch
  the index;
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
  Disclosure is permissive and fixed rather than configurable — no setting
  narrows it — and is bounded to addresses in the session's own space; that
  bound is on the handle's own address rather than on everything the document
  reaches from it. Answering from the fabric establishes the run's fabric
  session despite the tool's `read` effect class;
- bounded request-attribution headers on OpenAI-compatible gateway traffic,
  using persisted operational provenance rather than request content or personal
  identifiers;
- content-addressed snapshots for in-run `view_image` observations, while
  run-start images remain source-integrity-locked;
- opt-in fabric-session tools — `run_pattern` and `assign_slug`
  (`--fabric-api-url`, `--fabric-identity`, and `--fabric-space` configured
  together, or their `CF_HARNESS_FABRIC_*` environment fallbacks).
  `run_pattern`: compiles and runs an inline `sourceText` pattern (capped at 256
  KiB) against a deployed Fabric space from the trusted host side over a lazy
  per-run session that caches only a healthy, authorized construction; passes
  whole-string LLM-friendly link inputs as live cells, refusing links into
  another space, inputs the compiled pattern declares no argument for, input
  values that carry a sealed opaque link anywhere within them, and values that
  mismatch the compiled argument schema whether a live cell or plain JSON
  supplies them, all before any piece exists; honors the run's abort signal by
  stopping the created piece and returning a structured `cancelled` error;
  scrubs bare fabric identifiers from model-facing diagnostics; reports a result
  that settles to empty or schema-failing as an error when the invocation's
  settle window observed a cause — an action error attributed to the piece, or a
  convergence-budget episode whose deferred actions name this pattern — and
  otherwise still reports ok, since an empty result with no observed cause is
  not evidence of failure; returns the result cell's canonical reference plus an
  optionally schema-sanitized value, and leaves the piece detached (no recorded
  origin) and out of the space's registered piece list, with run→piece
  provenance carried by the run's persisted artifacts. `assign_slug` names a
  piece afterwards, from any handle token referring to one: it validates the
  slug, fails closed on an availability question the space cannot answer,
  refuses a slug already naming another piece (one already naming the same piece
  answers ok), refuses a token that names a position inside a piece, another
  space, or a document with no pattern identity, and otherwise registers the
  piece in the space's piece list and points the slug at it, returning the slug
  and, when composable without a bare fabric identifier, an openable URL.
  Without the session configuration both tools are absent from the tool surface,
  for a `default`- or `pattern-author`-profile subagent as much as for the
  parent — a child shares the one session the parent built;
  `--fabric-cfc-enforcement-mode` (raise-only: `enforce-explicit` or
  `enforce-strict`) and `--fabric-cfc-flow-labels` (`off`/`observe`/`persist`)
  set the session runtime's CFC dials, so with labels persisted a
  confidentiality-tainted pattern write is refused at commit under strict, and
  `--fabric-cfc-posture max-enforcement` opts the session runtime into the
  runner's named posture bundle (every staged enforcement dial on, the standard
  prompt-caveat policy loaded, public-only ceilings on the network-fetch sinks),
  with the two per-dial flags applying over it — these are the fabric session's
  dials, independent of the harness's own `--cfc-enforcement-mode` up to one tie
  — under a session raised to `enforce-strict` a harness dial nobody set follows
  the session, and one stated weaker refuses startup naming both flags — and the
  resolved posture (each dial's value and whether the operator, the named
  bundle, or the default supplied it) is recorded as `fabricSessionCfc` in run
  state and the run report, and printed in the operator summary — the whole
  posture record with it, which a delegated child carries from its parent
  stamped `inherited` because it runs on that parent's session; the session
  runtime can further run under a read ceiling —
  `--max-confidentiality
  <json>`, or `cfc.maxConfidentiality` (with
  `cfc.onExceed`) in the run manifest, met when both are given — that every
  `db.query` the run issues is bounded by, a query's own declaration met with it
  rather than replacing it, refused without a fabric session and recorded as
  `readMaxConfidentiality` in `fabricSessionCfc`;
- an opt-in pattern index (`--pattern-index-url`, or its
  `CF_HARNESS_PATTERN_INDEX_URL` environment fallback), which needs the fabric
  session configuration: index requests are signed with the session identity
  under the CF1 first-party scheme, and an indexed pattern runs in the session's
  space. It adds the `search_patterns` tool, which finds published patterns by
  hashtag or free text and reports each hit's kind, evidence quality,
  description, hashtags, usage signals, declared argument and result shapes, and
  the `cf:pattern:<patternId>` import specifier that composes it. Free-text
  search removes stopwords, matches whole words plus light suffix variants, and
  is disjunctive: one content term may return a hit, so extra terms can admit
  generic matches. `matchedTerms` and `queryTerms` count the stopword-free
  terms. It also extends `run_pattern`, which takes exactly one of `sourceText`
  and `patternId`: with a `patternId` the published program is fetched host-side
  and compiled down the same path, and neither its source nor a compile
  diagnostic quoting it reaches model context — the diagnostic is retained in
  the run artifact instead. The run reports `instantiated` and then
  `run_succeeded` or `run_failed` back to the index, best-effort, so a reporting
  failure never bears on the tool result. It adds the `record_feedback` tool,
  which votes a pattern up or down with an optional note, so the index learns
  which of the patterns it holds were worth offering. And it closes the loop the
  other way: source the model authored and ran successfully is recorded under
  the identity the compile recorded for it, carrying the `description` and
  `hashtags` the call named, the run's own task as the request the pattern
  answers, the compiled argument and result schemas, and the published patterns
  the source imports. Automatic publication records the entry without offering
  it to search; discoverability is earned from later evidence. Curated seeding
  may offer a passing run immediately by setting
  `CF_HARNESS_PATTERN_INDEX_PUBLISH_DISCOVERABLE=1`, while a render-gate failure
  remains recorded and non-discoverable with the gate's reason. Publication is
  best-effort in the same way — never awaited, never a failure of a run that
  worked — and a run that names no `description` publishes nothing, since its
  purpose could not be evaluated later. `--no-pattern-index-publish`, or
  `CF_HARNESS_PATTERN_INDEX_PUBLISH=0`, makes the run a reader and voter only.
  Without the index configuration `search_patterns` and `record_feedback` are
  absent from the tool surface, for a `pattern-author`-profile subagent as much
  as for the parent — a child searches through the one client the parent built —
  and `run_pattern` refuses a `patternId`;
- composition over that index: source the model authors may import a published
  pattern by the specifier a search reported,
  `import Sub from "cf:pattern:<patternId>"`, and `run_pattern` makes it
  compile. Before it compiles the source it was given, it reads the imported ids
  off it, fetches each one's program from the index host-side, and compiles it
  into the session's space, so the closure a `cf:pattern:` import resolves from
  is durable by the time the importer asks for it. Materialization recurses
  through what each fetched pattern imports and through the dependencies the
  index recorded for it, deepest first, and a pattern the space already holds is
  left alone. The same happens for a `patternId` the run names directly, so an
  indexed pattern that composes others runs. A composition is refused, with
  nothing of any fetched source in the message, if the run has no index, if the
  runtime has CFC enforcement disabled (an imported pattern resolves from the
  content-addressed source cache, which only an enforcing runtime writes and
  trusts), if the index holds no program for an imported id, if the recorded
  dependencies form a cycle, or if the graph draws in more than sixteen
  patterns. A composed pattern publishes like any other, carrying the ids it
  imports as its dependencies and stored under the identity its compile recorded
  — which is the identity the imported patterns are folded into, and not one the
  source alone determines;
- a `pattern-author` child profile that authors and runs Common Fabric pattern
  source: `run_pattern` under the same fabric-session gate, plus `read_file`,
  `bash`, and `read_skill_resource`, and no workspace writes, so its deliverable
  is a result reference rather than a file. It preloads whichever of
  `pattern-dev`, `pattern-schema`, and `pattern-ui` the run's skill registry
  carries — a run without them still gets the same child, without the guidance —
  and it is told that the references its delegation hands it are addresses to
  wire in as pattern inputs, that it owns the write/compile-error/fix loop, and
  that it returns the result reference plus an inert description rather than
  data. It is told to build in atoms — the smallest thing that does one job,
  run, then the next piece built against the reference that run produced — and
  to treat a `search_patterns` hit as a `cf:pattern:` import to wire rather than
  a specification to rebuild. It is also told to refuse source: a task asking
  for pattern source in any encoding is answered with the `unsupported-request`
  failure code, because reuse travels through the index rather than through the
  parent. This is the division of labour a data question wants: the root
  orchestrates and never pays for pattern syntax or reads the data, and the
  child computes over references it cannot read out. It runs on its own turn
  budget of 24 rather than the default subagent cap of 8, since each
  compile-error iteration costs a turn, and it carries a return contract — a
  discriminated union of `{ ok: true, resultRef, describes, hashtags? }` and
  `{ ok: false, code, detail? }` — which is the profile's own rather than a
  default: a `pattern-author` delegation that declares a `returnSchema` of its
  own is refused, naming the field, because a channel this narrow cannot be left
  caller-writable. A failure and a success are different shapes, and only the
  success branch carries a reference; there is no field on it for source under
  any name. The failure `code` comes from a fixed inert vocabulary, so a parent
  learns why without declassifying anything, and any child return saying
  `ok: false` reaches the parent as a coded failure rather than as a schema
  complaint.

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

Local batch and interactive entrypoints use a dedicated single-user host
binding. It resolves the persisted provider from a canonical `CF_HARNESS_HOME`,
binds Codex credentials to the fixed local owner, records the provider, model,
authentication source, owner, and home identity, and requires that exact
snapshot on resume before any provider traffic. Hosted multi-user integrations
must supply an owner-bound credential resolver rather than reuse this local
host.

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
- Every `run_pattern` invocation persists a piece in the configured space, and
  never registers it: the piece joins the space's registered piece list only
  when `assign_slug` names it. An aborted run stops its piece, but no piece is
  ever deleted, and each piece's source-history revision is a storage-retention
  root the piece list does not reveal. Tooling that enumerates a space's
  contents from the piece list must not assume the list is exhaustive; there is
  no garbage collection for these pieces yet.
- Model-driven dynamic skill activation is not implemented. Skills are
  explicitly preloaded by the caller; child skills are profile-controlled.
- Resume is transcript-oriented and does not recover an arbitrary partially
  executed tool or orchestration state machine. An interrupted turn is never
  replayed automatically: new turns retain their last provider-safe durable
  checkpoint, while restore and the next-turn boundary normalize legacy
  incomplete tool-call batches by adding an explicit unknown-outcome result for
  each missing result. This preserves legacy calls and later history without
  claiming or replaying an interrupted side effect. A tool result with no
  pending call or a duplicate call ID anywhere in the transcript fails closed
  before provider traffic because the harness cannot honestly invent or delete
  the missing history.
- Raw operator artifacts use filesystem paths. Parent-visible child returns are
  sanitized, and the prompt loop swaps model-bound tool output and
  model-authored tool arguments through the address handle table; denial-path
  tool messages are not swapped, and interactive restore does not persist the
  handle table.
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
