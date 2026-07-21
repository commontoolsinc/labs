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

- [cts-docs-audit-2026-07.md](cts-docs-audit-2026-07.md) —
  ts-transformers/schema-generator documentation audit, July 2026.
- [cfc-spec-audit.md](cfc-spec-audit.md) — the CFC spec versus the
  packages/runner implementation, June 2026.
- [invalid-state-representations-report.md](future-tasks/code-quality-tasks/invalid-state-representations-report.md)
  and
  [module-graph-import-issues-report.md](future-tasks/code-quality-tasks/module-graph-import-issues-report.md)
  — code-quality audits, June 2025.
- [scheduler-v2/current-system-inventory.md](specs/scheduler-v2/current-system-inventory.md)
  — the v1 scheduler's mechanisms and their v2 dispositions, June 2026.
- [PREEXISTING_BUGS.md](packages/patterns/PREEXISTING_BUGS.md) — pattern
  runtime bug survey, December 2025.

### Executed plans and work orders

- [2026-03-17-ct-exec-fuse-callables.md](plans/2026-03-17-ct-exec-fuse-callables.md)
  and [its test plan](plans/2026-03-17-ct-exec-fuse-callables-test-plan.md) —
  `cf exec` and mounted callable files.
- [assertion-diagnostics.md](plans/assertion-diagnostics.md) — power-assert
  operand reporting for pattern-test assertions, with the compile-time
  constraints that shaped it, executed 2026-07.
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
- [scheduler-v2/migration-plan.md](specs/scheduler-v2/migration-plan.md) — the
  v1→v2 scheduler migration phases, as executed (#4288).
- [scheduler-v2/implementation/00-README.md](specs/scheduler-v2/implementation/00-README.md)
  — the scheduler-v2 work-order index and reading order.
- [01-phase0-remove-push-mode.md](specs/scheduler-v2/implementation/01-phase0-remove-push-mode.md)
  — scheduler-v2 work order: remove push mode.
- [02-phaseE0-event-identity.md](specs/scheduler-v2/implementation/02-phaseE0-event-identity.md)
  — scheduler-v2 work order: event identity and rejection taxonomy.
- [03-phaseE1-speculation-lineage.md](specs/scheduler-v2/implementation/03-phaseE1-speculation-lineage.md)
  — scheduler-v2 work order: speculation lineage.
- [04-phaseE2-receipts.md](specs/scheduler-v2/implementation/04-phaseE2-receipts.md)
  — scheduler-v2 work order: receipts as result cells.
- [05-phase1-static-write-surface.md](specs/scheduler-v2/implementation/05-phase1-static-write-surface.md)
  — scheduler-v2 work order: static write surface.
- [06-phase2-tx-identity.md](specs/scheduler-v2/implementation/06-phase2-tx-identity.md)
  — scheduler-v2 work order: transaction-carried identity.
- [07-phase3-cutover.md](specs/scheduler-v2/implementation/07-phase3-cutover.md)
  — scheduler-v2 work order: node records, liveness, the new settle pass (the
  cutover).
- [08-later-phases.md](specs/scheduler-v2/implementation/08-later-phases.md) —
  scheduler-v2 work order: post-cutover phases 4, 5, 7.
- [PROGRESS.md](specs/scheduler-v2/implementation/PROGRESS.md) — the
  scheduler-v2 implementation progress log.
- [persistent-scheduler-state/implementation_notes.md](specs/persistent-scheduler-state/implementation_notes.md)
  — implementation journal for the persistent scheduler-state rollout.
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
- [pull-based-scheduler/README.md](specs/pull-based-scheduler/README.md) —
  redirect stub for the retired v1 scheduler behavior reference, superseded by
  scheduler-v2.
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
- [hierarchical-params-spec.md](packages/ts-transformers/docs/hierarchical-params-spec.md)
  — hierarchical-capture implementation rationale, superseded by the behavior
  spec.
- [pr3154-review-guide.md](specs/ts-transformer/pr3154-review-guide.md) —
  reviewer entrypoint for the shipped PR-3154 transformer architecture.

### Investigations, journals, and working notes

- [reverse-invalidation-deadlock.md](packages/fuse/reverse-invalidation-deadlock.md)
  — root cause of the FUSE daemon hang that flaked the CLI FUSE integration
  suite: synchronous reverse invalidation deadlocking the request thread,
  July 2026.
- [2026-07-fuse-t-integration-flake-accumulated-nfs-state.md](packages/fuse/2026-07-fuse-t-integration-flake-accumulated-nfs-state.md)
  — a FUSE-T integration-suite failure that looked like a #4811 daemon
  regression but was accumulated stale kernel NFS mounts from SIGKILL churn;
  directory visibility works via mtime plus the NFS attribute-cache bound, not
  `notify_inval_entry`, July 2026.
- [settle-wave-2026-03-findings.md](development/debugging/settle-wave-2026-03-findings.md)
  — March 2026 settle-wave measurements.
- [2026-07-cf-profile-capture-exit-130.md](development/debugging/2026-07-cf-profile-capture-exit-130.md)
  — root cause of the cf-profile capture exit-130 CI flake, July 2026.
- [2026-07-group-chat-idempotency-false-positive.md](development/debugging/2026-07-group-chat-idempotency-false-positive.md)
  — root cause of the group-chat idempotency false-positive CI flake, July 2026.
- [default-app-note-create.md](development/performance/default-app-note-create.md),
  [two-browsers-cold-start.md](development/performance/two-browsers-cold-start.md),
  and
  [pattern-integration-compile-bound.md](development/performance/pattern-integration-compile-bound.md)
  — June 2026 profiling snapshots.
- [2026-07-pattern-capability-ci-duration-increase.md](development/performance/2026-07-pattern-capability-ci-duration-increase.md)
  — root cause of the July 2026 labs CI duration increase: two unsharded
  pattern time-capability sweeps, especially the 56-pattern sweep on shard 3.
- [2026-07-ci-duration-profile.md](development/performance/2026-07-ci-duration-profile.md)
  — July 2026 Deno Workflow profile, including compile-cache validation,
  duplicate work, workspace shard balance, and follow-up experiments.
- [2026-07-binary-artifact-transfer.md](development/performance/2026-07-binary-artifact-transfer.md)
  — binary artifact file and byte transfer snapshot before the per-binary
  workflow split, July 2026.
- [scoped-cells-field-notes.md](development/scoped-cells-field-notes.md) —
  field journal from the first scoped-cell patterns.
- [2026-07-02-convergence-evidence-appendix.md](plans/2026-07-02-convergence-evidence-appendix.md)
  — convergence-investigation evidence.
- [cellset-lww-context.md](specs/memory-v2/cellset-lww-context.md) — working
  context for the cellset LWW fix.
- [scheduler-v2/addenda/00-README.md](specs/scheduler-v2/addenda/00-README.md)
  — index of the scheduler-v2 performance-investigation addenda, June–July
  2026.
- [01-headline-and-node-multiplication.md](specs/scheduler-v2/addenda/01-headline-and-node-multiplication.md)
  — scheduler-v2 addendum: the headline A/B regression root-caused to node
  multiplication.
- [02-multi-runtime-amplification-and-commit-cost.md](specs/scheduler-v2/addenda/02-multi-runtime-amplification-and-commit-cost.md)
  — scheduler-v2 addendum: multi-runtime commit/push amplification and
  per-commit cost.
- [03-transaction-census.md](specs/scheduler-v2/addenda/03-transaction-census.md)
  — scheduler-v2 addendum: census of what the extra commits are.
- [04-refuted-free-fixes.md](specs/scheduler-v2/addenda/04-refuted-free-fixes.md)
  — scheduler-v2 addendum: refuted free fixes (declared reads, asCell
  read-depth).
- [05-serialized-scheduler-state-is-reload-only.md](specs/scheduler-v2/addenda/05-serialized-scheduler-state-is-reload-only.md)
  — scheduler-v2 addendum: serialized scheduler state is reload-only, not a
  version skip.
- [06-cross-runtime-adoption-what-would-be-needed.md](specs/scheduler-v2/addenda/06-cross-runtime-adoption-what-would-be-needed.md)
  — scheduler-v2 addendum: what cross-runtime derivation adoption would need.
- [07-pull-side-gate-no-go.md](specs/scheduler-v2/addenda/07-pull-side-gate-no-go.md)
  — scheduler-v2 addendum: the pull-side gate measured as a structural no-go.
- [08-effect-defer-neutral.md](specs/scheduler-v2/addenda/08-effect-defer-neutral.md)
  — scheduler-v2 addendum: per-wave effect coalescing measured neutral.
- [09-remediation-direction.md](specs/scheduler-v2/addenda/09-remediation-direction.md)
  — scheduler-v2 addendum: remediation direction — coalesce/dedup, not
  version-skip.
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
