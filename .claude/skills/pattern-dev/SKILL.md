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

### Project Structure

Here's a simple example:

```
packages/patterns/expense-tracker/
├── schemas.tsx           # Shared types (create FIRST)
├── data-view.tsx         # Sub-pattern: computeds + display
├── expense-form.tsx      # Sub-pattern: form + handlers
└── main.tsx              # Composes sub-patterns, passes shared Writable/Cell-like objects
```

Each sub-pattern imports from `schemas.tsx` and can be deployed independently for testing.

## Development Methodology

Build in layers rather than all at once. This makes each piece independently testable.

### Layer 1: Data Model + Computed Values

1. Define types in `schemas.tsx`
2. Build computed values (derived data)
3. Test via CLI: set inputs, verify computed outputs

### Layer 2: Mutation Handlers

1. Define handler event types in `schemas.tsx`
2. Add handlers one at a time
3. **Export handlers in the return object** for CLI testing
4. Test each handler via `deno task ct charm call` and `deno task ct charm step`

See `docs/common/workflows/handlers-cli-testing.md` for the full workflow.

### Layer 3: Build UI

**Before writing UI code:**
1. Read `docs/common/components/COMPONENTS.md` for available components
2. Search `packages/patterns/` for similar UI patterns (e.g., grep for `ct-tabs`, `ct-card`, layout patterns)
3. Check example patterns for layout structures (ct-screen, ct-hstack, ct-vstack with flex)

**Then implement:**
1. Create UI to display and interact with the data and handlers
2. Bidirectional bindings connect to already-verified reactive objects

### Debug Visibility

Include temporary debug UI element(s) showing all computed values during development. This makes reactivity visible - you can see which computed values update when inputs change. Strip debug UI when moving to production.

### Version Control

- Create a new git branch: `git checkout -b pattern/[name]`
- Commit after each successful layer (verified via CLI)
- Each commit should represent a working state

### CLI-First Testing

Use the ct CLI to verify each layer before touching the browser:
- `deno task ct charm new` to deploy
- `deno task ct charm setsrc` to update
- `deno task ct charm get/set/call` to test data and handlers
- `deno task ct charm inspect` to view full state

To learn more about using the ct CLI, run `deno task ct --help`.

### Automated Pattern Tests

For patterns with complex state transitions or logic you want to verify automatically, write a test pattern:

```bash
# Create test file alongside your pattern
touch packages/patterns/[name]/main.test.tsx
```

Test patterns use `action()` to trigger events and `computed()` for assertions:

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

Run with: `deno task ct test packages/patterns/[name]/main.test.tsx`

See `docs/common/workflows/pattern-testing.md` for the full guide.

**When to use automated tests vs CLI testing:**
- **CLI testing**: Quick iteration, exploring behavior, one-off verification
- **Automated tests**: Complex state machines, regression prevention, documenting expected behavior

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
- **Consult docs when using an API feature for the first time**
- Build and test in layers (data → handlers → UI)
- Test with CLI before browser
- Check `packages/patterns/` for working examples
