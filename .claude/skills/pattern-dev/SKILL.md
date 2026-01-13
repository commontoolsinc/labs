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
→ **Understand a concept** → Check `docs/common/concepts/`
→ **Debug an error** → Check `docs/development/debugging/`

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

1. Add handlers one at a time
2. Test each handler via `deno task ct charm call` and `deno task ct charm step` before adding more

### Layer 3: Build UI

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

## Documentation Map

| Topic | Location |
|-------|----------|
| Concepts (handler, computed, reactivity) | `docs/common/concepts/` |
| UI components and binding | `docs/common/components/` |
| Common patterns (conditionals, composition) | `docs/common/patterns/` |
| Debugging and errors | `docs/development/debugging/` |
| Working examples | `packages/patterns/` |

## Remember

- Define types in `schemas.tsx` first
- Build and test in layers (data → handlers → UI)
- Test with CLI before browser
- Check `packages/patterns/` for working examples
