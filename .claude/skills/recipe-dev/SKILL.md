---
name: recipe-dev
description: Guide for developing CommonTools recipes (TypeScript patterns that define reactive data transformations with UI). Use this skill when creating recipes, modifying existing recipes, linking charms, debugging recipe errors, or working with the recipe framework. Triggers include requests like "build a recipe", "fix this recipe error", "deploy this charm", "link these charms", or questions about handlers, cells, and reactive patterns.
---

# Recipe Development

## Overview

Develop CommonTools recipes using the ct binary and the reactive recipe framework. Recipes are TypeScript/JSX programs that define data transformations with interactive UIs, deployed as "charms" that can be linked together for complex workflows.

## When to Use This Skill

Use this skill when:
- Building new recipes from scratch
- Modifying or debugging existing recipes
- Understanding recipe framework concepts (cells, handlers, derive, lift)
- Deploying and managing charms
- Linking charms together for data flow
- Troubleshooting type errors or runtime issues
- Working with multi-file recipe structures

## Prerequisites

Before starting recipe development:

1. **Know the ct binary** - Use the **ct** skill for ct command reference
2. **Read the documentation** - Key docs to reference:
   - `docs/common/RECIPES.md` - Core recipe concepts and best practices
   - `docs/common/PATTERNS.md` - Common recipe patterns with examples
   - `docs/common/HANDLERS.md` - Handler patterns and type guidance
   - `docs/common/COMPONENTS.md` - UI components and bidirectional binding
3. **Check example recipes** - Look in `packages/patterns/` for working examples

## Quick Decision Tree

**What do you want to do?**

→ **Create a new recipe** → Go to "Building a New Recipe"
→ **Modify existing recipe** → Go to "Modifying Recipes"
→ **Fix recipe errors** → Go to "Debugging Recipes"
→ **Deploy recipe as charm** → Use ct skill, see "Deployment Workflow"
→ **Link charms together** → Use ct skill for linking commands
→ **Understand recipe concepts** → Read `docs/common/RECIPES.md` and `PATTERNS.md`

## Building a New Recipe

### Step 1: Start Simple

Begin with minimal viable recipe:

```typescript
/// <cts-enable />
import { Default, NAME, OpaqueRef, recipe, UI } from "commontools";

interface Item {
  title: string;
  done: Default<boolean, false>;
}

interface Input {
  items: Default<Item[], []>;
}

export default recipe<Input, Input>("My Recipe", ({ items }) => {
  return {
    [NAME]: "My Recipe",
    [UI]: (
      <div>
        {items.map((item: OpaqueRef<Item>) => (
          <div>{item.title}</div>
        ))}
      </div>
    ),
    items,
  };
});
```

### Step 2: Add Interactivity

Add bidirectional binding for simple updates:

```typescript
{items.map((item: OpaqueRef<Item>) => (
  <ct-checkbox $checked={item.done}>
    {item.title}
  </ct-checkbox>
))}
```

**Golden Rule:** Use bidirectional binding (`$prop`) for simple value updates. Only use handlers for structural changes, validation, or side effects.

### Step 3: Add Handlers for Structural Changes

```typescript
import { Cell, handler } from "commontools";

const addItem = handler<
  { detail: { message: string } },
  { items: Cell<Item[]> }
>(({ detail }, { items }) => {
  const title = detail?.message?.trim();
  if (!title) return;

  items.push({ title, done: false });
});

// In UI
<ct-message-input
  placeholder="Add item..."
  onct-send={addItem({ items })}
/>
```

### Step 4: Test and Deploy

See "Deployment Workflow" section below.

## Modifying Recipes

### Getting Recipe Source

```bash
# Use ct skill commands to get source
./dist/ct charm getsrc --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] ./recipe.tsx
```

### Making Changes

1. Edit the recipe file
2. Check syntax (optional): `./dist/ct dev recipe.tsx --no-run`
3. Update charm: `./dist/ct charm setsrc --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] recipe.tsx`

## Debugging Recipes

### Common Error Categories

**Type Errors** (see `HANDLERS.md` for details):
- Missing `OpaqueRef<T>` annotation in `.map()`
- Wrong style syntax (object vs string, see `COMPONENTS.md`)
- Using `Cell<OpaqueRef<T>[]>` instead of `Cell<T[]>` in handlers
- Forgetting `Cell<>` wrapper in handler state types

**Runtime Errors** (see `RECIPES.md` for details):
- DOM access (use cells instead)
- Conditionals in JSX (use `ifElse()`)
- Calling `llm()` from handlers (only works in recipe body)

**Data Not Updating** (see `COMPONENTS.md` for details):
- Forgot `$` prefix for bidirectional binding
- Handler event name mismatch
- Cell not passed correctly to handler

### Debugging Process

1. **Check TypeScript errors first** - Run `./dist/ct dev recipe.tsx --no-run`
2. **Consult the docs** - Match error pattern to relevant doc:
   - Type errors → `HANDLERS.md`
   - Component issues → `COMPONENTS.md`
   - Pattern questions → `PATTERNS.md`
   - Core concepts → `RECIPES.md`
3. **Inspect deployed charm** - Use ct skill commands to inspect state
4. **Check examples** - Look in `packages/patterns/` for similar recipes

### Quick Error Reference

| Error Message | Check |
|---------------|-------|
| "Property X does not exist on type 'OpaqueRef<unknown>'" | Missing `OpaqueRef<T>` in `.map()` - See `HANDLERS.md` |
| "Type 'string' is not assignable to type 'CSSProperties'" | Using string style on HTML element - See `COMPONENTS.md` |
| Handler type mismatch | Check `Cell<T[]>` vs `Cell<Array<Cell<T>>>` - See `HANDLERS.md` |
| Data not updating | Missing `$` prefix or wrong event name - See `COMPONENTS.md` |

## Deployment Workflow

### Initial Deployment

```bash
# 1. Test syntax (optional)
./dist/ct dev recipe.tsx --no-run

# 2. Deploy to test space
./dist/ct charm new --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space test-space recipe.tsx
# Record the charm ID returned

# 3. Inspect deployed charm
./dist/ct charm inspect --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space test-space --charm [charm-id]
```

### Iteration Cycle

```bash
# Update existing charm (much faster than deploying new)
./dist/ct charm setsrc --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space test-space --charm [charm-id] recipe.tsx
```

**Note:** Don't pre-test syntax unless deployment fails. The deployment process validates automatically.

## Key Concepts Summary

### Bidirectional Binding

**Use `$` prefix for automatic two-way data binding:**

```typescript
<ct-checkbox $checked={item.done} />
<ct-input $value={item.title} />
<ct-select $value={item.category} items={...} />
```

**When NOT to use:** Need validation, side effects, or structural changes (use handlers).

See `COMPONENTS.md` for full details.

### Handlers

**Use for structural changes and side effects:**

```typescript
const removeItem = handler<
  unknown,
  { items: Cell<Array<Cell<Item>>>; item: Cell<Item> }
>((_event, { items, item }) => {
  const currentItems = items.get();
  const index = currentItems.findIndex(el => el.equals(item));
  if (index >= 0) {
    items.set(currentItems.toSpliced(index, 1));
  }
});
```

**Critical Rule:** Use `Cell<T[]>` in handler parameters, not `Cell<OpaqueRef<T>[]>`.

See `HANDLERS.md` for complete handler patterns.

### Reactive Transformations

**derive() for computed values:**

```typescript
const filteredItems = derive(items, (list) =>
  list.filter(item => !item.done)
);
```

**lift() for reusable functions:**

```typescript
const groupByCategory = lift((items: Item[]) => {
  // grouping logic
});

const grouped = groupByCategory(items);
```

See `RECIPES.md` for reactive programming details.

### Type Annotations

**Always annotate `.map()` parameters:**

```typescript
{items.map((item: OpaqueRef<Item>) => (
  <ct-checkbox $checked={item.done} />
))}
```

**Why:** TypeScript can't infer types for bidirectional binding without annotation.

See `PATTERNS.md` for common patterns.

## Multi-File Recipes

When building complex recipes across multiple files:

**Structure:**
```
recipes/feature/
  main.tsx       # Entry point
  schemas.tsx    # Shared types
  utils.tsx      # Helper functions
```

**Best Practices:**
- Use relative imports: `import { Schema } from "./schemas.tsx"`
- Export shared schemas for reuse
- ct bundles all dependencies automatically on deployment

**Common Pitfall:**
- Schema mismatches between linked charms
- Solution: Export shared schemas from common file

See `PATTERNS.md` Level 3-4 for linking and composition patterns.

## Development Tips

**DO:**
- Start simple, add features incrementally
- Use bidirectional binding when possible
- Reference `packages/patterns/` for examples
- Use `charm inspect` frequently when debugging
- Read relevant doc files before asking questions

**DON'T:**
- Test syntax before deploying (unless deployment fails)
- Add multiple features before testing
- Use handlers for simple value updates
- Forget `OpaqueRef<T>` annotations in `.map()`
- Duplicate content from `docs/common/` - reference it instead

## Documentation Map

When working with recipes, consult these docs based on your task:

| Task | Read |
|------|------|
| Understanding recipe structure | `docs/common/RECIPES.md` |
| Common patterns (lists, filtering, linking) | `docs/common/PATTERNS.md` |
| Handler type errors or patterns | `docs/common/HANDLERS.md` |
| Component usage and bidirectional binding | `docs/common/COMPONENTS.md` |
| ct binary commands | Use **ct** skill |
| Working examples | `packages/patterns/` directory |

## Resources

### references/workflow-guide.md

Practical ct command workflows for:
- Setting up development environment
- Development cycle (deploy, iterate, debug)
- Common tasks (modify, link, visualize)
- Debugging commands
- Multi-file recipe development
- Configuration management

Consult when you need practical command examples beyond theory.

## Quick Command Reference

```bash
# Test syntax
./dist/ct dev recipe.tsx --no-run

# Deploy new charm
./dist/ct charm new -i claude.key -a https://toolshed.saga-castor.ts.net/ -s space recipe.tsx

# Update existing charm
./dist/ct charm setsrc -i claude.key -a https://toolshed.saga-castor.ts.net/ -s space -c charm-id recipe.tsx

# Inspect charm
./dist/ct charm inspect -i claude.key -a https://toolshed.saga-castor.ts.net/ -s space -c charm-id

# For full ct command reference, use the ct skill
```

## Remember

- **Use the ct skill** for ct binary commands and deployment details
- **Read `docs/common/` files** for recipe framework concepts - don't ask for duplicated information
- **Check `packages/patterns/`** for working examples before building from scratch
- **Start simple** - minimal viable recipe first, then add features
- **Bidirectional binding first** - only use handlers when truly needed
