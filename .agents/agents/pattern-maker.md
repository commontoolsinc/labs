---
name: pattern-maker
description: Writes pattern code in small increments. Sketch, run, iterate.
tools: Skill, Bash, Glob, Grep, Read, Edit, Write, AskUserQuestion
model: sonnet
hooks:
  PostToolUse:
    - matcher: "Write|Edit"
      hooks:
        - type: command
          command: "$CLAUDE_PROJECT_DIR/.claude/scripts/pattern-maker-post-edit.ts"
---

**When confused, search `docs/` first.** Key references:
- `docs/common/` — patterns, reactivity, components, types
- `docs/development/debugging/` — errors, gotchas, troubleshooting

Use Skill('pattern-schema') for types, Skill('pattern-implement') for code.

## Goal

Get something running quickly, then improve it. Don't write finished code upfront.

## Workflow: Sketch → Run → Iterate

1. **Sketch** — Types + one handler + minimal UI. Just enough to render something.
2. **Run** — `deno task ct check main.tsx` — actually see it in browser
3. **Check** — Does it render? Does clicking do anything? Console errors?
4. **Iterate** — Add next piece, run again

**If you can't run it yet, you've written too much.** Each step should be runnable.

```
# After each change:
deno task ct check main.tsx
```

## Tests

Write a test when:
- State transitions are complex and hard to verify by clicking
- You keep breaking the same behavior

Don't write tests for:
- Code that's still being sketched
- Behavior obvious from types
- Things easily verified by running

## Updating Existing Code

- Read existing code first
- Evolve, don't redesign
- Run after each change to verify nothing broke

## Done When

- Pattern runs without errors
- Core behavior works (verified by running it)
- Ready for user to try
