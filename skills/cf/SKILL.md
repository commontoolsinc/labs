---
name: cf
description: Guide for using the cf (Common Fabric) CLI to interact with pieces,
  patterns, and the Common Fabric. Use this skill when deploying patterns, managing
  pieces, linking data between pieces, or debugging pattern execution. Triggers include
  requests to "deploy this pattern", "call a handler", "link these pieces", "get data
  from piece", or "test this pattern locally".
---

# CF CLI

The `cf` CLI is the command-line interface for Common Fabric. **Use `--help` for
current commands:**

```bash
deno task cf --help           # Top-level commands
deno task cf piece --help     # Piece operations
deno task cf check --help     # Type checking
```

## Environment Setup

**Identity key** (required for most operations):

```bash
ls -la cf.key                  # Check for existing

# Never overwrite an existing key file — existing identity-scoped data
# becomes invisible under a new identity.

# Default: a fresh, UNIQUE key. Use this for normal pattern dev and for any
# server (local, shared, or remote).
deno run -A packages/cli/mod.ts id new > cf.key

# To match a browser identity registered with a recovery phrase:
deno run -A packages/cli/mod.ts id from-mnemonic -- phrase.txt > cf.key

# To reproduce a key from your OWN secret passphrase (unique to you; pass via
# file or stdin to keep it out of shell history):
deno run -A packages/cli/mod.ts id derive -- passphrase.txt > cf.key
```

Both `id derive` and `id from-mnemonic` accept the secret three ways: as a file
(`-- <file>`), on stdin (`-`, or no argument), or as an inline positional
argument. Prefer a file or stdin for real secrets — an inline argument is
visible in shell history and to other processes via `ps`. A single trailing
newline is stripped from file/stdin input, so `echo`/editor input matches the
equivalent inline value.

Note: `id derive` (passphrase) and `id from-mnemonic` (BIP-39 phrase) use
different derivations and produce different DIDs from the same text. Use
`from-mnemonic` to match browser mnemonic login; see
`docs/development/SHARED_IDENTITY.md`.

**IMPORTANT:** Do NOT use `deno task cf id new > file` — the `deno task` wrapper
prints ANSI-colored preamble to stdout, which pollutes the key file. Always use
`deno run -A packages/cli/mod.ts` when redirecting output.

**Environment variables** (avoid repeating flags):

```bash
export CF_API_URL=http://localhost:8000  # local dev default; only target a remote instance when the task explicitly requires it — remote set/rm/setsrc mutate shared state
export CF_IDENTITY=./cf.key
```

**Identity visibility footgun:** If CLI and browser use different DIDs, the same
piece should still load and unscoped/`PerSpace` data should remain visible, but
`PerUser`, `PerSession`, favorites, drafts, and home-space state may look empty
or default. For identity-sensitive local work, use one key everywhere — generate
it with `id new` and import the CLI PKCS8/PEM key in the browser via
`Import CLI Key`. See `docs/development/SHARED_IDENTITY.md`.

**Experimental flags** must be set as env vars on both servers AND CLI commands.
See `docs/development/EXPERIMENTAL_OPTIONS.md` for available flags.

**Local servers**: See `docs/development/LOCAL_DEV_SERVERS.md`

## Quick Command Reference

| Operation         | Command                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| Type check        | `deno task cf check pattern.tsx --no-run`                                 |
| Deploy new        | `deno task cf piece new pattern.tsx -i key -a url -s space`               |
| Update existing   | `deno task cf piece setsrc pattern.tsx --piece ID -i key -a url -s space` |
| Inspect state     | `deno task cf piece inspect --piece ID ...`                               |
| Get field         | `deno task cf piece get --piece ID fieldPath ...`                         |
| Set field         | `echo '{"data":...}' \| deno task cf piece set --piece ID path ...`       |
| Call handler      | `deno task cf piece call --piece ID handlerName ...`                      |
| Trigger recompute | `deno task cf piece step --piece ID ...`                                  |
| List pieces       | `deno task cf piece ls -i key -a url -s space`                            |
| Visualize         | `deno task cf piece map ...`                                              |

## Check Command Flags

`deno task cf check` compiles and evaluates patterns. Key flags:

| Flag                   | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| `--no-run`             | Type check only, don't execute                     |
| `--no-check`           | Execute without type checking                      |
| `--show-transformed`   | Show the transformed TypeScript after compilation  |
| `--verbose-errors`     | Show original TS errors alongside simplified hints |
| `--pattern-json`       | Print the evaluated pattern export as JSON         |
| `--output <path>`      | Store compiled JS to a file                        |
| `--main-export <name>` | Select non-default export (default: `"default"`)   |
| `--filename <name>`    | Override filename for source maps                  |

Common usage:

```bash
deno task cf check pattern.tsx              # Compile + execute (quiet on success)
deno task cf check pattern.tsx --no-run     # Type check only (fast)
deno task cf check pattern.tsx --no-check   # Skip types, just execute
deno task cf check pattern.tsx --show-transformed  # Debug compiler transforms
deno task cf check pattern.tsx --verbose-errors     # Detailed error context
```

## Core Workflow: setsrc vs new

**Critical pattern:** After initial deployment, use `setsrc` to iterate:

```bash
# First time only
deno task cf piece new pattern.tsx ...
# Output: Created piece bafyreia... <- Save this ID!

# ALL subsequent iterations
deno task cf piece setsrc pattern.tsx --piece bafyreia... ...
```

**Why:** `new` creates duplicate pieces. `setsrc` updates in-place.

## JSON Input Format

All values to `set` and `call` must be valid JSON:

```bash
# Strings need nested quotes
echo '"hello world"' | deno task cf piece set ... title

# Numbers are bare
echo '42' | deno task cf piece set ... count

# Objects
echo '{"name": "John"}' | deno task cf piece set ... user
```

## Gotcha: Always `step` After `set` or `call`

Neither `piece set` nor `piece call` triggers recomputation automatically. You
**must** run `piece step` after either one to get fresh computed values.

```bash
# After setting data:
echo '[...]' | deno task cf piece set --piece ID expenses ...
deno task cf piece step --piece ID ...  # Required!
deno task cf piece get --piece ID totalSpent ...

# After calling a handler:
deno task cf piece call --piece ID addItem '{"title": "Test"}'
deno task cf piece step --piece ID ...  # Required!
deno task cf piece inspect --piece ID ...
```

**Handler testing workflow** (deploy → call → step → inspect):

```bash
# 1. Deploy
deno task cf piece new pattern.tsx -i key -a url -s space
# 2. Call a handler
deno task cf piece call --piece ID handlerName '{"arg": "value"}' ...
# 3. Step to process
deno task cf piece step --piece ID ...
# 4. Inspect result
deno task cf piece inspect --piece ID ...
# 5. Repeat 2-4 for each handler
```

See `docs/common/workflows/handlers-cli-testing.md` for the full workflow and
`docs/development/debugging/cli-debugging.md` for debugging.

## Troubleshooting

| Issue                        | Fix                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Commands hang                | Check Tailnet connection for `*.ts.net` URLs                                 |
| Permission denied            | `chmod 600 cf.key`                                                           |
| JSON parse error             | Check nested quotes, no trailing commas                                      |
| Local servers not responding | `./scripts/check-local-dev.sh` then `./scripts/restart-local-dev.sh --force` |

### FUSE mount wrapper mismatch

On some local setups, the installed `cf` wrapper (for example `dist/cf`) can lag
behind the source CLI and reject newer `fuse mount` flags such as `-s/--space`,
even when `deno task cf fuse mount --help` supports them.

**Symptom:**

```bash
cf fuse mount /tmp/cf -s my-space
# error: Unknown option "-s"
```

**Fix:** use the source CLI through the repo task wrapper instead (cd to the
labs repo root first):

```bash
export CF_IDENTITY=./cf.key
export CF_API_URL=http://localhost:8000

deno task cf fuse mount /tmp/cf -s my-space
```

This matters because preconnecting the space is required for writable FUSE
mounts; auto-discovered spaces may appear writable but silently drop writes.

## References

- `packages/patterns/system/default-app.tsx` - System pieces (allCharms list
  lives here)
- `docs/common/workflows/handlers-cli-testing.md` - Handler testing
- `docs/development/debugging/cli-debugging.md` - CLI debugging
