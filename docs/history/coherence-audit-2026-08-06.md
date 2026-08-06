---
status: historical
created: 2026-08-06
archived: 2026-08-06
reason: "Audit snapshot of callable verb results, receipts, and the Topics integration."
---

# Coherence audit: callable verb results and receipts

## Scope

The selected slice is result-bearing callable verbs: `Stream<E, R>`, transformer
and schema-generator output, invocation receipts, CLI retries, and the Topics
pattern's agent-facing verbs. It was selected from the preceding week of
first-parent changes on `origin/main` because it crossed the API, transformer,
runner, CLI, documentation, skills, examples, and a deployed end-user pattern.
The inspected main tip was `e81ab5b80`; the worktree was detached and clean.

## Ranked findings

### 1. How can retry idempotency be true if the handler body runs again?

The guide says a settled invocation replayed with the same id does not
re-execute. The CLI and runner implementation instead run the handler again and
rely on the receipt's create-only precondition to prevent a second transaction
from committing. That protects Fabric writes, but an external effect in the
handler body can happen twice.

Evidence:

- `docs/common/verbs-over-the-cli.md`, settlement and retry guidance.
- `packages/cli/commands/piece.ts`, callable invocation and receipt readback.
- `packages/runner/src/cell.ts`, handler execution and receipt commit.
- The targeted CLI callable/receipt suite passed 120 test steps; that proves the
  transaction outcome, not pre-execution deduplication of external effects.

Human question: Is the contract deliberately transaction-only idempotency, or
must a settled id be detected before the handler body runs?

Small improvement: state the boundary explicitly, add an external-effect
counterexample, and either recommend an outbox/effect discipline or add a
pre-run receipt check with a test that counts handler executions.

### 2. This seems inconsistent: result names are called permanent, but no result metadata is stored

An API test says a callable result's name is permanent and update-protected.
The schema-generator test demonstrates that a stream result type is absent from
the stored schema, and the user guide consequently describes results as
unvalidated and unprotected.

Evidence:

- `packages/api/test/stream-result-types.test.ts`, result-type compatibility
  wording.
- `packages/schema-generator/test/stream-result.test.ts`, stored-schema
  assertions.
- Targeted transformer return-validation tests passed 14 tests; targeted stream
  result-schema tests passed 4 steps.

Human question: Is schema-free result metadata an intentional interim contract,
or should result compatibility participate in pattern updates?

Small improvement: remove the false permanence claim now, or persist explicit
result metadata and enforce the compatibility rule end to end.

### 3. This was confusing: the Topics skill requires attribution that the callable contract does not enforce

The Topics skill requires `agentName`, while the source retains an optional
legacy shape and the generated callable schema is open-world. A local validation
experiment accepted a misspelled `agentNmae` (`{"typoAccepted":true}`), so an
agent can believe it supplied attribution while silently omitting it.

Evidence:

- `skills/topics/SKILL.md`, required mutation attribution.
- `packages/patterns/topics/main.tsx` and
  `packages/patterns/topics/topic.tsx`, agent-facing verbs.
- The checked callable baseline required only `title` and did not declare
  `additionalProperties: false`.
- `deno check` passed for both Topics pattern entry points.

Human question: When can the legacy permissive input be retired, and should
agent-authored mutations have a stricter boundary than UI actions?

Small improvement: introduce a strict agent-facing wrapper or verb, reject
unknown fields, and add the misspelling as a regression test.

### 4. This gap should be explained: the result-receipt rollout reads as both current and pending

The registry enables `plainResultReceipts` by default, but the verb guide and
Topics skill still say "until the default flips." The handler guide describes
exported handlers as necessarily `Stream<T>` and omits the settled Invocation
JSON shape.

Human question: Is the flag still a supported rollback surface, or has the
contract graduated?

Small improvement: update the registry, verb guide, handler guide, and Topics
skill together; add a documentation fact check for the default and public
invocation shape.

### 5. This seems inconsistent: one verb can serve UI and CLI, but Topics duplicates mutation paths

The HTML JSX surface accepts streams including result-bearing streams, and the
verb guidance says a single verb can serve UI and CLI. Topics nevertheless has
parallel profile-backed UI handlers and agent-attributed external verbs. Their
shared intent is not factored into one mutation kernel, so validation and
attribution can drift.

Evidence:

- `packages/html/src/jsx.d.ts`, event handler stream types.
- `packages/patterns/topics/main.tsx`, board UI and agent mutation paths.
- `packages/patterns/topics/topic.tsx`, Topic UI and agent mutation paths.

Human question: Is the duplication an intentional identity/trust boundary, or
only an implementation artifact?

Small improvement: document the boundary and share the mutation kernel, then
test parity between UI and headless paths.

## Verification record

- Transformer return validation: 14 tests passed.
- Stream result schema: 4 test steps passed.
- CLI callable and receipt suite: 120 test steps passed.
- `deno check` passed for Topics `main.tsx` and `topic.tsx`.
- The shell used Deno 2.8.3 while the untrusted repository `mise.toml` requests
  2.9.4; treat these checks as targeted evidence, not the complete CI gate.

## Conditional Linear proposals

These should become issues only after the corresponding human question is
answered:

1. Clarify and test transaction-only versus pre-execution invocation
   idempotency.
2. Remove the result-compatibility claim or implement durable result metadata.
3. Add a strict agent-authored Topics callable tier with unknown-field tests.
4. Consolidate Topics UI/headless mutation kernels while retaining the intended
   identity boundary.
5. Graduate result receipts in documentation and remove the rollout flag if it
   is no longer a rollback surface.

## Publication record

The audit was posted to the Estuary Topics board with transport identity
`/Users/ben/code/labs/claude.key`, content attribution `Ben (via Codex)`, and
stable invocation id `weekly-coherence-audit-2026-08-06`. The bounded create
reported `dispatched` and `committed` in 20.09 s; the mutation did not wait for
receipt/result readback. Its deterministic title is
`Weekly coherence audit — 2026-08-06`.

Canonical-fid verification did not complete. A filtered `crossrefs --step`
read spent 92.25 s in initial space synchronization, 9.18 s synchronizing the
board piece, and 26.96 s starting its runtime before it was stopped. The Topic
is durably committed, but the documented discovery path could not resolve it.
A diagnostic raw-link tail read then resolved the canonical fid without
running `crossrefs`; a final narrow durable read verified the 9,697-byte body
exactly. The Topic URL is
`https://estuary.saga-castor.ts.net/topics-dev-476ea34f/fid1:GvBM7LXMJJKrgPp4KVHbnnQXQ2UQUmE_89C49vc4J6s`.

## Proposed weekly Topics automation prompt

> Audit Common Fabric coherence once per week and publish the result as a Topic.
> Safely fetch `origin/main` without checkout, reset, source edits, or commits.
> Inspect first-parent changes from the preceding seven days. Choose one recently
> touched slice crossing multiple pace layers; do not boil the ocean.
>
> Use this source hierarchy: specs; tests and non-deprecated patterns; runtime;
> learning docs and skills. Never use history as the current contract. Examine
> the relevant API, transformer/schema generator, runtime, CLI,
> patterns/examples, UI, docs, and skills with read-only searches, transformed
> output, type checks, targeted tests, and small experiments.
>
> Persist the complete audit as a dated Markdown artifact before any remote
> mutation, so a Topics failure cannot lose the work. Produce a concise ranked
> audit containing the slice and why it was chosen;
> findings phrased as "this was confusing," "this seems inconsistent," "how can
> this be true," or "this gap should be explained"; exact file/symbol and command
> evidence; questions requiring human decisions; small improvements; and Linear
> suggestions only conditional on those answers.
>
> Publish with the Topics skill, a configured human `CF_IDENTITY`, and a stable
> `agentName`. Use the deterministic title `Weekly coherence audit — YYYY-MM-DD`.
> Survey that exact title. If absent, call `addTopic` with the full audit body and
> invocation id `weekly-coherence-audit-YYYY-MM-DD`; if present, resolve its fid
> and replace its body. Use phase reporting and a bounded wait. A failure in
> `initial_sync` is pre-dispatch; do not claim or repeatedly retry a mutation. If
> receipt/result readback is the expensive phase, the same stable id may use the
> documented commit-only (`--no-wait`) path, but only after a local disposable
> validation. Prefer the create result's link as the canonical fid when
> available. Verify durable title/body through a narrow input read. Attempt the
> canonical address through a filtered `crossrefs` read once, with a bound; do
> not make successful crossref recomputation a condition for preserving or
> reporting the audit, and do not treat a raw wrapper link as the Topic fid.
> Report the Topic URL, or the board URL plus exact phase timings and
> canonical-fid blocker.
