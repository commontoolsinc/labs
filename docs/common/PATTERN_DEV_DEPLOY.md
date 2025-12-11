<!-- @reviewed 2025-12-10 docs-rationalization -->

# Pattern Development & Deployment Guide

This guide covers building, debugging, and deploying patterns using the CommonTools framework.

## Pattern Development

### Building a New Pattern

#### Step 1: Start Simple

Begin with a minimal viable pattern:

```typescript
/// <cts-enable />
import { Default, NAME, OpaqueRef, pattern, UI } from "commontools";

interface Item {
  title: string;
  done: Default<boolean, false>;
}

interface Input {
  items: Default<Item[], []>;
}

export default pattern<Input, Input>(({ items }) => {
  return {
    [NAME]: "My Pattern",
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

#### Step 2: Add Interactivity

Add bidirectional binding for simple updates:

```typescript
{items.map((item: OpaqueRef<Item>) => (
  <ct-checkbox $checked={item.done}>
    {item.title}
  </ct-checkbox>
))}
```

**Golden Rule:** Use bidirectional binding (`$prop`) for simple value updates. Only use handlers for structural changes, validation, or side effects.

#### Step 3: Add Handlers for Structural Changes

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

### Debugging Patterns

See [DEBUGGING.md](DEBUGGING.md) for comprehensive debugging guide with quick error reference.

#### Common Error Categories

**Type Errors:**

- Missing `Cell<>` for write access (see [TYPES_AND_SCHEMAS.md](TYPES_AND_SCHEMAS.md))
- Missing `OpaqueRef<T>` annotation in `.map()`
- Wrong style syntax (object vs string, see [COMPONENTS.md](COMPONENTS.md))
- Using `Cell<OpaqueRef<T>[]>` instead of `Cell<T[]>` in handlers

**Runtime Errors:**

- DOM access (use cells instead)
- Conditionals in JSX (use `ifElse()`)
- Calling `generateText()`/`generateObject()` from handlers (only works in pattern body)

**Reactivity Issues:**

- Forgot `$` prefix for bidirectional binding
- Need `computed()` for filters outside JSX (see [CELLS_AND_REACTIVITY.md](CELLS_AND_REACTIVITY.md))
- Handler event name mismatch

#### Debugging Process

1. **Check TypeScript errors first** - Run `deno task ct dev pattern.tsx --no-run`
2. **Consult [DEBUGGING.md](DEBUGGING.md)** - Use quick error reference table
3. **Check relevant docs:**
   - Type errors → [TYPES_AND_SCHEMAS.md](TYPES_AND_SCHEMAS.md)
   - Reactivity issues → [CELLS_AND_REACTIVITY.md](CELLS_AND_REACTIVITY.md)
   - Component questions → [COMPONENTS.md](COMPONENTS.md)
   - Pattern examples → [PATTERNS.md](PATTERNS.md)
4. **Inspect deployed charm** - Use ct commands to inspect state
5. **Check examples** - Look in `packages/patterns/` for similar patterns

### Multi-File Patterns

When building complex patterns across multiple files:

**Structure:**

```sh
patterns/feature/
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
- Solution: Export shared schemas from a common file

See `PATTERNS.md` Level 3-4 for linking and composition patterns.

### Development Tips

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

## Testing

After developing the charm, if you have Playwright MCP, you must test the charm with it unless the user asks you not to.

### Navigate to the Charm URL

```javascript
await page.goto("http://localhost:8000/<SPACE_NAME>/<CHARM_ID>");
```

Note: Server may be `https://toolshed.saga-castor.ts.net` instead.

### Register/Login (First Time Only)

When you first visit, you'll see a login page. Register with a passphrase:

1. Click the "➕ Register" button
2. Click the "🔑 Generate Passphrase" button
3. Click the "🔒 I've Saved It - Continue" button

This will log you in and load the charm.

### Test the Charm

Once logged in, you can interact with the charm using Playwright commands.

Then use Playwright to:

1. Navigate to the URL
2. Complete registration (first time)
3. Test the charm functionality

## Deployment

### Prerequisite: `ct` tool availability

```bash
# Verify ct is accessible
deno task ct --help

# Create identity if needed
ls -la claude.key || deno task ct id new > claude.key

# Initialize TypeScript in your patterns directory
cd /path/to/patterns && deno task ct init
```

### Prerequisites

Run `deno task ct --help` and `deno task ct charm --help` to discover available commands.

This tool is used to:

- Deploy a pattern as a new charm
- Read/write charm data directly
- Invoke charm handlers for complex operations
- Link charms together
- ls/inspect/map: inspect and visualize charms

### Deployment Workflow

#### Initial Deployment

```bash
# 1. Test syntax (optional)
deno task ct dev pattern.tsx --no-run

# 2. Deploy to test space
deno task ct charm new --identity claude.key --api-url https://toolshed.saga-castor.ts.net --space test-space pattern.tsx
# Record the charm ID returned

# 3. Inspect deployed charm
deno task ct charm inspect --identity claude.key --api-url https://toolshed.saga-castor.ts.net --space test-space --charm [charm-id]
```

#### Iteration Cycle

```bash
# Update existing charm (much faster than deploying new)
deno task ct charm setsrc --identity claude.key --api-url https://toolshed.saga-castor.ts.net --space test-space --charm [charm-id] pattern.tsx
```

**Note:** Don't pre-test syntax unless deployment fails. The deployment process validates automatically.

#### Getting Pattern Source

```bash
# Get source from deployed charm
deno task ct charm getsrc --identity claude.key --api-url https://toolshed.saga-castor.ts.net --space [space] --charm [id] ./pattern.tsx
```

### Quick Command Reference

```bash
# Test syntax
deno task ct dev pattern.tsx --no-run

# Deploy new charm
deno task ct charm new -i claude.key -a https://toolshed.saga-castor.ts.net -s space pattern.tsx

# Update existing charm
deno task ct charm setsrc -i claude.key -a https://toolshed.saga-castor.ts.net -s space -c charm-id pattern.tsx

# Inspect charm
deno task ct charm inspect -i claude.key -a https://toolshed.saga-castor.ts.net -s space -c charm-id

# Get source from charm
deno task ct charm getsrc -i claude.key -a https://toolshed.saga-castor.ts.net -s space -c charm-id output.tsx

# For full ct command reference, use the ct skill
```

### Workflow Resources

Practical ct command workflows for:

- Setting up development environment
- Development cycle (deploy, iterate, debug)
- Common tasks (modify, link, visualize)
- Debugging commands
- Multi-file pattern development
- Configuration management

Consult `.claude/skills/pattern-dev/references/workflow-guide.md` when you need practical command examples beyond theory.

### Best Practices

- **Use the ct skill** for ct binary commands and deployment details
- **Read `docs/common/` files** for pattern framework concepts - don't ask for duplicated information
- **Check `packages/patterns/`** for working examples before building from scratch
- **Start simple** - minimal viable pattern first, then add features
- **Bidirectional binding first** - only use handlers when truly needed
