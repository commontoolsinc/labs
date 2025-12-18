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

## Development Methodology

For non-trivial patterns, follow a layered approach rather than building everything at once. This makes each piece independently testable and isolates bugs to specific layers.

### Build in Layers

Pattern development should proceed through distinct layers, each verified before moving to the next:

**Layer 1: Data Model + Reactive Derivations**
- Define schemas/interfaces
- Build computed values and transformations
- Create debug UI showing all cell values (see below)
- Test via CLI: set inputs, verify computed outputs (see **ct** skill)

**Layer 2: Mutation Handlers**
- Add handlers one at a time
- Test each handler via `charm call` before adding more
- Debug UI shows before/after state
- Verify handlers don't break existing computeds

**Layer 3: Real UI**
- Replace debug UI with production interface
- Bidirectional bindings connect to already-verified cells
- If UI misbehaves, issue is isolated to UI layer

### Debug Visibility

Every sub-pattern should include inline debug display that shows cell values:

```typescript
// Debug UI panel - include in every sub-pattern during development
const DebugPanel = (
  <div style={{ fontFamily: "monospace", fontSize: "12px", padding: "1rem", background: "#f5f5f5", marginTop: "1rem" }}>
    <strong>Debug State</strong>
    <div>items count: {computed(() => items.length)}</div>
    <div>total: {totalAmount}</div>
    <div>filtered count: {computed(() => filteredItems.length)}</div>
    <hr />
    <details>
      <summary>Raw Data</summary>
      <pre>{computed(() => JSON.stringify(items.get(), null, 2))}</pre>
    </details>
  </div>
);

// Include in pattern UI
return {
  [UI]: (
    <div>
      {/* ... your actual UI ... */}
      {DebugPanel}
    </div>
  ),
};
```

This makes reactivity **visible**. When you `charm set` input data via CLI, you immediately see which computed values update. Strip debug UI when moving to production.

### Project Organization

Complex patterns get their own subfolder with numbered files indicating build order:

```
packages/patterns/expense-tracker/
├── 01-data-and-totals.tsx    # Layer 1: schemas + computeds
├── 02-budget-tracking.tsx    # Layer 1b: adds budget logic
├── 03-handlers.tsx           # Layer 2: mutation handlers
├── 04-full-ui.tsx            # Layer 3: production UI
└── schemas.tsx               # Shared type definitions (optional)
```

Each numbered file is a deployable sub-pattern. Build and verify each before moving to the next.

### CLI-First Testing

**Critical:** Use the ct CLI to verify each layer before touching browser.

See the **ct** skill's "Testing Patterns via CLI" section for the complete workflow, but the key principle is:

**Use `setsrc` not `new`** after initial deployment. This updates the existing charm rather than creating duplicates that clutter the space.

```bash
# First deployment
deno task ct charm new 01-data-and-totals.tsx -i claude.key -a URL -s space
# Note the charm ID

# All subsequent iterations
deno task ct charm setsrc <charm-id> 01-data-and-totals.tsx -i claude.key -a URL -s space
```

### Session Continuity

**Important:** If context compacts during pattern development, immediately reload the **pattern-dev** and **ct** skills before continuing work.

## Building a New Pattern

**Before you start:** Review the Development Methodology section above. For non-trivial patterns (multiple data types, computed values, handlers), follow the layered approach rather than building everything at once.

### For Simple Patterns (single concern)

Follow Steps 1-4 below for straightforward patterns.

### For Complex Patterns (multiple concerns)

Follow the layered methodology:
1. Create project subfolder: `packages/patterns/[name]/`
2. Build Layer 1: data + computeds + debug UI
3. Deploy, test via CLI (see **ct** skill)
4. Build Layer 2: handlers, test via CLI
5. Build Layer 3: production UI
6. Final deployment

---

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
