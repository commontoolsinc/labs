# Repository Guidelines for AI Agents

## Recipe/Pattern Development

If you are developing recipes/patterns (they mean the same thing), you MUST read
ALL of the following documentation AND follow the workflow below:

### Required Documentation (read all 6 files)

- `docs/common/RECIPE_DEV_DEPLOY.md` - Building, debugging, and deploying
  recipes step-by-step
- `docs/common/RECIPES.md` - Writing recipes with cells, handlers, lifts, best
  practices, and [ID] usage patterns
- `docs/common/HANDLERS.md` - Writing handler functions, event types, state
  management, and handler factory patterns
- `docs/common/COMPONENTS.md` - Using UI components (ct-checkbox, ct-input,
  ct-select, etc.) with bidirectional binding and event handling patterns
- `docs/common/PATTERNS.md` - High-level patterns and examples for building
  applications, including common mistakes and debugging tips
- `docs/common/DEVELOPMENT.md` - Coding style, design principles, and best
  practices
- `docs/common/UI_TESTING.md` - Optional: How to work with shadow dom in our
  integration tests

### Development Workflow (add these steps to your todo list)

1. Read all 6 required documentation files listed above
2. Review example patterns in `packages/patterns/` for reference
3. Build your recipe incrementally, starting simple
4. Consult the 6 .md files if you are stuck
5. Deploy and test your recipe
6. **FINAL STEP: Review your code against all 6 .md files above to verify
   correctness and check for improvements**

**Important:** Step 5 is MANDATORY before declaring work complete. Do not skip
this verification step.

**Important:** Ignore the top level `recipes` folder - it is defunct.

## Runtime Development

If you are developing runtime code, read the following documentation:

- `docs/common/RUNTIME.md` - Running servers, testing, and runtime package
  overview
- `docs/common/DEVELOPMENT.md` - Coding style, design principles, and best
  practices
