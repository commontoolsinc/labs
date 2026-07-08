# Historical documentation

This directory holds **historical** documentation: point-in-time records that
describe how things were, what was planned, or what was decided at a particular
moment. Everything here is **frozen**. It is kept for context and traceability,
not as a description of how the system works today.

For documentation that describes the current and intended state of the
repository — specs, concepts, guides, conventions, tutorials, and plans that
have not yet been carried out — see the rest of [`docs/`](../README.md). That
material is **live** and is kept up to date.

## The distinction

A document is **historical** when updating it would be wrong, because it records
a specific moment rather than a current truth. Examples:

- a plan or migration that has been carried out (the work is done)
- an audit, investigation, or findings report (a snapshot of what was true when
  it was written)
- a decision record (why a choice was made, at the time it was made)
- the design of a feature that has since been removed or replaced

A document is **live** when it should be updated as the system changes: a spec
that describes current or intended behaviour, an as-built reference that tracks
the shipped API, a concept guide, a tutorial, or a plan for work not yet done.

The test: **if the system changed, would someone edit this document, or write a
new one?** If they would edit it, it is live. If they would write a new one and
leave this untouched, it is historical.

## Rules for agents and humans

- **Do not edit historical documents to reflect new reality.** They describe the
  past on purpose. If reality has moved on, write a new live document; do not
  rewrite history. The only edits that belong here are fixing a broken link or
  adding a one-line pointer to a superseding document.
- **Every file here carries a header banner** immediately under its title, in
  this exact shape:

  ```
  > **Historical — not maintained.** Created: YYYY-MM-DD.
  > <one line on why it is historical>. See `docs/history/README.md` for what "historical" means here.
  ```

  `Created` is the date the document was authored (not the date it was archived).

- **When you create a historical artifact** — a report on a migration, a writeup
  of a plan that has been executed, an audit, an investigation's findings, a
  decision record — put it under `docs/history/` (mirroring where it would have
  lived) and add the banner above. Do not leave it in the live tree.

- **When a live document becomes historical** — a plan gets executed, a migration
  completes, a spec is superseded or its feature removed — move it here: add the
  banner, relocate it under `docs/history/`, and update any inbound links. See
  [`AGENTS.md`](../../AGENTS.md) for the full policy.

## Index

### Cross-cutting

- [cfc-spec-audit.md](cfc-spec-audit.md) — audit of the CFC spec versus the
  `packages/runner` implementation.

### Plans (executed)

- [plans/2026-03-17-ct-exec-fuse-callables.md](plans/2026-03-17-ct-exec-fuse-callables.md)
  — plan for `cf exec` and mounted callable files (shipped).
- [plans/2026-03-17-ct-exec-fuse-callables-test-plan.md](plans/2026-03-17-ct-exec-fuse-callables-test-plan.md)
  — test plan for the above.
- [plans/2026-07-02-convergence-evidence-appendix.md](plans/2026-07-02-convergence-evidence-appendix.md)
  — measurement evidence behind the convergence repro (PR #4457).

### Code-quality reports

- [future-tasks/code-quality-tasks/invalid-state-representations-report.md](future-tasks/code-quality-tasks/invalid-state-representations-report.md)
  — audit of invalid-state representations in interfaces.
- [future-tasks/code-quality-tasks/module-graph-import-issues-report.md](future-tasks/code-quality-tasks/module-graph-import-issues-report.md)
  — audit of module-graph import violations.

### Runtime / development

- [development/federation-pr5-design.md](development/federation-pr5-design.md)
  — earlier federation PR design; superseded by memory-v2 auth.
- [development/debugging/settle-wave-2026-03-findings.md](development/debugging/settle-wave-2026-03-findings.md)
  — findings from the March 2026 settle-wave investigation.

### Specs (executed plans, decision records, removed/superseded designs)

- [specs/action-id-per-instance-decision.md](specs/action-id-per-instance-decision.md)
  — decision record for per-instance action identity (shipped).
- [specs/compilation-cache.md](specs/compilation-cache.md) — the removed AMD
  compilation cache; kept for design context.
- [specs/content-addressed-action-identity-implementation-plan.md](specs/content-addressed-action-identity-implementation-plan.md)
  — executed plan for the identity migration (the live spec is
  [`docs/specs/content-addressed-action-identity.md`](../specs/content-addressed-action-identity.md)).
- [specs/memory-v2/cellset-lww-context.md](specs/memory-v2/cellset-lww-context.md)
  — working-context record for a merged fix (PR #4245).
- [specs/module-loading-implementation-plan.md](specs/module-loading-implementation-plan.md)
  — executed plan for ESM module loading (the live spec is
  [`docs/specs/module-loading.md`](../specs/module-loading.md)).
- [specs/module-loading-verifier-and-engine-design.md](specs/module-loading-verifier-and-engine-design.md)
  — design for the now-shipped ESM loader.
- [specs/pattern-construction/pattern-integration-tests.md](specs/pattern-construction/pattern-integration-tests.md)
  — design record; the shipped harness took a different approach.
- [specs/pattern-id-retirement.md](specs/pattern-id-retirement.md) — completed
  migration retiring the numeric pattern id.
- [specs/sandboxing/cross-origin-isolation.md](specs/sandboxing/cross-origin-isolation.md)
  — security decision record (deliberate non-isolation posture).
- [specs/sqlite-builtin/implementation-plan.md](specs/sqlite-builtin/implementation-plan.md)
  — as-built implementation plan (the live spec is
  [`docs/specs/sqlite-builtin/`](../specs/sqlite-builtin/README.md)).

### Package-local records

- [packages/patterns/PREEXISTING_BUGS.md](packages/patterns/PREEXISTING_BUGS.md)
  — bug inventory from the December 2025 pattern-library rationalization.
- [packages/patterns/record/design/EXTRACTION-IMPROVEMENTS.md](packages/patterns/record/design/EXTRACTION-IMPROVEMENTS.md)
  — completed AI-extraction module improvements.
- [packages/cf-harness/docs/LOOM_MIGRATION_NOTES.md](packages/cf-harness/docs/LOOM_MIGRATION_NOTES.md)
  — point-in-time capture of Loom/Codex integration understanding.
- [packages/ui/src/v2/MIGRATION_SUMMARY.md](packages/ui/src/v2/MIGRATION_SUMMARY.md)
  — completed Lit v2 component migration.
