---
name: pattern-dev
description: Guide for developing CommonTools patterns (TypeScript modules that define reactive data transformations with UI). Use this skill when creating patterns, modifying existing patterns, or working with the pattern framework. Triggers include requests like "build a pattern", "fix this pattern error", "deploy this charm/patch", or questions about handlers and reactive patterns.
---

You and the user are a team finding the efficient path to their vision.

## Always Plan First

Use `EnterPlanMode` to plan before building. During planning:

1. **Clarify requirements** — Ask the user upfront:
   - What are the core entities? (e.g., "What are the cards? What data do they hold?")
   - What actions are needed? (e.g., "Drag and drop? Custom columns?")
   - How should this expose data to other patterns?
   - Any integrations or side effects needed?

2. **Design component structure** — Break into sub-patterns:
   ```
   packages/patterns/kanban/
   ├── schemas.tsx      # All types
   ├── card.tsx         # Leaf: Card pattern
   ├── card.test.tsx
   ├── column.tsx       # Container: Column with Cards
   ├── column.test.tsx
   ├── board.tsx        # Top-level: Board with Columns
   ├── board.test.tsx
   └── main.tsx         # Entry point
   ```

3. **Plan parallel work** — Identify independent pieces that can be built concurrently.

Get user approval via `ExitPlanMode` before executing.

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

## Delegate to Agents

Pick the right agent for the task at hand:

### pattern-maker — Write & Verify Code

For implementing pattern code with tests:
```
Task({
  prompt: "Implement the [concept] pattern with tests. [concept] holds a list of [items] and offers [actions]. The overall goal is [system].",
  subagent_type: "pattern-maker"
})
```

The maker agent loads guidance from pattern-schema, pattern-implement, pattern-test skills. It has hooks that suggest running tests after edits and remind to verify before completing.

### pattern-user — Deploy & Debug

For deploying and interacting with running charms:
```
Task({
  prompt: "Deploy the [pattern] charm and verify [behavior] works correctly.",
  subagent_type: "pattern-user"
})
```

The user agent loads guidance from pattern-deploy, pattern-debug skills. It has hooks that guide ct CLI usage after commands.

### pattern-critic — Review for Violations

For checking code against documented rules:
```
Task({
  prompt: "Review [file] for violations of pattern rules and gotchas.",
  subagent_type: "pattern-critic"
})
```

The critic agent loads the pattern-critic skill and systematically checks all 10 violation categories, outputting [PASS]/[FAIL] results.

### Guidance Skills (loaded by agents)

These skills provide domain knowledge:
- **pattern-schema** — types and actions
- **pattern-implement** — implementation code
- **pattern-test** — tests for invariants
- **pattern-ui** — layout and styling
- **pattern-deploy** — ct CLI, charm ops
- **pattern-debug** — error investigation

Don't do implementation work directly—delegate to agents.

## Orchestration Flow

**Phases are not strict ordering.** The typical flow:

### Build Phase
1. **Make** — Use pattern-maker for each component (parallel if independent)
2. **Critic** — Use pattern-critic to verify approach before deploying
3. **Deploy** — Use pattern-user to deploy and test
4. **Present** — Give user a link to try it

### Feedback Loop
5. **Gather feedback** — User tests, provides feedback
6. **Update** — Use pattern-maker to evolve existing patterns (not redesign)
7. **Verify** — Use pattern-critic to check updates don't regress
8. **Redeploy** — Ask user: new instance or update existing?
9. **Test** — Use pattern-user to help user verify changes

### Checkpoints
10. **Commit** — At milestones, offer to commit working changes

Launch concurrent agents when independent:
- Multiple leaf patterns can be built in parallel
- Independent updates can proceed concurrently

Pass each agent specific files, context, and constraints.

## Documentation

Start with `docs/common/patterns/`—especially `docs/common/patterns/meta/` which contains generalizable idioms that grow over time.

Prefer docs over existing patterns in `packages/patterns/`—docs contain validated snippets while existing patterns may be outdated. Use `packages/patterns/` as reference but don't copy blindly.

Phase skills consult as needed:
- Types: `docs/common/concepts/types-and-schemas/`
- Actions/handlers: `docs/common/concepts/action.md`, `docs/common/concepts/handler.md`
- Testing: `docs/common/workflows/pattern-testing.md`
- Components: `docs/common/components/COMPONENTS.md`
- Debugging: `docs/development/debugging/`
