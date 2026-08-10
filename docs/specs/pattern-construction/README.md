# Pattern construction specs

These documents define how authored patterns become deterministic, serializable
graphs and how builder-produced cells acquire stable identities.

## Document map

- [Pattern graph unification](overview.md) defines the common pattern-builder
  model.
- [First-class serializable factories](node-factory-shipping.md) defines the
  durable factory representation for patterns, modules, and handlers.
- [Cause derivation](cause-derivation.md) defines deterministic causes for
  cells created by builder helpers.
- [Graph snapshot schema](graph-snapshot.md) describes the deferred graph
  metadata format.
- [Rollout plan](rollout-plan.md) records the implementation sequence for the
  graph-unification work.
