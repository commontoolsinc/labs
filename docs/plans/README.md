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
- [Integration-test video demos](integration-test-video-demos.md) tracks
  optional CI adoption and further fixture hardening.
- [Inverting the physics of trust](inverting-the-physics-of-trust.md) explains
  the runtime's trust model and the work that follows from it.
- [Server-primary execution v2](server-execution-v2.md) sequences the
  greenfield rebuild that executes the server-side-execution v2 spec, with
  per-phase task and success-criteria checkboxes.
- [Pattern verb contract implementation](pattern-verb-contract-implementation.md)
  sequences the implementation of the
  [pattern verb contract](pattern-verb-contract.md).
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
