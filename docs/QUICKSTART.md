# Quick Start Guide

This guide gets you from a fresh checkout to deploying your first pattern in under 5 minutes.

## Prerequisites

Just Deno 2:
```bash
deno --version  # Should show 2.x
```

If not installed: https://docs.deno.com/runtime/getting_started/installation/

## Setup Steps

### 1. Build the ct tool

```bash
deno task build-binaries --cli-only
```

This creates `./dist/ct` for deploying patterns.

### 2. Create an identity

```bash
./dist/ct id new > claude.key
```

### 3. Start local services

**Option A - Full local stack:**
```bash
# Terminal 1: Backend
cd packages/toolshed && deno task dev

# Terminal 2: Frontend
cd packages/shell && deno task dev-local
```

**Option B - Remote backend (simpler):**
```bash
cd packages/shell && deno task dev
```

### 4. Deploy a pattern

```bash
# Local backend:
./dist/ct charm new --identity claude.key \
  --api-url http://localhost:8000 \
  --space my-space \
  packages/patterns/ct-checkbox-cell.tsx

# Remote backend:
./dist/ct charm new --identity claude.key \
  --api-url https://toolshed.saga-castor.ts.net \
  --space my-space \
  packages/patterns/ct-checkbox-cell.tsx
```

The command outputs a charm ID like `baedreie...`

### 5. View your pattern

Open browser to:
```
http://localhost:5173/my-space/[CHARM_ID]
```

## Using Claude Code

If you have Claude Code installed, just run:
```bash
claude
```

Then type: `/setup` to get interactive setup assistance.

## What's Next?

- **Pattern Development**: Use Claude Skills with `pattern-dev` for AI-assisted development
- **Documentation**: Read `docs/common/RECIPES.md` and `docs/common/PATTERN_DEV_DEPLOY.md`
- **Examples**: Browse `packages/patterns/` for pattern examples
- **ct Commands**: Run `./dist/ct --help` to see all available commands

## Recommended First Patterns

Self-contained patterns perfect for learning:
- `ct-checkbox-cell.tsx` - Interactive checkbox demo
- `ct-select.tsx` - Dropdown component
- `ct-tags.tsx` - Tags input

## Common Issues

**ct binary not found**: Run `deno task build-binaries --cli-only`

**Frontend won't connect**: Use `dev-local` task for local backend, `dev` for remote

**Deno not found**: Install from https://docs.deno.com/runtime/getting_started/installation/

## Using the ct Tool

```bash
# Deploy new pattern
./dist/ct charm new -i claude.key -a http://localhost:8000 -s space pattern.tsx

# Update existing pattern
./dist/ct charm setsrc -i claude.key -a http://localhost:8000 -s space -c [id] pattern.tsx

# Inspect pattern
./dist/ct charm inspect -i claude.key -a http://localhost:8000 -s space -c [id]

# Get pattern source
./dist/ct charm getsrc -i claude.key -a http://localhost:8000 -s space -c [id] output.tsx
```

For more ct commands, see the ct Claude Skill or run `./dist/ct --help`.
