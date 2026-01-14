---
name: pattern-dev
description: Guide for developing CommonTools patterns (TypeScript modules that define reactive data transformations with UI). Use this skill when creating patterns, modifying existing patterns, or working with the pattern framework. Triggers include requests like "build a pattern", "fix this pattern error", "deploy this pattern", or questions about handlers and reactive patterns.
---

# Pattern Development

## Read This First

**You MUST write and run tests for each sub-pattern before writing the next one.**

The #1 mistake is writing all the code first, then testing. This wastes hours debugging cascading errors. Instead:

```
schemas.tsx → ingredient.tsx → ingredient.test.tsx → RUN TESTS → recipe.tsx → recipe.test.tsx → RUN TESTS → main.tsx
```

Run tests with: `deno task ct test packages/patterns/[name]/ingredient.test.tsx`

See `docs/common/workflows/pattern-testing.md` for test file format.

**First pass = minimal UI.** Just basic inputs/buttons to verify data and actions work. No styling, no polish. Read COMPONENTS.md only during the final UI polish step, not at the start.

## Warning: Existing Patterns Are Not Reliable Guides

**Do not copy patterns from `packages/patterns/` without verification.** Existing patterns were written using older conventions and varied styles. Many lack explicit Output types, use deprecated APIs, or don't follow current best practices.

When you encounter errors:
1. **Read the error message carefully** and consult the relevant docs
2. **Do not search existing patterns** looking for "how others did it"
3. **Trust this skill document** and the linked docs as the source of truth

Existing patterns are useful for:
- UI layout examples (how to structure `ct-screen`, `ct-vstack`, etc.)

Existing patterns are NOT reliable for:
- Type patterns (`Writable<>`, `Default<>`, Input/Output types)
- Action/handler definitions
- Schema structure
- Testing patterns

We're actively standardizing the pattern library. Until complete, treat `packages/patterns/` as legacy code.

## Overview

Patterns are TypeScript/JSX programs that define reactive data transformations with UIs. Use the `ct` CLI to deploy and interactively test them; `deno task ct --help` has comprehensive details on how to do so.

## Quick Start

→ **Create a new pattern** → See "Starting a New Pattern"
→ **Modify existing pattern** → See "Modifying Patterns"
→ **Debug an error** → Check `docs/development/debugging/`

## Key Principles

### Object Graph, Not Database

The reactive fabric uses direct references between objects. When you have a reference to an object, you *have* that object. Use `equals()` for identity comparison:

```tsx
interface Task {
  title: string;
  done: boolean;
}

// Use equals() to find/remove items by reference
const deleteTask = action((task: Task) => {
  tasks.set(tasks.get().filter(t => !equals(task, t)));
});

// Or use the index from .map()
{tasks.map((task, index) => (
  <ct-button onClick={() => tasks.set(tasks.get().toSpliced(index, 1))}>
    Delete
  </ct-button>
))}
```

See `docs/common/concepts/identity.md` for the full mental model.

### Scoping Rules

**Define at module scope:**
- Helper functions
- `handler()` definitions
- `lift()` definitions

**Define inside pattern body:**
- `action()` callbacks
- `computed()` callbacks
- `.map()` callbacks

Bind handlers inside the pattern: `onClick={myHandler({ state })}`

See `docs/development/debugging/gotchas/handler-inside-pattern.md` for details and error messages.

### Action vs Handler

In most cases, `action` defined inside the pattern body is preferred:

- **Use `action()`** when the handler closes over local state created in the pattern body
- **Use `handler()`** only when the same logic needs different bindings (e.g., per-item operations in a list)

```tsx
// action() - closes over local `inputValue`
const inputValue = Cell.of("");
const submit = action(() => {
  items.push({ text: inputValue.get() });
  inputValue.set("");
});

// handler() - reused with different bindings per item
const deleteItem = handler<unknown, { items: Writable<Item[]>; index: number }>(
  (_, { items, index }) => items.set(items.get().toSpliced(index, 1))
);

// In JSX:
{items.map((item, index) => (
  <ct-button onClick={deleteItem({ items, index })}>Delete</ct-button>
))}
```

See `docs/common/concepts/action.md` and `docs/common/concepts/handler.md` for details.

## Starting a New Pattern

Always use multi-file composition. Create the folder structure first:

```bash
mkdir -p packages/patterns/[name]
touch packages/patterns/[name]/schemas.tsx
```

**Define all types in `schemas.tsx` before writing any pattern code.** This file is the anchor - all other files import from it.

### Always Define Input AND Output Types

**Every pattern must have explicit `Input` and `Output` interface types.** Use `pattern<Input, Output>(...)`.

The Output type must include:
- All data fields returned from the pattern
- All `Writable<>` cells returned
- **All actions/handlers returned** as `Stream<void>` (or `Stream<EventType>`)

Without explicit Output types, the schema generator won't know the types of exported actions, and tests calling `.send()` on them will fail at runtime.

### Schema Field Rules

For each field in your data schemas, decide:

1. **Will it be edited via UI** (`$value`, `$checked`)? → Use `Writable<>`
2. **Could it be undefined initially?** → Use `Default<T, value>`
3. **Both?** → Use `Writable<Default<T, value>>`

See `docs/common/concepts/types-and-schemas/default.md` for full documentation.

### Decompose into Sub-Patterns

**Always decompose patterns into focused sub-patterns.** Avoid monolithic `main.tsx` files. Each schema type that has its own display or behavior should be its own sub-pattern.

**Rule of thumb:** If you have a schema like `Project` containing `Task[]`, create both a `project.tsx` sub-pattern AND a `task.tsx` sub-pattern. The project pattern composes task patterns for each item.

Benefits of decomposition:
- **Testability**: Each sub-pattern can be tested independently
- **Reusability**: Sub-patterns can be composed in different ways
- **Maintainability**: Smaller files are easier to understand and modify
- **Parallel development**: Different sub-patterns can be worked on separately

### Example: Recipe Manager

**Step 1: Write schemas.tsx FIRST** (data types, Input/Output types for each pattern):

```tsx
// schemas.tsx
import { Default, Stream, Writable } from "commontools";

// ============ DATA TYPES ============

export interface Ingredient {
  name: Writable<Default<string, "">>;
  amount: Writable<Default<string, "">>;
  optional: Writable<Default<boolean, false>>;
}

export interface Recipe {
  title: Writable<Default<string, "Untitled">>;
  ingredients: Writable<Default<Ingredient[], []>>;
  instructions: Writable<Default<string, "">>;
}

export interface RecipeBook {
  recipes: Writable<Default<Recipe[], []>>;
}

// ============ PATTERN INPUT/OUTPUT TYPES ============
// Define these for each sub-pattern. Output must include all returned actions as Stream<void>.

export interface IngredientInput {
  ingredient: Ingredient;
}

export interface IngredientOutput {
  ingredient: Ingredient;
  isEditing: Writable<boolean>;
  startEditing: Stream<void>;  // Actions must be Stream<void>
  stopEditing: Stream<void>;
}

export interface RecipeInput {
  recipe: Recipe;
}

export interface RecipeOutput {
  recipe: Recipe;
  addIngredient: Stream<void>;
}
```

**Step 2: Write ingredient.tsx** (import Input/Output from schemas)

```tsx
import { action, pattern, UI, Writable } from "commontools";
import type { IngredientInput, IngredientOutput } from "./schemas.tsx";

export default pattern<IngredientInput, IngredientOutput>(({ ingredient }) => {
  const isEditing = Writable.of(false);
  const startEditing = action(() => isEditing.set(true));
  const stopEditing = action(() => isEditing.set(false));

  return {
    [UI]: (
      <div>
        <input $value={ingredient.name} />
        <input $value={ingredient.amount} />
      </div>
    ),
    ingredient,
    isEditing,
    startEditing,
    stopEditing,
  };
});
```

**Step 3: Write ingredient.test.tsx → RUN TESTS → FIX until passing**

```bash
deno task ct test packages/patterns/recipe-manager/ingredient.test.tsx
```

See `docs/common/workflows/pattern-testing.md` for test file format. **Do NOT continue until tests pass.**

**Step 4: Write recipe.tsx** (import Input/Output from schemas)

```tsx
import { action, pattern, UI } from "commontools";
import type { RecipeInput, RecipeOutput } from "./schemas.tsx";
import Ingredient from "./ingredient.tsx";

export default pattern<RecipeInput, RecipeOutput>(({ recipe }) => {
  const addIngredient = action(() => {
    recipe.ingredients.push({ name: "", amount: "", optional: false });
  });

  return {
    [UI]: (
      <div>
        <input $value={recipe.title} />
        {recipe.ingredients.map((ing) => Ingredient({ ingredient: ing }))}
        <button onClick={addIngredient}>Add Ingredient</button>
      </div>
    ),
    recipe,
    addIngredient,
  };
});
```

**Step 5: Write recipe.test.tsx → RUN TESTS → FIX until passing**

```bash
deno task ct test packages/patterns/recipe-manager/recipe.test.tsx
```

**Do NOT continue until tests pass.**

**Step 6: Write main.tsx → TEST IT**

Only after ingredient and recipe tests are passing.

### Project Structure

```
packages/patterns/[name]/
├── schemas.tsx           # Types with Writable<>/Default<> (create FIRST)
├── [leaf].tsx            # Leaf sub-pattern → TEST before continuing
├── [container].tsx       # Container sub-pattern → TEST before continuing
└── main.tsx              # Top-level composition → TEST
```

## Development Methodology

**The core rule: Write one sub-pattern → Test it → Move to the next. Never skip testing.**

**First pass: Data and logic only.** Use minimal stub UI (basic inputs/buttons) just to verify data flow and actions work. Don't spend time on layout, styling, or UI polish—that comes later. Most bugs are in data/actions, not UI.

Work from leaf patterns up to main.tsx. For each sub-pattern:

1. **Write** the sub-pattern with minimal UI (e.g., `ingredient.tsx`)
2. **Test** it using CLI commands OR automated tests (see below)
3. **Fix** any issues until it works correctly
4. **Then** move to the next sub-pattern that composes it

**Do NOT write multiple sub-patterns before testing.** Write tests and run them for each sub-pattern as you complete it.

### Pattern Tests

For each sub-pattern, write a corresponding `.test.tsx` file:

```bash
deno task ct test packages/patterns/[name]/ingredient.test.tsx
```

See `docs/common/workflows/pattern-testing.md` for test file format.

**Alternative: Interactive CLI testing** (for quick debugging)
```bash
deno task ct charm new packages/patterns/[name]/ingredient.tsx  # Deploy
deno task ct charm inspect                                       # Check state
```

### UI Polish (Final Step)

Only after ALL sub-patterns have working data and actions, go back and build the full UI. Before writing UI:
1. Read `docs/common/components/COMPONENTS.md` for available components
2. Search `packages/patterns/` for **UI layout examples only** (component arrangement, not data/action patterns)

### Using the ct CLI

When deploying and interacting with patterns, explore the CLI documentation thoroughly:

```bash
# Learn available commands
deno task ct --help

# Get help for specific subcommands
deno task ct charm --help
deno task ct test --help
```

**Before deploying, find your identity key:**

```bash
# Check for .key files in common locations
ls -la *.key 2>/dev/null || ls -la ~/.claude/*.key 2>/dev/null || find . -name "*.key" -maxdepth 2 2>/dev/null
```

Use the `--identity` flag with the path to your key file when deploying.

Common commands:
- `deno task ct dev pattern.tsx --no-run` - Check syntax without deploying
- `deno task ct charm new` - Deploy a new pattern
- `deno task ct charm inspect` - View pattern state
- `deno task ct test` - Run automated tests

See `docs/development/LOCAL_DEV_SERVERS.md` for local development setup.

## Modifying Patterns

### Getting Pattern Source

```bash
deno task ct charm getsrc [output-path] --charm CHARM_ID
```

### Making Changes

1. Edit the pattern file
2. Check syntax: `deno task ct dev pattern.tsx --no-run`
3. Update deployed pattern: `deno task ct charm setsrc`

### Self-Referential Types with SELF

Use `SELF` to get a reference to the pattern's own output, useful for:
- Adding self to a collection (e.g., registering in a list)
- Creating children with a parent reference back to self

```typescript
import { Writable, SELF, pattern } from "commontools";

interface Input {
  label: string;
  parent: Output | null;
  registry: Writable<Output[]>;
}
interface Output {
  label: string;
  parent: Output | null;
  children: Output[];
}

const Node = pattern<Input, Output>(({ label, parent, registry, [SELF]: self }) => {
  const children = Writable.of<Output[]>([]);

  return {
    label,
    parent,
    children,
    [UI]: (
      <div>
        <button onClick={() => children.push(Node({ label: "Child", parent: self, registry }))}>
          Add Child
        </button>
        <button onClick={() => registry.push(self)}>
          Add to Registry
        </button>
      </div>
    ),
  };
});
```

**Key rules:**
- **Both type params required:** Use `pattern<Input, Output>()` - single param `pattern<Input>()` will error if you access SELF
- **`self` is typed as the output** - the instantiated charm itself, enabling recursive structures

See `packages/patterns/self-reference-test.tsx` for a working example.

## Multi-File Patterns

Key points:
- Use relative imports: `import { Schema } from "./schemas.tsx"`
- ct bundles all dependencies automatically on deployment
- Export shared schemas to avoid type mismatches between linked patterns

## Consult Docs on First Use

When using an API feature for the first time in a session, read the relevant documentation before proceeding. This prevents subtle mistakes that examples alone won't catch.

| First time using... | Read this first |
|---------------------|-----------------|
| `Default<>` | `docs/common/concepts/types-and-schemas/default.md` |
| `computed()` | `docs/common/concepts/computed/computed.md` |
| `lift()` | `docs/common/concepts/lift.md` |
| `Writable<>` | `docs/common/concepts/types-and-schemas/writable.md` |
| `action()` | `docs/common/concepts/action.md` |
| `handler()` | `docs/common/concepts/handler.md` |
| `equals()` / object identity | `docs/common/concepts/identity.md` |
| `pattern<Input, Output>()` | `docs/common/concepts/pattern.md` |
| `ifElse` / conditionals | `docs/common/patterns/conditional.md` |
| `$value` bindings | `docs/common/patterns/two-way-binding.md` |
| UI components (`ct-*`) | `docs/common/components/COMPONENTS.md` |
| Pattern composition | `docs/common/patterns/composition.md` |
| Pattern testing | `docs/common/workflows/pattern-testing.md` |
| LLM integration | `docs/common/capabilities/llm.md` |

After drafting code, cross-check against docs for the features you used to verify correct usage.

## Documentation Map

| Topic | Location |
|-------|----------|
| Introduction | `docs/common/INTRODUCTION.md` |
| Core concepts | `docs/common/concepts/` |
| UI components | `docs/common/components/` |
| Common patterns | `docs/common/patterns/` |
| Capabilities (LLM, side-effects) | `docs/common/capabilities/` |
| Workflows (dev, linking, testing) | `docs/common/workflows/` |
| Pattern testing | `docs/common/workflows/pattern-testing.md` |
| UI layout examples | `packages/patterns/` (layout only, see warning above) |

## Remember

- **Write and run tests for each sub-pattern before writing the next one** - this is the most important rule
- **Don't copy from existing patterns** - they use outdated conventions; trust this doc and linked docs
- Define ALL types in `schemas.tsx`: data types, Input/Output types for each pattern
- **Output types must include actions as `Stream<void>`** - tests will fail without this
- Use `Writable<Default<>>` for editable fields
- Work from leaf patterns → container patterns → main.tsx
- Only build polished UI after all tests pass
