---
name: spec-audit
description: Verify the CTS/schema documentation corpus against the implementation — claim-level drift detection for docs/specs/ts-transformer/, docs/specs/schema-generator/, package READMEs, and the author-facing layer. Run after major transformer/schema landings, before releases that lean on the specs, or quarterly. Produces a verified-findings report; does not edit docs itself.
---

# Spec audit: docs vs code for the CTS compiler surface

## Why this exists

The 2026-07 audit found the current-behavior spec denying a subsystem (CFC
`ifc.*` lowering) that had been implemented and fixture-pinned for ~3 months —
retained through a manual reconciliation pass. Drift accumulates silently and in
both directions: specs describing removed behavior, and code shipping behavior
the specs deny. The corpus is designed to be verifiable (enumerables cite
canonical constants); this skill is the verification.

## The map

- Corpus: `docs/specs/ts-transformer/` (see its README for per-doc status) and
  `docs/specs/schema-generator/`. Authority is per-document: normative docs
  (target-language spec, lowering contract) win over code; descriptive docs
  (current-behavior spec, mapping spec) lose to code/tests. Getting a finding's
  direction right matters more than finding it.
- Ground truth instruments, in order of strength: fixture corpus
  (`packages/ts-transformers/test/fixtures/**` input/expected pairs — what the
  pipeline actually emits), targeted tests, then source. To see live emission:
  `deno task cf check <file> --show-transformed --no-run`.
- Canonical constants the specs cite (spot-check the citations still resolve):
  `CFC_TRANSFORMER_STAGE_SPECS` (cf-pipeline.ts),
  `COMMONFABRIC_RUNTIME_EXPORT_REGISTRY` (+ its runner-factory guard test),
  `CrossStageState`, `getExpressionContainerKind`,
  `SES_SELF_CONTAINED_CALLBACK_BOUNDARIES`, wrapper vocabulary in
  `schema-generator/src/typescript/wrapper-names.ts`, the `JSONSchema` type in
  `packages/api/index.ts`. The mechanical subset is already pinned by
  `packages/ts-transformers/test/spec-sync.test.ts` — run it first; don't
  re-audit what it enforces.
- Cross-package contracts with no single home (historically the blind spot):
  transformer emission ↔ runner sandbox verifier (`@commonfabric/utils` sandbox
  contract); pattern-coverage ↔ runner line-offset/cache couplings
  (runner/harness/engine.ts); bare WeakMap boundary with schema-generator
  (cross-stage-state.ts header).

## Known drift patterns (seeds, not the boundary)

- Landing-gap: a feature ships, spec sections that deny it stay (grep the spec
  for "not implemented", "no …yet", "draft" and test each such claim).
- Enumeration drift: prose lists (diagnostic ids, registry entries, stages,
  fixture suites) vs their constants — including the inverse direction (ids in
  code the spec never mentions).
- Rename shadows: file/symbol references in older docs after renames; git touch
  dates lie (mechanical rename PRs refresh mtimes without verifying).
- PR-scoped artifacts aging in place; "Effective date"/status headers nobody
  updates.
- Author-layer contradictions: docs/common, tutorials, and skills teaching
  constructs the validators reject — verify against `validation.test.ts` and the
  target-language matrix, and check the critic skills especially (their errors
  get amplified by automation).

## Method

Fan out read-only verification (subagents work well; one per document or
surface), then adversarially re-verify anything that will headline the report: a
claim about code is checked in code, not in another document. Classify findings
CONFIRMED / STALE / WRONG / UNVERIFIABLE with file:line evidence, and state
which side of the authority split each finding falls on. Convergence from
independent passes raises confidence; a single agent's uncited assertion is a
lead, not a finding.

Report, don't fix: output is a findings report (precedent: `cfc-spec-audit.md`
at the repo root, and the 2026-07 CTS docs audit). Fixes are separate changes
the owner reviews — except that anything the spec-sync test could enforce should
become a new check in that test as part of the follow-up.
