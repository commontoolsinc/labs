---
name: pattern-dev
description: Guide for developing Common Fabric patterns (TypeScript modules that define reactive data transformations with UI). Use this skill when creating patterns, modifying existing patterns, or working with the pattern framework. Triggers include requests like "build a pattern", "fix this pattern error", "deploy this piece/patch", or questions about handlers and reactive patterns.
---

Start with the shared pattern development guidance in:

- `docs/common/ai/pattern-development-guide.md`

Read that guide first. It is the canonical reference.

When you're unsure whether a reactive expression site lowers the way you expect,
inspect the emitted source directly with:

- `deno task cf check <pattern>.tsx --show-transformed`

Current main handles plain ternaries well in normal pattern code. Prefer direct
authored expressions first; if an unusual site seems ambiguous, inspect the
emitted source rather than guessing.

Pay special attention to its SES authoring section before adding module-scope
setup, timers, or time/random helpers. The current authored escape hatches are
`safeDateNow()` and `nonPrivateRandom()`.

Runtime notes:

- Use the `cf` skill, or read `skills/cf/SKILL.md`, when you need CLI command
  details.
- If your runtime supports delegation, pass file paths rather than pasted
  summaries.

## Runtime-Specific Notes

### Claude Code

- Use `EnterPlanMode` before building.
- Scale the plan to the problem:
  - simple pattern: 2-3 sentences
  - medium pattern: short list
  - complex pattern: structured plan with entities, relationships, and actions
- Delegate by role when that helps:

```text
Task({
  prompt: "Implement [feature]. Keep it simple, one file.",
  subagent_type: "pattern-maker"
})

Task({
  prompt: "Deploy and test [pattern].",
  subagent_type: "pattern-user"
})

Task({
  prompt: "Review [file] for violations.",
  subagent_type: "pattern-critic"
})
```

- Run a critic pass before first deploy unless the change is a tiny, low-risk
  fix.
- At useful milestones, offer a commit.

### Other runtimes

- Preserve the same rhythm even when the invocation syntax differs:
  - plan first
  - keep the first slice runnable
  - separate implementation, runtime testing, and critique when the task is
    large enough to justify it

Phase skills consult as needed:

- Types: `docs/common/concepts/types-and-schemas/`
- Actions/handlers: `docs/common/concepts/action.md`,
  `docs/common/concepts/handler.md`
- Testing: `docs/common/workflows/pattern-testing.md`
- Components: `packages/patterns/catalog/catalog.tsx` — the authoritative,
  type-checked component catalog. Story files in
  `packages/patterns/catalog/stories/` show live usage for each component. Also
  see `docs/common/components/COMPONENTS.md` for narrative docs.
- Debugging: `docs/development/debugging/`
