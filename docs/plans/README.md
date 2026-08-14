# Plans

Implementation plans that have not been fully executed. A pending plan is
live documentation: keep it accurate as the work proceeds (check off stages,
record scope changes).

When a plan has been executed or abandoned, it stops being a plan and becomes
a record: archive it to `docs/history/plans/` following the procedure in
[`../README.md`](../README.md).

## Current plans

- [`cf view` language and syntax coverage](cf-view-language-coverage.md)
  orders the remaining language, data, build, and configuration formats needed
  for honest coverage of the active organization repositories.
- [cf-harness Codex subscription authentication](cf-harness-codex-subscription-auth.md)
  tracks the remaining shipping gates after the core implementation.
- [CFC exchange-rule authoring](cfc-exchange-rule-authoring.md) tracks the
  remaining owner decisions and blocked stages for exchange rules.
- [CFC TypeScript authoring](cfc_typescript_authoring.md) sequences the
  TypeScript and JSX authoring surface for CFC metadata.
- [First-class serializable factories](first-class-serializable-factories.md)
  sequences the implementation of durable pattern, module, and handler
  factories.
- [Hosted pattern authoring](hosted-pattern-authoring.md) sequences the shared
  server operation and the piece menu, Home, and `cf` entry points for changing
  a piece or creating a space from a request.
- [Developer-tooling feedback for hosted authoring](hosted-pattern-authoring-tooling-feedback.md)
  adds a separate, non-blocking way for an authoring agent to report missing or
  defective development capabilities.
- [Ingest channels and the journal sink](ingest-channels-journal-sink.md)
  proposes a minted, bearer-authed inbound endpoint that accumulates what it
  receives as a provenance-marked, append-only log — the shared capability
  behind webhooks, beacons, and any source with no runtime of its own. It
  builds on the split-mint seam in
  [`../features/vouched-ingest-channel-mint.md`](../features/vouched-ingest-channel-mint.md).
- [Integration-test video demos](integration-test-video-demos.md) tracks
  optional CI adoption and further fixture hardening.
- [Lazy cell materialization](lazy-cell-materialization.md) sequences a
  schema-observing lazy view over a cell, a transaction mode that hands one back
  from every read, and the runner disposition for a reader that touches data the
  schema no longer describes.
- [Server-primary execution v2](server-execution-v2.md) sequences the
  greenfield rebuild that executes the server-side-execution v2 spec, with
  per-phase task and success-criteria checkboxes.
- [Retention and CFC execution provenance](retention-and-provenance.md)
  sequences how long an invocation record is kept and what the runtime knows
  about who caused it — the `AgentActor` mint, trusted ingress, and metadata
  confidentiality. Gated on a CFC review that has not happened.
- [CFC runner implementation](runner_cfc_implementation.md) defines the
  commit-boundary enforcement workstreams and rollout.
- [Topics migration rehearsal](topics-migration-rehearsal.md) is the concrete,
  unexecuted script for `setsrc`-ing the Estuary Topics board against a clone
  and then live.
- [`cf space clone` rehearsal](space-clone-rehearsal.md) records the design for
  rehearsal-grade copies of populated spaces. The tooling has shipped (`cf
  space`, `cf inspect churn`); the operating procedure lives in
  [`../development/space-clone-rehearsal.md`](../development/space-clone-rehearsal.md).
  The plan stays live until the practice has been exercised on a real
  migration.
- [Reading Fabric data](fabric-read-model.md) is the umbrella for one model
  across three concerns: everything addressable is a cell, so a verb's result
  and a direct read are the same operation on different cells. It carries the
  vocabulary and points at
  [shaped reads and verb results](shaped-reads-and-verb-results.md) — the shared
  read layer, how a shape says "an address here, a value there", and what
  calling a verb adds — and at
  [CLI surface shape](cli-surface-shape.md) for the command surface and an
  additive path to it. Start here rather than at either part.
- [References as arguments](references-as-arguments.md) proposes lifting
  address resolution out of the LLM dialog builtin, which already does it, and
  into the boundary every external caller crosses. An LLM can hand a pattern a
  reference; the CLI, a webhook, and the ingest path cannot reach the same
  handler the same way, and three encodings for "an address goes here" have
  already diverged. It carries the measurement, the size, and the gate-by-gate
  evidence that the refusal is drift rather than policy — the dispatch gate
  already accepts link values; the outer gates never got the option.
- [Designing verbs so they can change](verb-evolution.md) records how verbs are
  declared so that adding to and changing them later is possible: verbs are
  promises and their names are permanent, a holder declares only what it uses,
  an optional member's maybe is resolved once at binding, and an output change
  gets a new verb name. It states what the update gate enforces today, what
  the transformer and authoring tools should carry so a one-off author never
  has to learn a rule, and the open stream — named versioned interfaces,
  per-piece upgrade policy, migrations that run code — that everything else
  stands as the interim for. Written to be followable by anyone on the team,
  not only by pattern authors.
- [Verb calls: working notes](verb-result-selection.md) holds the call-specific
  investigation those documents do not carry: what produces a receipt and what
  its existence proves, how a receipt's address is derived, and the error and
  exit-status conventions. Sketches to draw from, not a settled contract.
- [Verbs — implementation plan](verbs-implementation.md) sequences the remaining
  work on verbs across both arcs that produced it: what a verb declares, what a
  caller may ask for, and what comes back. Read it for order; read the designs
  it points at for reasoning.
- [The CLI surface — implementation plan](cli-surface-implementation.md) builds
  the rest of the command surface: positional addresses, the honest top-level
  names, deprecating the spellings they replace, and merging the commands that
  do one job under two names. Separate from the read-layer plan because it
  renames rather than adds, so its risk is what breaks for a caller who already
  learned the current spelling.
