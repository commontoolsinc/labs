---
name: pattern-dev
description: Guide for developing CommonTools patterns (TypeScript modules that define reactive data transformations with UI). Use this skill when creating patterns, modifying existing patterns, or working with the pattern framework. Triggers include requests like "build a pattern", "fix this pattern error", "deploy this pattern", or questions about handlers and reactive patterns.
---

# Pattern Development

## Overview

Develop CommonTools patterns using the `ct` CLI and the reactive pattern framework. Patterns are TypeScript/JSX programs that define data transformations with interactive UIs. They can be deployed and linked together for complex workflows.

## When to Use This Skill

Use this skill when:
- Building new patterns from scratch
- Modifying existing patterns
- Working with multi-file pattern structures

For ct CLI commands, run `deno task ct --help`.

## Prerequisites

Before starting pattern development:

1. **Know the ct CLI** - Run `deno task ct --help` to learn available commands
2. **Read the core documentation** - See `docs/common/` for concepts and patterns
3. **Check example patterns** - Look in `packages/patterns/` for working examples

## Quick Decision Tree

**What do you want to do?**

→ **Create a new pattern** → Go to "Starting a New Pattern"
→ **Modify existing pattern** → Go to "Modifying Patterns"
→ **Write tests for a pattern** → Go to "Automated Pattern Tests"
→ **Understand a concept** → Check `docs/common/concepts/`
→ **Debug an error** → Check `docs/development/debugging/`

## Key Principles

### Object Graph, Not Database

The reactive fabric uses direct references between objects. When you have a reference to an object, you *have* that object—use `equals()` for identity comparison:

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

- **Use `action()`** when the handler closes over local state created in the pattern body
- **Use `handler()`** when the same logic needs different bindings (e.g., per-item operations in a list)

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

### Use Default<> for All Optional Fields

**Always use `Default<T, value>` for fields that will be displayed in UI or used in computations.** Without defaults, fields are `undefined` at runtime until explicitly set, causing errors when your pattern tries to render or compute.

```tsx
// schemas.tsx
import { Default } from "commontools";

interface Ingredient {
  name: string;                         // Required - no default
  amount: Default<string, "">;          // Defaults to empty string
  optional: Default<boolean, false>;    // Defaults to false
}

interface Recipe {
  title: string;
  ingredients: Default<Ingredient[], []>;  // Defaults to empty array
  rating: Default<number | null, null>;    // Defaults to null
}
```

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

Given these schemas:

```tsx
// schemas.tsx
interface Ingredient {
  name: string;
  amount: string;
  optional: boolean;
}

interface Recipe {
  title: string;
  ingredients: Ingredient[];
  instructions: string;
}

interface RecipeBook {
  recipes: Recipe[];
}
```

Create sub-patterns for each level:

```
packages/patterns/recipe-manager/
├── schemas.tsx           # Types above (create FIRST)
├── ingredient.tsx        # Sub-pattern: single ingredient display/edit
├── ingredient.test.tsx   # Tests for ingredient
├── recipe.tsx            # Sub-pattern: single recipe (composes ingredients)
├── recipe.test.tsx       # Tests for recipe
└── main.tsx              # Recipe book (composes recipes, minimal logic)
```

**ingredient.tsx** handles display/editing of one ingredient:
```tsx
import { pattern, UI } from "commontools";
import type { Ingredient } from "./schemas.tsx";

export default pattern<{ ingredient: Ingredient }>(({ ingredient }) => {
  return {
    [UI]: (
      <ct-hstack>
        <ct-input $value={ingredient.amount} />
        <ct-input $value={ingredient.name} />
        <ct-checkbox $checked={ingredient.optional}>Optional</ct-checkbox>
      </ct-hstack>
    ),
    ingredient,
  };
});
```

**recipe.tsx** composes ingredient patterns:
```tsx
import { pattern, UI } from "commontools";
import type { Recipe } from "./schemas.tsx";
import Ingredient from "./ingredient.tsx";

export default pattern<{ recipe: Recipe }>(({ recipe }) => {
  return {
    [UI]: (
      <ct-card>
        <ct-input $value={recipe.title} slot="header" />
        {recipe.ingredients.map((ing) => Ingredient({ ingredient: ing }))}
        <ct-textarea $value={recipe.instructions} />
      </ct-card>
    ),
    recipe,
  };
});
```

**main.tsx** composes recipe patterns with minimal logic:
```tsx
import { pattern, UI, NAME } from "commontools";
import type { RecipeBook } from "./schemas.tsx";
import Recipe from "./recipe.tsx";

export default pattern<{ book: RecipeBook }>(({ book }) => {
  return {
    [NAME]: "Recipe Manager",
    [UI]: (
      <ct-screen>
        {book.recipes.map((recipe) => Recipe({ recipe }))}
      </ct-screen>
    ),
    book,
  };
});
```

### Project Structure Summary

```
packages/patterns/[name]/
├── schemas.tsx           # Shared types (create FIRST)
├── [item].tsx            # Sub-pattern for leaf-level items
├── [item].test.tsx       # Tests for item sub-pattern
├── [container].tsx       # Sub-pattern that composes items
├── [container].test.tsx  # Tests for container sub-pattern
└── main.tsx              # Top-level composition (minimal logic)
```

Each sub-pattern imports from `schemas.tsx` and can be deployed and tested independently. The `main.tsx` should primarily compose sub-patterns, not contain significant logic itself.

## Development Methodology

Build in layers rather than all at once. This makes each piece independently testable.

### Layer 1: Data Model + Computed Values

1. Define types in `schemas.tsx`
2. Build computed values (derived data)
3. Test via CLI: set inputs, verify computed outputs

### Layer 2: Actions

1. Define action event types in `schemas.tsx` if needed
2. Add actions one at a time
3. **Export actions in the return object** for testing

### Layer 3: Interactive CLI Verification

**Do this for EACH sub-pattern as you build it, not just main.tsx.**

Before writing automated tests, deploy and verify interactively:

1. **Learn the CLI**: Run `deno task ct --help` and `deno task ct charm --help`
2. **Deploy the sub-pattern**: `deno task ct charm new packages/patterns/[name]/ingredient.tsx`
3. **Inspect state**: `deno task ct charm inspect`
4. **Test actions**: Use `deno task ct charm call` to invoke exported actions, then `deno task ct charm step` to process
5. **Verify outputs**: Check computed values update correctly

Repeat for each sub-pattern (e.g., `ingredient.tsx`, then `recipe.tsx`, then `main.tsx`). This catches issues early and builds CLI familiarity.

### Layer 4: Automated Tests (REQUIRED before UI)

**Build and test sub-patterns one at a time.** The workflow is:

1. Write `ingredient.tsx` → Write `ingredient.test.tsx` → **Run tests, fix until passing**
2. Write `recipe.tsx` → Write `recipe.test.tsx` → **Run tests, fix until passing**
3. Write `main.tsx` → Write `main.test.tsx` → **Run tests, fix until passing**

**Do NOT move to the next sub-pattern until the current one's tests pass.** This prevents cascading errors and makes debugging easier.

```bash
# Create test files for each sub-pattern
touch packages/patterns/[name]/ingredient.test.tsx
touch packages/patterns/[name]/recipe.test.tsx
touch packages/patterns/[name]/main.test.tsx
```

```tsx
/// <cts-enable />
import { Cell, action, computed, pattern } from "commontools";
import MyPattern from "./main.tsx";

export default pattern(() => {
  const subject = MyPattern({ /* initial state */ });

  const action_do_something = action(() => {
    subject.someHandler.send();
  });

  const assert_initial_state = computed(() => subject.value === 0);
  const assert_after_action = computed(() => subject.value === 1);

  return {
    tests: [
      { assertion: assert_initial_state },
      { action: action_do_something },
      { assertion: assert_after_action },
    ],
  };
});
```

Run tests: `deno task ct test packages/patterns/[name]/main.test.tsx`

See `docs/common/workflows/pattern-testing.md` for the full guide.

### Layer 5: Build UI

**Before writing UI code:**
1. Read `docs/common/components/COMPONENTS.md` for available components
2. Search `packages/patterns/` for similar UI patterns (e.g., grep for `ct-tabs`, `ct-card`, layout patterns)
3. Check example patterns for layout structures (ct-screen, ct-hstack, ct-vstack with flex)

**Then implement:**
1. Create UI to display and interact with the data and actions
2. Bidirectional bindings connect to already-verified reactive objects

### Debug Visibility

Include temporary debug UI element(s) showing all computed values during development. This makes reactivity visible - you can see which computed values update when inputs change. Strip debug UI when moving to production.

### Version Control

- Create a new git branch: `git checkout -b pattern/[name]`
- Commit after each successful layer (verified via CLI)
- Each commit should represent a working state

### Using the ct CLI

When deploying and interacting with patterns, explore the CLI documentation thoroughly:

```bash
# Learn available commands
deno task ct --help

# Get help for specific subcommands
deno task ct charm --help
deno task ct test --help
```

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
| Working examples | `packages/patterns/` |

## Remember

- Define types in `schemas.tsx` first
- **Use `Default<>` for all optional fields** - prevents undefined errors at runtime
- **Consult docs when using an API feature for the first time**
- Build and test in layers (data → actions → CLI verify → tests → UI)
- **Verify interactively with CLI before writing tests** (Layer 3)
- **Write automated tests before building UI** (Layer 4 before Layer 5)
- Use `deno task ct --help` to explore CLI commands
- Check `packages/patterns/` for working examples
