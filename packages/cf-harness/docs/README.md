# cf-harness Documentation

This directory contains live documentation for the current `cf-harness`
implementation. The repository-wide lifecycle rules in
[`../../../docs/README.md`](../../../docs/README.md) apply here: current
reference and intended designs stay live; completed plans and point-in-time
migration notes live under `docs/history/` at the repository root.

## Start here

- [Package README](../README.md) — operator entry point, commands, and detailed
  feature reference.
- [CURRENT_STATE.md](CURRENT_STATE.md) — concise current architecture,
  integrations, and known gaps.
- [IMPLEMENTATION_PROFILE.md](IMPLEMENTATION_PROFILE.md) — conformance statement
  against the cross-repository Agent Harness specification.
- [ROADMAP.md](ROADMAP.md) — remaining work only; shipped milestones are not
  repeated as a plan.
- [SKILLS_SUPPORT_SPEC.md](SKILLS_SUPPORT_SPEC.md) — live
  implementation-specific skills contract and future dynamic-activation design.

## Normative boundary

The implementation-independent runtime and CFC contracts live in the sibling
`specs` repository under `agent-harness/`. This package owns exact CLI flags,
tools, profiles, schemas, defaults, artifacts, and deviations. Loom and Pattern
Factory own their adapter and rollout behavior.

## Historical records

- [`IMPLEMENTATION_PLAN.md`](../../../docs/history/packages/cf-harness/docs/IMPLEMENTATION_PLAN.md)
  — the April 2026 package bootstrap plan and checkpoint.
- [`LOOM_MIGRATION_NOTES.md`](../../../docs/history/packages/cf-harness/docs/LOOM_MIGRATION_NOTES.md)
  — the April 2026 pre-integration assessment of Loom's Codex paths.

Historical documents are useful background, not descriptions of the current
system.
