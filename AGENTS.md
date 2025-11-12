# Repository Guidelines for AI Agents

## Pattern Development

If you are developing patterns, use Claude Skills (pattern-dev) to do the work.

### Useful Recipe/Pattern documentation

**Start here:**

- `docs/common/PATTERNS.md` - Main tutorial with examples, levels, and common
  patterns (START HERE for learning)
- `docs/common/COMPONENTS.md` - UI component reference with bidirectional
  binding and event handling

**Core concepts:**

- `docs/common/CELLS_AND_REACTIVITY.md` - Cell system, computed(), reactivity
  mental models (when Cell<> is needed for write access)
- `docs/common/TYPES_AND_SCHEMAS.md` - Type system, Cell<> vs OpaqueRef<>,
  Default<>, when to use [ID]

**Workflow:**

- `docs/common/PATTERN_DEV_DEPLOY.md` - Building, debugging, and deploying
  patterns step-by-step
- `docs/common/DEBUGGING.md` - Error reference, debugging workflows,
  troubleshooting

**Reference:**

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
