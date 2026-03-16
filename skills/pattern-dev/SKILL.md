---
name: pattern-dev
description: Guide for developing CommonTools patterns (TypeScript modules that define reactive data transformations with UI). Use this skill when creating patterns, modifying existing patterns, or working with the pattern framework. Triggers include requests like "build a pattern", "fix this pattern error", "deploy this piece/patch", or questions about handlers and reactive patterns.
---

Start with the shared pattern development guidance in:

- `docs/common/ai/pattern-development-guide.md`

Read that guide first. It is the canonical, agent-neutral reference.

Runtime notes:

- Use the `ct` skill, or read `skills/ct/SKILL.md`, when you need CLI command
  details.
- If your runtime supports delegation, pass file paths rather than pasted
  summaries.

Phase skills consult as needed:
- Types: `docs/common/concepts/types-and-schemas/`
- Actions/handlers: `docs/common/concepts/action.md`, `docs/common/concepts/handler.md`
- Testing: `docs/common/workflows/pattern-testing.md`
- Components: `packages/patterns/catalog/catalog.tsx` — the authoritative, type-checked component catalog. Story files in `packages/patterns/catalog/stories/` show live usage for each component. Also see `docs/common/components/COMPONENTS.md` for narrative docs.
- Debugging: `docs/development/debugging/`
