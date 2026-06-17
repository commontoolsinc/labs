---
name: pattern-test
description: Write and run pattern tests
user-invocable: false
---

Start with the shared testing guidance in:

- `docs/common/ai/pattern-testing-guide.md`

Read that guide first. It is the canonical reference.

Run tests with:

```bash
deno task cf test <pattern>.test.tsx
```

When working in a Pattern Factory Build workspace, also follow
`docs/common/ai/pattern-factory-build-guide.md` (as mandated by pattern-dev). It
defines Pattern Factory's build completion gate and expected coverage shape.

For patterns that stamp timestamps or IDs, prefer deterministic assertions over
recomputing time/random values inside the test itself.

If `cf test` fails before or during assertions, treat that as pattern debugging,
not as a reason to guess at a new test shape. Before the next repair, read:

- `docs/development/debugging/README.md`

Then follow the linked gotcha or workflow for the exact error. For Cell,
Writable, or reactive-value failures, re-consult `reactivity.md` and
`new-cells.md` (as mandated by pattern-dev).

Runtime notes:

- Use the `cf` skill, or read `skills/cf/SKILL.md`, when you need CLI command
  details.
- The detailed workflow reference remains
  `docs/common/workflows/pattern-testing.md`.

## Done When

- `deno task cf test` exits 0 for every test file. A failing test is not a valid
  done state unless a concrete external, tooling, or environment blocker
  prevents further repair.
- New or changed source code has automated test coverage. PRs that introduce new
  untested lines of code will fail in CI.
- Coverage matches the testing guide's expected shape: the product contract, not
  only the happy path (first-run/default states; primary add, remove, edit,
  toggle, or submit flows; repeated actions; validation and edge-case branches
  from the spec).
- The pattern still compiles after any interface changes made to support
  testing.
