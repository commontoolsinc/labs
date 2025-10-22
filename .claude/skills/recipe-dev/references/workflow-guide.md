# Recipe Development Workflow Guide

This guide covers the practical workflow for developing recipes with the ct binary, complementing the theory in `docs/common/*.md`.

## Quick Start Workflow

### 1. Setup (First Time Only)

```bash
# Verify ct binary exists
ls -la ./dist/ct

# If missing, you have two options:
# Option 1: Build the binary
deno task build-binaries --cli-only

# Option 2: Use ct from source
deno task ct --help

# Create identity if needed
ls -la claude.key || ./dist/ct id new > claude.key
# Or with deno task: deno task ct id new > claude.key

# Initialize TypeScript in recipes directory
cd /path/to/recipes && ./dist/ct init
# Or with deno task: deno task ct init
```

**Note:** You can use `deno task ct` instead of `./dist/ct` throughout this guide if the binary isn't built.

### 2. Development Cycle

**Step 1: Write the recipe**
- Start simple (basic types, minimal UI)
- Add one feature at a time
- Reference `packages/patterns/` for examples

**Step 2: Test syntax (optional, only if requested)**
```bash
./dist/ct dev recipe.tsx --no-run
```

**Step 3: Deploy to test space**
```bash
./dist/ct charm new --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space test-space recipe.tsx
# Record the charm ID returned
```

**Step 4: Iterate with setsrc**
```bash
# Much faster than deploying new charms
./dist/ct charm setsrc --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space test-space --charm [charm-id] recipe.tsx
```

**Step 5: Inspect and debug**
```bash
# View charm state
./dist/ct charm inspect --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space test-space --charm [charm-id]

# Get specific fields
./dist/ct charm get --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space test-space --charm [charm-id] items/0/title

# Set test data
echo '{"title": "Test Item"}' | ./dist/ct charm set --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space test-space --charm [charm-id] testData
```

## Common Tasks

### Modify Existing Recipe

```bash
# 1. Get current source
./dist/ct charm getsrc --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] ./recipe.tsx

# 2. Edit the file
# (make your changes)

# 3. Update charm
./dist/ct charm setsrc --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] ./recipe.tsx

# 4. Verify
./dist/ct charm inspect --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id]
```

### Link Charms Together

```bash
# Deploy both charms first
./dist/ct charm new --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] source-recipe.tsx
# Returns: source-charm-id

./dist/ct charm new --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] target-recipe.tsx
# Returns: target-charm-id

# Link data flow
./dist/ct charm link --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] source-charm-id/items target-charm-id/items
```

### Visualize Space

```bash
# ASCII map
./dist/ct charm map --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space]

# Graphviz DOT for visualization
./dist/ct charm map --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --format dot
```

## Debugging Recipes

### Common Error Patterns

**Type Errors:**
- Wrong style syntax (object vs string) - See `COMPONENTS.md`
- Using `Cell<OpaqueRef<T>[]>` in handlers instead of `Cell<T[]>` - See `HANDLERS.md`

**Runtime Errors:**
- DOM access (use cells instead) - See `RECIPES.md`
- Conditionals in JSX (use `ifElse`) - See `RECIPES.md`
- Calling `llm()` from handlers - See `RECIPES.md`

**Data Not Updating:**
- Forgot `$` prefix for bidirectional binding - See `COMPONENTS.md`
- Handler not being called - check event names match component
- Cell not passed correctly to handler

### Debugging Commands

```bash
# View full charm state with JSON
./dist/ct charm inspect --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] --json

# Check specific data paths
./dist/ct charm get --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] items
./dist/ct charm get --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] config/apiKey

# Set test values
echo '"test-value"' | ./dist/ct charm set --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] testField
```

## Multi-File Recipes

When building recipes that import from multiple files:

**Structure:**
```
recipes/
  feature/
    main.tsx      # Entry point
    schemas.tsx   # Shared types
    utils.tsx     # Helper functions
```

**Best Practices:**
1. Use relative imports: `import { Schema } from "./schemas.tsx"`
2. Export shared schemas for reuse
3. Test each file independently first
4. Deploy main.tsx - ct bundles all dependencies

**Common Pitfall:**
- Schema mismatches between linked charms
- Solution: Export shared schemas from common file

## Tips for Efficient Development

**DO:**
- Use `ct dev` to catch TypeScript errors early
- Deploy once, iterate with `setsrc`
- Test one feature at a time
- Use `charm inspect` frequently
- Check `packages/patterns/` for examples

**DON'T:**
- Deploy new charm for every change
- Add multiple features before testing
- Pre-test syntax unless deployment fails
- Use `ct dev` with `--no-run` unless specifically debugging syntax

## Configuration Management

**Option 1: Environment Variables**
```bash
export CT_API_URL="https://toolshed.saga-castor.ts.net/"
export CT_IDENTITY="./claude.key"

# Commands become shorter
./dist/ct charm ls --space my-space
```

**Option 2: Store config in file**
Create `.common.json`:
```json
{
  "identity": "claude.key",
  "apiUrl": "https://toolshed.saga-castor.ts.net/",
  "space": "my-space"
}
```

Then reference when needed (ct doesn't read this automatically, but you can).

## Performance Tips

- Use `charm inspect` instead of `charm get` for multiple fields
- Link charms for reactive updates instead of polling
- Deploy to test space first, then production
- Use `--format dot` for large space visualization (renders better)

## Common Space Patterns

**Development Setup:**
- `test-space` - For rapid iteration and testing
- `production-space` - For deployed, stable charms
- Personal spaces for experiments

**Charm Organization:**
- Name charms descriptively (reflected in `[NAME]`)
- Use `charm map` to visualize before linking
- Document charm dependencies
