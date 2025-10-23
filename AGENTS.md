# Repository Guidelines for AI Agents

## Recipe/Pattern Development

If you are developing recipes/patterns (they mean the same thing), use Claude
Skills (recipe-dev) to do the work.

### Useful Recipe/Pattern documentation

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
- `packages/patterns/INDEX.md` - Catalog of all pattern examples with summaries,
  data types, and keywords

**Important:** Ignore the top level `recipes` folder - it is defunct.

## Runtime Development

If you are developing runtime code, read the following documentation:

- `docs/common/RUNTIME.md` - Running servers, testing, and runtime package
  overview
- `docs/common/DEVELOPMENT.md` - Coding style, design principles, and best
  practices
- `docs/common/UI_TESTING.md` - How to work with shadow dom in our integration
  tests
