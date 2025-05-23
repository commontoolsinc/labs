# Code Quality Tasks

This document assesses the repository's alignment with [AGENTS.md](../AGENTS.md)
and lists actionable improvements.

## Observations

### Formatting

- Long lines exceed 80 characters in several files:
  - `packages/background-charm-service/src/service.ts` line 41
  - `packages/background-charm-service/src/space-manager.ts` lines 44 and 270
  - `packages/builder/src/schema-to-ts.ts` lines 79 and 86
- Import blocks sometimes mix standard, external and internal modules, e.g.
  `packages/background-charm-service/src/service.ts` lines 1-10.

### TypeScript Practices

- Singleton exports hinder testability:
  - `packages/runner/src/storage.ts` exports `storage` at line 968.
  - `packages/runner/src/recipe-manager.ts` exports `recipeManager` at line 318.
- Helper functions accept `any` in `packages/llm/src/types.ts` (e.g.
  `isLLMRequest`).
- Public functions often lack JSDoc. Files such as `packages/runner/src/cell.ts`
  and `packages/background-charm-service/src/space-manager.ts` rarely document
  parameters or return types.

### Testing

- Coverage gaps exist:
  - `packages/background-charm-service` has no tests.
  - `packages/llm` only includes `types.test.ts`.
  - `packages/toolshed` lacks tests entirely.

## Suggested Tasks

### Small Tasks

1. Wrap lines exceeding 80 characters in the background charm service and
   builder modules.
2. Group imports by origin in files such as
   `packages/background-charm-service/src/service.ts`.
3. Add JSDoc comments for exported functions in `packages/runner/src/cell.ts`
   and `packages/llm/src/prompts/*.ts`.
4. Replace `any` in `packages/llm/src/types.ts` with generics or specific types.
5. Add basic tests for `packages/background-charm-service` and
   `packages/toolshed` to ensure start-up routines load correctly.

### Medium Tasks

1. Refactor `storage` and `recipeManager` singletons into classes that callers
   instantiate.
2. Expand unit tests in `packages/llm` to cover prompt helpers such as
   `charm-describe.ts` and `workflow-classification.ts`.
3. Introduce typed interfaces for LLM request/response handling to eliminate
   remaining `any` in `packages/llm/src/types.ts`.

These tasks are ordered from straightforward formatting fixes to moderate
refactors and test additions. Completing them will move the codebase closer to
the standards set in `AGENTS.md`.
