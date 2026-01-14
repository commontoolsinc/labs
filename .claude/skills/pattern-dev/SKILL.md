---
name: pattern-dev
description: Guide for developing CommonTools patterns (TypeScript modules that define reactive data transformations with UI). Use this skill when creating patterns, modifying existing patterns, or working with the pattern framework. Triggers include requests like "build a pattern", "fix this pattern error", "deploy this charm/patch", or questions about handlers and reactive patterns.
---

You and the user are a team finding the efficient path to their vision.

## Always Plan First

Use the `EnterPlanMode` tool—don't just create a PLAN.md file. Launch parallel Explore agents to understand context: existing patterns, relevant docs, the user's data model. Write a concrete plan. Get user approval via `ExitPlanMode` before executing.

## Pattern Structure

Make use of multi-file composition. Each concept with its own behavior becomes its own sub-pattern:

```
packages/patterns/[name]/
├── schemas.tsx        # All types, Input/Output for each pattern
├── [leaf].tsx         # Leaf sub-patterns (no dependencies)
├── [leaf].test.tsx    # Tests for leaf pattern
├── [container].tsx    # Compose leaf patterns
├── [container].test.tsx
└── main.tsx           # Top-level composition
```

Each sub-pattern gets a corresponding `.test.tsx` file to verify its data model and actions before moving on.

Rule of thumb: `Project` containing `Task[]` means both `project.tsx` AND `task.tsx` sub-patterns, each with their own tests. The project pattern composes task patterns.

Work from leaves up: leaf patterns → container patterns → main.tsx

## Development Approach

Build incrementally. Write a verifiable piece, verify it works, keep going. Don't over-test code that will be refactored—test what matters for confidence to proceed.

Learn from docs and code samples, try something, verify with running code, adjust. Proceed scientifically: hypothesize, test, learn.

Gradually build up each concept. Data model, actions, UI can evolve together as understanding solidifies. Avoid rigid phase gates that delay feedback.

## Verify with Tests

**Use the pattern testing framework to verify state transitions and invariants.** Don't rely on `ct charm call` or asking the user to interact with UI—those come later.

Pattern tests: `deno task ct test packages/patterns/[name]/[file].test.tsx`
- For reactive state, actions, data model invariants
- See `docs/common/workflows/pattern-testing.md`

Standard deno tests: `deno test [file].test.ts`
- For pure functions with no reactivity

## Delegate to Subagents

Use `Task()` subagents for all code changes. Tell them which skill to use for guidance:

```
Task({
  prompt: "Use Skill('pattern-schema') for guidance. Create schemas.tsx with [specific types]...",
  subagent_type: "blackboard:implementer"
})
```

Phase skills provide guidance:
- **pattern-schema** — types and actions
- **pattern-implement** — implementation code
- **pattern-test** — tests for invariants
- **pattern-ui** — layout and styling
- **pattern-deploy** — ct CLI, charm ops
- **pattern-debug** — error investigation

Don't do implementation work directly—spawn subagents and tell them which skill to load.

## Parallel Execution

Launch concurrent agents when independent:
- Multiple concepts can progress in parallel
- Explore agents run in parallel during planning

Pass each subagent specific files, decisions, and constraints.

## Documentation

Start with `docs/common/patterns/`—especially `docs/common/patterns/meta/` which contains generalizable idioms that grow over time.

Prefer docs over existing patterns in `packages/patterns/`—docs contain validated snippets while existing patterns may be outdated. Use `packages/patterns/` as reference but don't copy blindly.

Phase skills consult as needed:
- Types: `docs/common/concepts/types-and-schemas/`
- Actions/handlers: `docs/common/concepts/action.md`, `docs/common/concepts/handler.md`
- Testing: `docs/common/workflows/pattern-testing.md`
- Components: `docs/common/components/COMPONENTS.md`
- Debugging: `docs/development/debugging/`
