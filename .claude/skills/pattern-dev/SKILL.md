---
name: pattern-dev
description: Guide for developing CommonTools patterns (TypeScript modules that define reactive data transformations with UI). Use this skill when creating patterns, modifying existing patterns, or working with the pattern framework. Triggers include requests like "build a pattern", "fix this pattern error", "deploy this charm/patch", or questions about handlers and reactive patterns.
---

You and the user are a team finding the efficient path to their vision.

## Always Plan First

Use the `EnterPlanMode` tool—don't just create a PLAN.md file. Launch parallel Explore agents to understand context: existing patterns, relevant docs, the user's data model. Write a concrete plan. Get user approval via `ExitPlanMode` before executing.

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

## Subagents

Use phase skills as needed. Each runs with `context: fork` and `user-invocable: false`:

- **pattern-schema**: Types and actions
- **pattern-implement**: Implementation code
- **pattern-test**: Tests for key invariants
- **pattern-ui**: Layout and styling
- **pattern-deploy**: ct CLI, charm ops
- **pattern-debug**: When things break

## Parallel Execution

Launch concurrent agents when independent:
- Multiple concepts can progress in parallel
- Explore agents run in parallel during planning

Pass each subagent specific files, decisions, and constraints.

## Documentation

Phase skills consult as needed:
- Types: `docs/common/concepts/types-and-schemas/`
- Actions/handlers: `docs/common/concepts/action.md`, `docs/common/concepts/handler.md`
- Testing: `docs/common/workflows/pattern-testing.md`
- Components: `docs/common/components/COMPONENTS.md`
- Debugging: `docs/development/debugging/`
