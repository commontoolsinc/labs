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
2. **Read the core documentation** - These two docs are essential; read them before starting:
   - `docs/common/PATTERNS.md` - Main tutorial with examples and common patterns
   - `docs/common/CELLS_AND_REACTIVITY.md` - Cell system, computed(), lift(), frame-based execution
3. **Reference docs as needed:**
   - `docs/common/COMPONENTS.md` - UI components and bidirectional binding
   - `docs/common/TYPES_AND_SCHEMAS.md` - Type system, Cell<> vs OpaqueRef<>
   - `docs/common/DEBUGGING.md` - Error reference and troubleshooting
4. **Check example patterns** - Look in `packages/patterns/` for working examples

## Quick Decision Tree

**What do you want to do?**

→ **Create a new pattern** → Go to "Starting a New Pattern" (decide structure FIRST)
→ **Modify existing pattern** → Go to "Modifying Patterns"
→ **Fix pattern errors** → Go to "Debugging Patterns"
→ **Deploy/link charms** → Use **ct** skill
→ **Understand pattern concepts** → Read `docs/common/PATTERNS.md` and `CELLS_AND_REACTIVITY.md`

## Starting a New Pattern

Before writing any code, decide which approach to use:

**Use Pattern Composition if ANY of these apply:**
- Multiple data types (e.g., Card + Column, Note + Folder, Expense + Budget)
- 3+ computed values
- Distinct UI areas (sidebar + main content, list + editor panel)
- You want to test data logic separately from UI
- The pattern was described with a folder structure

**For Composition patterns, create structure FIRST:**
```bash
mkdir -p packages/patterns/[name]
touch packages/patterns/[name]/schemas.tsx
```

**Define all types in `schemas.tsx` before writing any pattern code.** This file is the anchor - all other files import from it.

For simple single-file patterns (counter, basic list), skip this and go directly to "Building a New Pattern" below.

## Development Methodology

Follow a layered approach rather than building everything at once. This makes each piece independently testable and isolates bugs to specific layers.

### Two Development Approaches

**Approach A: Single-File Evolution** (simple patterns only)
- One file that evolves through git commits
- Build incrementally: schemas → computeds → handlers → UI
- Use `setsrc` to update the same deployed charm
- Git history provides rollback points

**Approach B: Pattern Composition** (use for most real patterns)
- Shared schemas in `schemas.tsx` (created FIRST)
- Sub-patterns that can be independently tested
- Main pattern composes sub-patterns, passing shared cells
- Use `charm new` to deploy sub-patterns for isolated testing

### Build in Layers

Whether using single-file or composition, build in this order:

**Layer 1: Data Model + Reactive Derivations**
- Define schemas/interfaces
- Build computed values and transformations
- Create debug UI showing all cell values
- Test via CLI: set inputs, verify computed outputs
- **Read:** `PATTERNS.md`, `CELLS_AND_REACTIVITY.md`

**Layer 2: Mutation Handlers**
- Add handlers one at a time
- Test each handler via `charm call` before adding more
- Debug UI shows before/after state
- **Read:** `TYPES_AND_SCHEMAS.md` for handler typing (especially `Stream<T>` for Output interfaces)

**Layer 3: Real UI**
- Replace debug UI with production interface
- Bidirectional bindings connect to already-verified cells
- **Read:** `COMPONENTS.md` for component reference

### Debug Visibility

Include inline debug display showing cell values during development. This makes reactivity visible - you can see which computed values update when inputs change. Strip debug UI when moving to production.

See `packages/patterns/` for examples of debug panels.

### Project Organization

**Single-File Evolution:**
```
packages/patterns/expense-tracker/
└── expense-tracker.tsx     # Single file, evolves through layers via git commits
```

**Pattern Composition:**
```
packages/patterns/expense-tracker/
├── schemas.tsx           # Shared types
├── data-view.tsx         # Sub-pattern: computeds + display
├── expense-form.tsx      # Sub-pattern: form + handlers
└── main.tsx              # Composes sub-patterns, passes shared cells
```

Each sub-pattern imports from `schemas.tsx` and can be deployed independently. See `PATTERNS.md` Level 4 for composition examples.

### Version Control

- Create a new git branch: `git checkout -b pattern/[name]`
- Commit after each successful phase (verified via CLI)
- Git commits are your rollback points - each should represent a working state

### CLI-First Testing

Use the ct CLI to verify each layer before touching browser. See **ct** skill for:
- `charm new` to deploy, `setsrc` to update
- `charm get/set/call` to test data and handlers
- `charm inspect` to view full state

### Session Continuity

If context compacts during pattern development, immediately reload the **pattern-dev** and **ct** skills before continuing work.

## Building a New Pattern

**Before you start:** Review the Development Methodology section above.

### For Simple Patterns

See `PATTERNS.md` Level 1-2 for complete examples. The basic structure:

```typescript
/// <cts-enable />
import { Default, NAME, pattern, UI } from "commontools";

interface Input { items: Default<Item[], []>; }

export default pattern<Input, Input>(({ items }) => ({
  [NAME]: "My Pattern",
  [UI]: <div>{items.map(item => <div>{item.title}</div>)}</div>,
  items,
}));
```

### For Complex Patterns

**You should have already created the folder and `schemas.tsx`** (see "Starting a New Pattern" above).

Then follow the layered methodology:
1. Define types in `schemas.tsx`
2. Build Layer 1: data + computeds + debug UI in first pattern file
3. Deploy, test via CLI
4. Build Layer 2: handlers, test via CLI
5. Build Layer 3: production UI

### Key Principles

- **Bidirectional binding (`$prop`)** for simple value updates
- **Handlers** for structural changes, validation, side effects
- **Test with CLI** before touching browser

See `PATTERNS.md` for complete examples at each level.

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

1. **Check TypeScript errors first:** `deno task ct dev pattern.tsx --no-run`
2. **Consult `DEBUGGING.md`** - comprehensive error reference with solutions
3. **Use CLI inspection:** `charm inspect`, `charm get` (see **ct** skill)
4. **Check examples:** `packages/patterns/` for similar patterns

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

Handlers have **two-step binding**: define with `handler<EventType, StateType>`, then bind with state only.

```typescript
const addItem = handler<{ detail: { message: string } }, { items: Cell<Item[]> }>(
  ({ detail }, { items }) => { items.push({ title: detail.message }); }
);

<ct-message-input onct-send={addItem({ items })} />  // Bind with state only
```

**Key rules:**
- Pass **state only** when binding - event data comes at runtime
- For test buttons with hardcoded data, use **inline handlers**: `onClick={() => items.push(...)}`
- A bound handler IS a `Stream<T>` - don't use `Stream.of()` or `.subscribe()`
- Use `Cell<T[]>` in handler state, not `Cell<OpaqueRef<T>[]>`

See `PATTERNS.md` for handler patterns, `TYPES_AND_SCHEMAS.md` for Stream typing, `DEBUGGING.md` for common errors.

### Reactive Transformations

**Use `computed()` by default** - it handles closures automatically:

```typescript
const filteredItems = computed(() => items.filter(item => !item.done));
const totalAmount = computed(() => expenses.get().reduce((sum, e) => sum + e.amount, 0));
```

**Key rules:**
- `computed()` handles closures automatically via CTS transformer
- `lift()` requires passing all deps as object parameter: `lift((args) => ...)({ cell1, cell2 })`
- Passing cells directly to `lift()` returns stale/empty data

See `CELLS_AND_REACTIVITY.md` for details on frame-based execution and lift() limitations.

## Multi-File Patterns

See Project Organization in Development Methodology above. Key points:
- Use relative imports: `import { Schema } from "./schemas.tsx"`
- ct bundles all dependencies automatically on deployment
- Export shared schemas to avoid mismatches between linked charms

See `PATTERNS.md` Level 3-4 for linking and composition patterns.

## Documentation Map

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

## Remember

- Read docs before building - start with `PATTERNS.md` and `CELLS_AND_REACTIVITY.md`
- Check `packages/patterns/` for working examples
- Use **ct** skill for deployment commands
- Start simple, test incrementally, use bidirectional binding when possible
