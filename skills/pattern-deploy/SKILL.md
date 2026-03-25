---
name: pattern-deploy
description: Deploy patterns and test with CLI
user-invocable: false
---

# Deploy Phase

Use the `cf` skill, or read `skills/cf/SKILL.md`, for comprehensive CLI
documentation.

## Read First

- `docs/development/LOCAL_DEV_SERVERS.md` - Local dev setup
- `docs/common/workflows/development.md` - Workflow commands

## Find Identity Key

```bash
ls -la ./cf.key ./identity.key 2>/dev/null || ls -la *.key 2>/dev/null || find . -name "*.key" -maxdepth 2 2>/dev/null
```

## Commands

**Check syntax without deploying:**

```bash
deno task cf check pattern.tsx --no-run
```

**Deploy new pattern:**

```bash
deno task cf piece new packages/patterns/[name]/main.tsx --identity PATH_TO_KEY
```

**Inspect piece state:**

```bash
deno task cf piece inspect
```

**Update deployed pattern:**

```bash
deno task cf piece setsrc packages/patterns/[name]/main.tsx
```

**Test handler via CLI:**

```bash
deno task cf piece call handlerName --piece PIECE_ID
deno task cf piece step --piece PIECE_ID    # Required! Triggers recomputation
deno task cf piece inspect --piece PIECE_ID  # Now shows updated state
```

**Important:** Always run `piece step` after `piece call` or `piece set`.
Without it, computed values remain stale and `inspect`/`get` return old data.

## Get Help

```bash
deno task cf --help
deno task cf piece --help
```

## Done When

- Piece deploys without errors
- State inspects correctly
- Handlers respond to CLI calls
