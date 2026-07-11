# Historical documentation

This tree holds point-in-time records: audit reports, migration notes,
investigation findings, profiling reports, executed or abandoned plans, and
designs that shipped and were superseded by the code itself. Each document's
value is as a record of what happened, what was found, or what was decided at
a moment. The live counterpart — documentation that must track the current
system — lives everywhere else; the split is explained in
[`../README.md`](../README.md).

The test for which is which: if the system changed, would someone edit this
document, or write a new one and leave this one alone? Edit it — it is live.
Write a new one — it is historical.

This README is the one live document in the tree: it states the rules, must
be kept accurate as they evolve, and carries no metadata header.

## Rules

- **Do not update these documents.** Their content is frozen at the moment
  they were archived. The only permitted edits are mechanical: fixing a link
  that broke because a file moved, or correcting the metadata header.
- **Do not cite them as descriptions of the current system.** A historical
  document was accurate when written; the code has moved on. When
  investigating current behavior, treat anything here as background only.
- **Do not "refresh" a historical document to make it current.** If the
  topic needs current documentation, write a live document in the
  appropriate place and, if useful, add a `superseded-by` key to the
  historical document's header.
- Code blocks in this tree are not type-checked by `deno task check-docs`;
  they reflect the API of their era.

## Layout

A document archived from `<path>` lives at `docs/history/<path>`, with a
leading `docs/` dropped. Examples:

- `docs/specs/compilation-cache.md` → `specs/compilation-cache.md`
- `packages/cli/PLANNED_FIXES.md` → `packages/cli/PLANNED_FIXES.md`
- `tools/ralph/SOMETHING.md` → `tools/ralph/SOMETHING.md`

One more segment is dropped: when a document is absorbed from a local
`archive/` folder (the pre-history convention for keeping records next to
their live docs), the `archive/` segment is omitted, since this tree makes
those folders redundant.

New point-in-time artifacts (a report on work just completed, an audit, a
post-mortem) are created here directly, in the directory mirroring where
their subject lives.

## Metadata header

Every archived document in this tree starts with this header:

```text
---
status: historical
created: YYYY-MM-DD
archived: YYYY-MM-DD
reason: "<one line on why this document is historical>"
---
```

- `status: historical` — always exactly this.
- `created` — required; the date the document was originally written. Use
  the date stated in the document if it has one, otherwise the date of the
  git commit that first added it. A stated date that the git history
  contradicts (for example, a date months before the file first existed) is
  a typo in the document; use the git date and leave the frozen body as it
  is.
- `archived` — the date the document was moved here. For documents created
  here directly, the same as `created`.
- `reason` — required; one line saying why the document is a record rather
  than live documentation ("Executed plan; X shipped.", "Audit snapshot of
  Y.", "Superseded design; Z replaced it."). This is the line a reader uses
  to decide whether the document matters to them.
- `superseded-by: <repo-relative path>` — optional; points to the live
  document that replaced this one, if any exists.

If the document already has a frontmatter block (for example a MyST page),
add these keys at the top of that block instead of adding a second block.

## Index

One line per archived document; each document's header carries the fuller
`reason`. When you archive a document, add its line here.

### Audits and reports

- [cfc-spec-audit.md](cfc-spec-audit.md) — the CFC spec versus the
  packages/runner implementation, June 2026.
- [invalid-state-representations-report.md](future-tasks/code-quality-tasks/invalid-state-representations-report.md)
  and
  [module-graph-import-issues-report.md](future-tasks/code-quality-tasks/module-graph-import-issues-report.md)
  — code-quality audits, June 2025.
- [PREEXISTING_BUGS.md](packages/patterns/PREEXISTING_BUGS.md) — pattern
  runtime bug survey, December 2025.

### Executed plans and work orders

- [2026-03-17-ct-exec-fuse-callables.md](plans/2026-03-17-ct-exec-fuse-callables.md)
  and [its test plan](plans/2026-03-17-ct-exec-fuse-callables-test-plan.md) —
  `cf exec` and mounted callable files.
- [cfc-future-work-implementation.md](plans/cfc-future-work-implementation.md)
  — the CFC future-work epics (clause core, exchange rules/policy,
  observation classes, integrity floors, sqlite row-set, deployment flips),
  executed 2026-07.
- [STANDARD_DECORATORS_MIGRATION_PLAN.md](development/STANDARD_DECORATORS_MIGRATION_PLAN.md)
  — the cutover to standard decorators.
- [content-addressed-action-identity-implementation-plan.md](specs/content-addressed-action-identity-implementation-plan.md)
  — the action-identity migration.
- [module-loading-implementation-plan.md](specs/module-loading-implementation-plan.md)
  — the ESM module-record loader rollout.
- [pattern-id-retirement.md](specs/pattern-id-retirement.md) — retiring
  pattern ids (work orders W0–W4).
- [system-pattern-updates-implementation-plan.md](specs/pattern-imports/system-pattern-updates-implementation-plan.md)
  — system-pattern auto-update (M0 toolshed `?identity`, M1 version gate, M2
  `patternSource`, M3 in-place swap, M4 flag rollout), shipped 2026-07.
- [sqlite-builtin/implementation-plan.md](specs/sqlite-builtin/implementation-plan.md)
  — the SQLite builtin workstreams, as built.
- [PLANNED_FIXES.md](packages/cli/PLANNED_FIXES.md) — cli fix batches.
- [AUTOSAVE-PLAN.md](packages/ui/src/v2/components/cf-file-download/AUTOSAVE-PLAN.md)
  — cf-file-download auto-save.

### Shipped or superseded designs and decision records

- [action-id-per-instance-decision.md](specs/action-id-per-instance-decision.md)
  — per-instance action identity.
- [cfc-render-membership-lookup.md](specs/cfc-render-membership-lookup.md) —
  render-time space-membership lookup.
- [cfc-s16-default-transition-design.md](specs/cfc-s16-default-transition-design.md)
  — S16 default-label transition.
- [cfc-trusted-agent-tool-integrity.md](specs/cfc-trusted-agent-tool-integrity.md)
  — trusted-agent tool-input integrity scoping.
- [compilation-cache.md](specs/compilation-cache.md) — the removed AMD
  compilation cache.
- [module-loading-verifier-and-engine-design.md](specs/module-loading-verifier-and-engine-design.md)
  — verifier port and engine integration.
- [capability-wrappers.md](specs/pattern-construction/capability-wrappers.md)
  — superseded pattern-construction exploration.
- [pattern-integration-tests.md](specs/pattern-construction/pattern-integration-tests.md)
  — early harness design the shipped harness diverged from.
- [federation-pr5-design.md](development/federation-pr5-design.md) — earlier
  federation auth design, replaced by memory-v2 auth.
- [DESIGN_ifelse_schema_injection.md](packages/ts-transformers/DESIGN_ifelse_schema_injection.md),
  [LITERAL_WIDENING_DESIGN.md](packages/ts-transformers/docs/LITERAL_WIDENING_DESIGN.md),
  and
  [SAFE_CONTEXT_TRANSFORMS_DESIGN.md](packages/ts-transformers/docs/SAFE_CONTEXT_TRANSFORMS_DESIGN.md)
  — transformer design records.
- [MIGRATION_SUMMARY.md](packages/ui/src/v2/MIGRATION_SUMMARY.md) — the ui v2
  migration.
- [unified-storage-stack.md](future-tasks/unified-storage-stack.md) —
  DocImpl-era storage-unification plan, superseded by the v2 stack.

### Investigations, journals, and working notes

- [settle-wave-2026-03-findings.md](development/debugging/settle-wave-2026-03-findings.md)
  — March 2026 settle-wave measurements.
- [default-app-note-create.md](development/performance/default-app-note-create.md),
  [two-browsers-cold-start.md](development/performance/two-browsers-cold-start.md),
  and
  [pattern-integration-compile-bound.md](development/performance/pattern-integration-compile-bound.md)
  — June 2026 profiling snapshots.
- [scoped-cells-field-notes.md](development/scoped-cells-field-notes.md) —
  field journal from the first scoped-cell patterns.
- [2026-07-02-convergence-evidence-appendix.md](plans/2026-07-02-convergence-evidence-appendix.md)
  — convergence-investigation evidence.
- [cellset-lww-context.md](specs/memory-v2/cellset-lww-context.md) — working
  context for the cellset LWW fix.
- [OPTIMIZATION-JOURNAL.md](packages/runner/test/traverse-replay/OPTIMIZATION-JOURNAL.md)
  — traverse optimization log.
- [SCHEMA_INJECTION_NOTES.md](packages/ts-transformers/SCHEMA_INJECTION_NOTES.md),
  [TEST_PLAN_schema_injection.md](packages/ts-transformers/TEST_PLAN_schema_injection.md),
  [FALLBACK_POLICY_EXAMPLES.md](packages/ts-transformers/docs/FALLBACK_POLICY_EXAMPLES.md),
  and
  [outstanding-questions-for-manager.md](packages/ts-transformers/docs/outstanding-questions-for-manager.md)
  — schema-injection working notes.
- [parking-coordinator/summary.md](packages/patterns/factory-outputs/parking-coordinator/summary.md)
  — factory-run summary.
- [DRAG-DROP-MULTI-TAB-FIX.md](packages/patterns/record/design/DRAG-DROP-MULTI-TAB-FIX.md)
  and
  [EXTRACTION-IMPROVEMENTS.md](packages/patterns/record/design/EXTRACTION-IMPROVEMENTS.md)
  — record-pattern investigation and improvement notes.

### The retired tutorial site

- [tutorials/](tutorials/index.md) — the complete MyST source of the retired
  docs.commontools.dev site: nine chapters, example code and images, and the
  build scaffolding. Its state chapters and LLM tour teach the retired
  `cell()` API.
