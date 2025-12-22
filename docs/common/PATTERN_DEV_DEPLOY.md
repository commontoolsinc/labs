<!-- @reviewed 2025-12-11 docs-rationalization -->

# Pattern Development & Deployment

Quick reference for pattern development workflow. For detailed documentation, see linked docs.

## Development Workflow

### 1. Start Simple

See [PATTERNS.md](PATTERNS.md) for complete examples. Minimal pattern:

```typescript
/// <cts-enable />
import { Default, NAME, OpaqueRef, pattern, UI } from "commontools";

interface Item { title: string; done: Default<boolean, false>; }
interface Input { items: Default<Item[], []>; }

export default pattern<Input, Input>(({ items }) => ({
  [NAME]: "My Pattern",
  [UI]: (
    <div>
      {items.map((item: OpaqueRef<Item>) => (
        <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
      ))}
    </div>
  ),
  items,
}));
```

### 2. Add Interactivity

- **Bidirectional binding** (`$prop`) for simple updates - see [COMPONENTS.md](COMPONENTS.md)
- **Handlers** for structural changes - see [PATTERNS.md](PATTERNS.md)

### 3. Debug

See [DEBUGGING.md](DEBUGGING.md) for error reference and debugging workflows.

```bash
# Type check without running
deno task ct dev pattern.tsx --no-run

# View transformer output
deno task ct dev pattern.tsx --show-transformed
```

---

## Deployment

Use `deno task ct --help` and `deno task ct charm --help` to discover commands.

### Setup

```bash
# Create identity if needed
ls -la claude.key || deno task ct id new > claude.key

# Initialize TypeScript
deno task ct init
```

### Deploy & Iterate

```bash
# Deploy new charm
deno task ct charm new -i claude.key -a https://toolshed.saga-castor.ts.net -s space pattern.tsx

# Update existing (faster)
deno task ct charm setsrc -i claude.key -a URL -s space -c charm-id pattern.tsx

# Inspect state
deno task ct charm inspect -i claude.key -a URL -s space -c charm-id
```

**Tip:** Use `setsrc` for iteration - much faster than redeploying.

---

## Browser Testing (Playwright)

```javascript
await page.goto("http://localhost:8000/<SPACE>/<CHARM_ID>");
```

**First-time login:**
1. Click "➕ Register"
2. Click "🔑 Generate Passphrase"
3. Click "🔒 I've Saved It - Continue"

---

## Multi-File Patterns

```
patterns/feature/
  main.tsx       # Entry point
  schemas.tsx    # Shared types
  utils.tsx      # Helper functions
```

Use relative imports. ct bundles dependencies automatically.

### Importing from Parent Directories

By default, patterns can only import files from their own directory or subdirectories. To import from parent directories, use the `--root` option:

```bash
# Allow imports from anywhere within ./patterns
deno task ct charm new -i key.json -a URL -s space --root ./patterns ./patterns/wip/main.tsx
```

This allows `./patterns/wip/main.tsx` to import from `./patterns/shared/utils.tsx` (via `../shared/utils.tsx`), while preventing imports from outside the specified root.

**Use cases:**
- Shared type definitions across pattern directories
- Common utility functions
- Reusing blessed patterns as building blocks

**Pitfall:** Schema mismatches between linked charms → export shared schemas from common file.

---

## Quick Reference

| Task | Command/Doc |
|------|-------------|
| Pattern examples | [PATTERNS.md](PATTERNS.md), `packages/patterns/` |
| Error reference | [DEBUGGING.md](DEBUGGING.md) |
| Components | [COMPONENTS.md](COMPONENTS.md) |
| Reactivity | [CELLS_AND_REACTIVITY.md](CELLS_AND_REACTIVITY.md) |
| Types | [TYPES_AND_SCHEMAS.md](TYPES_AND_SCHEMAS.md) |
| Charm linking | [CHARM_LINKING.md](CHARM_LINKING.md) |
| ct commands | `deno task ct --help` |
