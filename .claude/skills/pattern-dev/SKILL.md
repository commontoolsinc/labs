---
name: pattern-dev
description: Guide for developing CommonTools patterns (TypeScript modules that define reactive data transformations with UI). Use this skill when creating patterns, modifying existing patterns, linking patches (instantiated patterns), debugging pattern errors, or working with the pattern framework. Triggers include requests like "build a pattern", "fix this pattern error", "deploy this charm/patch", "link these charms", or questions about handlers, cells, and reactive patterns.
---

# Pattern Development

## Overview

Develop CommonTools patterns using the `ct` CLI and the reactive pattern framework. Patterns are TypeScript/JSX programs that define data transformations with interactive UIs, deployed as "charms" that can be linked together for complex workflows.

## When to Use This Skill

Use this skill when:
- Building new patterns from scratch
- Modifying or debugging existing patterns
- Understanding pattern framework concepts (cells, handlers, computed, lift)
- Troubleshooting type errors or runtime issues
- Working with multi-file pattern structures

**For ct commands** (deploying, linking, inspecting charms), use the **ct** skill instead.

## Prerequisites

Before starting pattern development:

1. **Know the ct CLI** - Use the **ct** skill for ct command reference
2. **Read the documentation** - Key docs to reference:
   - `docs/common/PATTERNS.md` - Main tutorial with examples and common patterns
   - `docs/common/CELLS_AND_REACTIVITY.md` - Cell system, computed(), reactivity
   - `docs/common/COMPONENTS.md` - UI components and bidirectional binding
   - `docs/common/TYPES_AND_SCHEMAS.md` - Type system, Cell<> vs OpaqueRef<>
   - `docs/common/DEBUGGING.md` - Error reference and troubleshooting
3. **Check example patterns** - Look in `packages/patterns/` for working examples

## Quick Decision Tree

**What do you want to do?**

→ **Create a new pattern** → Go to "Building a New Pattern"
→ **Modify existing pattern** → Go to "Modifying Patterns"
→ **Fix pattern errors** → Go to "Debugging Patterns"
→ **Deploy/link charms** → Use **ct** skill
→ **Understand pattern concepts** → Read `docs/common/PATTERNS.md` and `CELLS_AND_REACTIVITY.md`

## Building a New Pattern

### Step 1: Start Simple

Begin with minimal viable pattern:

```typescript
/// <cts-enable />
import { Default, NAME, pattern, UI } from "commontools";

interface Item {
  title: string;
  done: Default<boolean, false>;
}

interface Input {
  items: Default<Item[], []>;
}

export default pattern<Input, Input>(({ items }) => {
  return {
    [NAME]: "My Pattern",  // Optional: displayed in UI
    [UI]: (
      <div>
        {items.map((item) => (
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
{items.map((item) => (
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

Use the **ct** skill for testing with `deno task ct dev` and deploying with `deno task ct charm new/setsrc`.

## Modifying Patterns

### Getting Pattern Source

Use the **ct** skill to retrieve source:
```bash
# Use ct charm getsrc (see ct skill)
```

### Making Changes

1. Edit the pattern file
2. Check syntax: Use **ct** skill for `deno task ct dev pattern.tsx --no-run`
3. Update charm: Use **ct** skill for `deno task ct charm setsrc`

## Debugging Patterns

### Common Error Categories

**Type Errors** (see `TYPES_AND_SCHEMAS.md` and `PATTERNS.md` for details):
- Wrong style syntax (object vs string, see `COMPONENTS.md`)
- Using `Cell<OpaqueRef<T>[]>` instead of `Cell<T[]>` in handlers
- Forgetting `Cell<>` wrapper in handler state types

**Runtime Errors** (see `PATTERNS.md` and `DEBUGGING.md` for details):
- DOM access (use cells instead)
- Conditionals in JSX (use `ifElse()`)
- Calling `generateText()`/`generateObject()` from handlers (only works in pattern body)

**Data Not Updating** (see `COMPONENTS.md` for details):
- Forgot `$` prefix for bidirectional binding
- Handler event name mismatch
- Cell not passed correctly to handler

### Debugging Process

1. **Check TypeScript errors first** - Use **ct** skill for `deno task ct dev pattern.tsx --no-run`
2. **Consult the docs** - Match error pattern to relevant doc:
   - Type errors → `TYPES_AND_SCHEMAS.md`
   - Component issues → `COMPONENTS.md`
   - Pattern questions → `PATTERNS.md`
   - Reactivity issues → `CELLS_AND_REACTIVITY.md`
   - General debugging → `DEBUGGING.md`
3. **Inspect deployed charm** - Use **ct** skill for inspection commands
4. **Check examples** - Look in `packages/patterns/` for similar patterns

### Quick Error Reference

| Error Message | Check |
|---------------|-------|
| "Type 'string' is not assignable to type 'CSSProperties'" | Using string style on HTML element - See `COMPONENTS.md` |
| Handler type mismatch | Check `Cell<T[]>` vs `Cell<Array<Cell<T>>>` - See `TYPES_AND_SCHEMAS.md` |
| Data not updating | Missing `$` prefix or wrong event name - See `COMPONENTS.md` |

## Key Concepts Summary

### Direct Cell<> Binding

**Use `$` prefix to pass a raw Cell to a component (for deep interop, see `lit-component` skill):**

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

See `PATTERNS.md` for complete handler patterns.

### Reactive Transformations

**computed() for derived values:**

```typescript
const filteredItems = computed(() =>
  items.filter(item => !item.done)
);
```

**lift() for reusable functions:**

```typescript
const groupByCategory = lift((items: Item[]) => {
  // grouping logic
});

const grouped = groupByCategory(items);
```

See `CELLS_AND_REACTIVITY.md` for reactive programming details.

## Multi-File Patterns

When building complex patterns across multiple files:

**Structure:**
```
patterns/feature/
  main.tsx       # Entry point
  schemas.tsx    # Shared types
  utils.tsx      # Helper functions
```

**Best Practices:**
- Use relative imports: `import { Schema } from "./schemas.tsx"`
- Export shared schemas for reuse
- ct bundles all dependencies automatically on deployment
- Export all sub-patterns and functions

**Common Pitfall:**
- Schema mismatches between linked charms
- Solution: Export shared schemas from common file

See `PATTERNS.md` Level 3-4 for linking and composition patterns.

## Development Tips

**DO:**
- Start simple, add features incrementally
- Use bidirectional binding when possible
- Reference `packages/patterns/` for examples
- Use `charm inspect` frequently when debugging (via **ct** skill)
- Read relevant doc files before asking questions

**DON'T:**
- Test syntax before deploying (unless deployment fails)
- Add multiple features before testing
- Use handlers for simple value updates

## Documentation Map

When working with patterns, consult these docs based on your task:

| Task | Read |
|------|------|
| Main tutorial and common patterns | `docs/common/PATTERNS.md` |
| Cells, reactivity, computed() | `docs/common/CELLS_AND_REACTIVITY.md` |
| Type system, Cell<> vs OpaqueRef<> | `docs/common/TYPES_AND_SCHEMAS.md` |
| Component usage and bidirectional binding | `docs/common/COMPONENTS.md` |
| Error reference and debugging | `docs/common/DEBUGGING.md` |
| LLM integration (generateObject, etc.) | `docs/common/LLM.md` |
| ct commands | Use **ct** skill |
| Working examples | `packages/patterns/` directory |

## Resources

### references/workflow-guide.md

High-level workflow patterns and best practices for pattern development. Consult for development methodology and common patterns.

## Remember

- **Use the ct skill** for ct commands and deployment details
- **Read `docs/common/` files** for pattern framework concepts - don't ask for duplicated information
- **Check `packages/patterns/`** for working examples before building from scratch
- **Start simple** - minimal viable pattern first, then add features
- **Bidirectional binding first** - only use handlers when truly needed
