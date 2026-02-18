---
name: ct
description: Guide for using the ct (CommonTools) binary to interact with pieces,
  patterns, and the Common Fabric. Use this skill when deploying patterns, managing
  pieces, linking data between pieces, or debugging pattern execution. Triggers include
  requests to "deploy this pattern", "call a handler", "link these pieces", "get data
  from piece", or "test this pattern locally".
---

# CT CLI

The `ct` binary is the CLI for CommonTools. **Use `--help` for current commands:**

```bash
deno task ct --help           # Top-level commands
deno task ct piece --help     # Piece operations
deno task ct check --help     # Type checking
```

## Environment Setup

**Identity key** (required for most operations):
```bash
ls -la claude.key              # Check for existing
deno task ct id new > claude.key  # Create if missing
```

**Environment variables** (avoid repeating flags):
```bash
export CT_API_URL=http://localhost:8000  # or https://toolshed.saga-castor.ts.net/
export CT_IDENTITY=./claude.key
```

**Local servers**: See `docs/development/LOCAL_DEV_SERVERS.md`

## Quick Command Reference

| Operation | Command |
|-----------|---------|
| Type check | `deno task ct check pattern.tsx --no-run` |
| Deploy new | `deno task ct piece new pattern.tsx -i key -a url -s space` |
| Update existing | `deno task ct piece setsrc pattern.tsx --piece ID -i key -a url -s space` |
| Inspect state | `deno task ct piece inspect --piece ID ...` |
| Get field | `deno task ct piece get --piece ID fieldPath ...` |
| Set field | `echo '{"data":...}' \| deno task ct piece set --piece ID path ...` |
| Call handler | `deno task ct piece call --piece ID handlerName ...` |
| Trigger recompute | `deno task ct piece step --piece ID ...` |
| List pieces | `deno task ct piece ls -i key -a url -s space` |
| Visualize | `deno task ct piece map ...` |

## Check Command Flags

`deno task ct check` compiles and evaluates patterns. Key flags:

| Flag | Purpose |
|------|---------|
| `--no-run` | Type check only, don't execute |
| `--no-check` | Execute without type checking |
| `--show-transformed` | Show the transformed TypeScript after compilation |
| `--verbose-errors` | Show original TS errors alongside simplified hints |
| `--pattern-json` | Print the evaluated pattern export as JSON |
| `--output <path>` | Store compiled JS to a file |
| `--main-export <name>` | Select non-default export (default: `"default"`) |
| `--filename <name>` | Override filename for source maps |

Common usage:
```bash
deno task ct check pattern.tsx              # Compile + execute (quiet on success)
deno task ct check pattern.tsx --no-run     # Type check only (fast)
deno task ct check pattern.tsx --no-check   # Skip types, just execute
deno task ct check pattern.tsx --show-transformed  # Debug compiler transforms
deno task ct check pattern.tsx --verbose-errors     # Detailed error context
```

## Core Workflow: setsrc vs new

**Critical pattern:** After initial deployment, use `setsrc` to iterate:

```bash
# First time only
deno task ct piece new pattern.tsx ...
# Output: Created piece bafyreia... <- Save this ID!

# ALL subsequent iterations
deno task ct piece setsrc pattern.tsx --piece bafyreia... ...
```

**Why:** `new` creates duplicate pieces. `setsrc` updates in-place.

## JSON Input Format

All values to `set` and `call` must be valid JSON:

```bash
# Strings need nested quotes
echo '"hello world"' | deno task ct piece set ... title

# Numbers are bare
echo '42' | deno task ct piece set ... count

# Objects
echo '{"name": "John"}' | deno task ct piece set ... user
```

## Gotcha: Always `step` After `set` or `call`

Neither `piece set` nor `piece call` triggers recomputation automatically.
You **must** run `piece step` after either one to get fresh computed values.

```bash
# After setting data:
echo '[...]' | deno task ct piece set --piece ID expenses ...
deno task ct piece step --piece ID ...  # Required!
deno task ct piece get --piece ID totalSpent ...

# After calling a handler:
deno task ct piece call --piece ID addItem '{"title": "Test"}'
deno task ct piece step --piece ID ...  # Required!
deno task ct piece inspect --piece ID ...
```

**Handler testing workflow** (deploy → call → step → inspect):
```bash
# 1. Deploy
deno task ct piece new pattern.tsx -i key -a url -s space
# 2. Call a handler
deno task ct piece call --piece ID handlerName '{"arg": "value"}' ...
# 3. Step to process
deno task ct piece step --piece ID ...
# 4. Inspect result
deno task ct piece inspect --piece ID ...
# 5. Repeat 2-4 for each handler
```

See `docs/common/workflows/handlers-cli-testing.md` for the full workflow
and `docs/development/debugging/cli-debugging.md` for debugging.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Commands hang | Check Tailnet connection for `*.ts.net` URLs |
| Permission denied | `chmod 600 claude.key` |
| JSON parse error | Check nested quotes, no trailing commas |
| Local servers not responding | `./scripts/check-local-dev.sh` then `./scripts/restart-local-dev.sh --force` |

## References

- `packages/patterns/system/default-app.tsx` - System pieces (allCharms list lives here)
- `docs/common/workflows/handlers-cli-testing.md` - Handler testing
- `docs/development/debugging/cli-debugging.md` - CLI debugging
