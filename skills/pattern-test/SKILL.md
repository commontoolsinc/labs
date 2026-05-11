---
name: pattern-test
description: Write and run pattern tests
user-invocable: false
---

Start with the shared testing guidance in:

- `docs/common/ai/pattern-testing-guide.md`

Read that guide first. It is the canonical reference.

When working in a Pattern Factory Build workspace, also read:

- `docs/common/ai/pattern-factory-build-guide.md`

It defines Pattern Factory's build completion gate and expected coverage shape.

For patterns that stamp timestamps or IDs, prefer deterministic assertions over
recomputing time/random values inside the test itself.

If `cf test` fails before or during assertions, treat that as pattern debugging,
not as a reason to guess at a new test shape. Before the next repair, read:

- `docs/development/debugging/README.md`

Then follow the linked gotcha or workflow for the exact error. For Cell,
Writable, or reactive-value failures, also read:

- `docs/common/concepts/reactivity.md`
- `docs/common/patterns/new-cells.md`

Runtime notes:

- Use the `cf` skill, or read `skills/cf/SKILL.md`, when you need CLI command
  details.
- The detailed workflow reference remains
  `docs/common/workflows/pattern-testing.md`.
