# Migration and Rollout Plan

## Phases

1. **Prototype in Runner Sandbox**
   - Implement capability wrappers behind a feature flag. Gate entry points in
     `createBuilder` so recipes opt in per-runtime.
   - Add regression tests under `packages/runner/src/builder/__tests__` that
     exercise both legacy `OpaqueRef` paths and the new wrapper behavior.
2. **Snapshot and Cause Pilot**
   - Enable graph snapshot generation for internal recipes only. Use the
     `RecipeManager` to tag participating recipes so telemetry can compare
     runtime rebuild times pre- and post-snapshot.
   - Surface snapshot diffs in a development panel (reuse existing harness UI)
     to validate stability guarantees.
3. **Recipe Migration**
   - Provide codemods or manual guides to migrate high-traffic recipes in the
     `recipes/` workspace. Update `recipes/README.md` to describe capabilities
     and snapshot expectations.
   - Teach docs and tutorials to reference capability wrappers instead of
     `OpaqueRef`. Update `docs/common/COMPONENTS.md` once APIs stabilize.
4. **Cleanup and Deprecation**
   - Remove `OpaqueRef` exports from `@commontools/api` after recipes migrate.
   - Delete shadow-ref utilities and legacy alias handling once snapshots power
     rehydration. Simplify `factoryFromRecipe` to persist capability metadata
     instead of path-derived aliases.

## Testing Strategy

- Extend existing recipe integration tests (`recipes/todo-list.tsx`, scheduler
  suites) to assert snapshot creation, cause stability, and wrapper helper
  behavior.
- Add rehydration tests that serialize a snapshot, mutate result metadata, and
  ensure the runtime can rebuild without rerunning the recipe factory.

## Communication

- Publish an ADR summarizing the capability model and snapshot design for review
  by runtime, storage, and tooling stakeholders.
- Coordinate with DX and documentation teams to schedule updates to learning
  materials. Provide example migrations that highlight mixed-capability inputs
  and handler rehydration flows.
