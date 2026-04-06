---
name: pattern-test
description: Write and run pattern tests
user-invocable: false
---

Start with the shared testing guidance in:

- `docs/common/ai/pattern-testing-guide.md`

Read that guide first. It is the canonical reference.

For patterns that stamp timestamps or IDs, prefer deterministic assertions over
recomputing time/random values inside the test itself.

Runtime notes:

- Use the `cf` skill, or read `skills/cf/SKILL.md`, when you need CLI command
  details.
- The detailed workflow reference remains
  `docs/common/workflows/pattern-testing.md`.
