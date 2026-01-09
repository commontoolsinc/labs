# Pattern Development Workflow Guide

This guide covers high-level workflow patterns and best practices for developing patterns, complementing the theory in `docs/common/*.md`.

**For ct command syntax and usage**, use the **ct** skill.

## Development Workflow

### Iterative Development Cycle

**Philosophy: Start Simple, Iterate Fast**

1. **Write minimal pattern** - Basic types, minimal UI, single feature
2. **Deploy and test** - Use ct skill for deployment commands
3. **Inspect and verify** - Use ct skill for inspection commands
4. **Iterate with updates** - Use `deno task ct charm setsrc` for fast updates (via ct skill)
5. **Add next feature** - One at a time, repeat cycle

**Why this works:**
- Catch errors early when the codebase is small
- Understand each feature's behavior before adding complexity
- Faster debugging with smaller change sets

### Pattern Development Order

**Recommended sequence:**

1. **Define schemas** - TypeScript interfaces with `Default<>` types
2. **Basic UI** - Static rendering without interactivity
3. **Bidirectional binding** - Use `$prop` for simple value updates
4. **Handlers** - Add for structural changes (adding/removing items)
5. **Derived state** - Use `derive()` for computed values
6. **Composition** - Link with other charms (via ct skill)

**Anti-pattern:** Building everything at once before first deployment.

## Common Development Patterns

### Pattern: Simple List with Add/Remove

**Step-by-step:**

1. Define Item and Input schemas
2. Render static list
3. Add `ct-checkbox` with bidirectional binding for `done` state
4. Add handler for adding items (structural change)
5. Add handler for removing items (structural change)
6. Add derived cell for filtering (completed vs pending)

**See:** `packages/patterns/` for working examples.

### Pattern: Linked Data Flow

**Workflow:**

1. Build source pattern (produces data)
2. Build target pattern (consumes data)
3. Deploy both as separate charms (use ct skill)
4. Link them together (use ct skill)
5. Test reactive updates

**Key insight:** Build and test patterns independently first, then link.

### Pattern: Multi-File Organization

**When your pattern grows beyond ~200 lines:**

```
patterns/feature/
  main.tsx       # Entry point, exports default recipe
  schemas.tsx    # Shared TypeScript interfaces
  handlers.tsx   # Handler functions
  components.tsx # Reusable UI pieces
  utils.tsx      # Pure helper functions
```

**Best practices:**
- Export shared schemas for reuse across patterns
- Use relative imports
- Test main.tsx, ct bundles dependencies automatically
- Keep each file focused on one concern

## Debugging Workflow

### Type Error → Solution Mapping

**Process:**

1. Read TypeScript error message
2. Identify category:
   - Style-related? → See `docs/components/*`
   - Handler types? → See `handler()` docs
   - Cell operations? → See `docs/concepts/*`
3. Find similar example in `packages/patterns/`
4. Apply fix
5. Verify with `deno task ct dev --no-run` (via ct skill)

### Runtime Error → Solution Mapping

**Common patterns:**

- **Nothing renders** → Check JSX syntax, verify `[UI]` is returned
- **Data doesn't update** → Check `$` prefix for bidirectional binding
- **Handler not called** → Verify event name matches component (e.g., `onct-send`)
- **Crash on interaction** → Check Cell types in handler parameters

**Debugging technique:** Simplify pattern to minimal reproduction, then add features back one at a time.

## Best Practices

### DO

- **Start with working example** from `packages/patterns/` and modify
- **Use bidirectional binding** (`$prop`) for simple value updates
- **Keep handlers focused** - One clear purpose per handler
- **Export shared schemas** - Prevent type mismatches between linked charms
- **Deploy early and often** - Catch issues when codebase is small
- **Read the docs** - Don't guess, `docs/common/*.md` has answers

### DON'T

- **Don't build everything before testing** - Deploy incrementally
- **Don't use handlers for simple updates** - Use `$prop` bidirectional binding
- **Don't access DOM directly** - Use cells and reactive patterns
- **Don't guess at types** - Check `handler()` docs for correct Cell types
- **Don't create new patterns for everything** - Check if existing pattern + linking solves it

## Multi-Pattern Architectures

### Composition Pattern

**Instead of one large pattern:**
```
[Monolithic Pattern doing everything]
```

**Build multiple focused patterns:**
```
[Input Form] → [Validator] → [Storage]
                                 ↓
                             [Notifier]
```

**Benefits:**
- Easier to test each piece
- Reusable components
- Clearer data flow
- Simpler debugging

**Implementation:** Deploy each pattern separately, link via ct skill.

### Schema Sharing Strategy

**Problem:** Type mismatches between linked charms.

**Solution:** Export shared schema file.

```typescript
// schemas.tsx
export interface Task {
  id: string;
  title: string;
  done: Default<boolean, false>;
}

// producer.tsx
import { Task } from "./schemas.tsx";
export default recipe<{}, { tasks: Task[] }>(...);

// consumer.tsx
import { Task } from "./schemas.tsx";
export default recipe<{ tasks: Task[] }, ...>(...);
```

Both patterns share the exact same type definition.

## Performance Patterns

### Efficient Updates

**Prefer:**
- Bidirectional binding for individual field updates
- Handlers for batch operations

**Avoid:**
- Handlers for every keystroke
- Rebuilding entire arrays when modifying one element

### Minimize Derived Calculations

**Good:**
```typescript
const completedCount = derive(items, list =>
  list.filter(i => i.done).length
);
```

**Expensive:**
```typescript
const statistics = derive(items, list => {
  // Complex calculations on every item change
  return expensiveAnalysis(list);
});
```

Use `derive()` judiciously for expensive operations.

## Development Tips

### Finding Examples

**Workflow:**
1. Check `packages/patterns/INDEX.md` for catalog
2. Find pattern similar to your use case
3. Read the source code
4. Copy structure, adapt to your needs

### Using ct Effectively

**Fast iteration:**
- Deploy once with `deno task ct charm new`
- Update repeatedly with `deno task ct charm setsrc`
- Inspect with `deno task ct charm inspect`

**See ct skill for all command details.**

### Common Gotchas

1. **Forgetting `$` prefix** - Data won't update
2. **Wrong Cell type in handler** - Type errors
3. **Conditionals in JSX** - Use `ifElse()` instead
4. **Calling `llm()` from handler** - Only works in recipe body

**Solution:** Read the relevant `docs/common/*.md` file.

## Resources

When you need details:

| Question | Resource |
|----------|----------|
| How do cells work? | `docs/common/CELLS_AND_REACTIVITY.md` |
| Common pattern examples? | `docs/common/PATTERNS.md` |
| Handler type errors? | `docs/common/PATTERNS.md` |
| Component props? | `docs/common/COMPONENTS.md` |
| ct commands? | **ct** skill |
| Working code? | `packages/patterns/` |

## Remember

- **High-level workflows** - This guide for patterns and methodology
- **ct commands** - Use **ct** skill for command syntax
- **Concepts and theory** - Read `docs/common/*.md`
- **Working examples** - Look in `packages/patterns/`
- **Start simple** - One feature at a time
