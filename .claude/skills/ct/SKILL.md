---
name: ct
description: Guide for using the ct (CommonTools) binary to interact with charms, recipes, and the Common Fabric. Use this skill when deploying recipes, managing charms, linking data between charms, or debugging recipe execution. Triggers include requests to "deploy this recipe", "call a handler", "link these charms", "get data from charm", or "test this recipe locally".
---

# CT (CommonTools CLI)

## Overview

The `ct` binary is the primary command-line interface for interacting with the CommonTools framework. Use this skill when working with recipes (TypeScript programs that define interactive data transformations), charms (deployed instances of recipes), and the Common Fabric (the distributed runtime for charms).

## When to Use This Skill

Use this skill for:
- Starting, stopping, or restarting local development servers
- Deploying recipes as charms to a space
- Managing charm data (get/set fields, call handlers)
- Linking charms together for reactive data flow
- Testing and debugging recipes locally
- Managing identity and space configurations
- Visualizing charm relationships

## Self-Documenting CLI Philosophy

**IMPORTANT:** The `ct` binary has comprehensive built-in help. Always use `--help` flags to discover current commands and syntax rather than relying on hardcoded documentation.

### Discovering Commands

```bash
# Top-level commands
deno task ct --help

# Charm subcommands
deno task ct charm --help

# Specific command details
deno task ct charm get --help
deno task ct charm link --help
deno task ct dev --help
```

**Why this matters:** The tool's `--help` output is the authoritative source of truth. As new features are added or flags change, `--help` stays current automatically.

## Running CT

The `ct` command is run via:

```bash
deno task ct [command]
```

This is the recommended approach for all users. If you use `ct` frequently, you can create a shell alias:

```bash
alias ct="deno task ct"
```

## Local Development Servers

**Always use the scripts** — never use manual `pkill` or process management:

```bash
# Start both servers (backend + frontend)
./scripts/start-local-dev.sh

# Stop servers
./scripts/stop-local-dev.sh

# Restart (with optional flags)
./scripts/restart-local-dev.sh
./scripts/restart-local-dev.sh --clear-cache  # Clear toolshed cache
./scripts/restart-local-dev.sh --force        # Kill existing processes first
```

**Local URLs:**
- **Backend API**: `http://localhost:8000` (use with `-a` flag)
- **Frontend/Shell**: `http://localhost:8000` (access spaces in browser)
- **Logs**: `packages/shell/local-dev-shell.log`, `packages/toolshed/local-dev-toolshed.log`

**Example local deployment:**
```bash
./scripts/restart-local-dev.sh --force

deno task ct charm new path/to/pattern.tsx \
  -i claude.key -a http://localhost:8000 -s my-space

# Then open: http://localhost:8000/my-space
```

If scripts fail, see `docs/common/LOCAL_DEV_SERVERS.md` for troubleshooting.

## Prerequisites and Setup

### Identity Management

Check for existing identity:
```bash
ls -la claude.key
```

If missing, create one:
```bash
deno task ct id new > claude.key
```

To get the DID (Decentralized Identifier):
```bash
deno task ct id did claude.key
```

### Recipe Development Setup

When working in a recipes repository, initialize TypeScript support:
```bash
deno task ct init
```

This creates/updates `tsconfig.json` with proper type definitions.

### Standard Parameters

Most commands require these parameters:
- `--identity` / `-i`: Path to identity keyfile (commonly `claude.key`)
- `--api-url` / `-a`: Fabric instance URL (commonly `https://toolshed.saga-castor.ts.net/`)
- `--space` / `-s`: Space name or DID

**Environment Variables:** Set `CT_API_URL` and `CT_IDENTITY` to avoid repeating these parameters.

**Important:** For `*.ts.net` URLs, ensure connection to the CT Tailnet. Commands will hang/timeout if not connected.

## Core Workflows

### 1. Testing Recipes Locally

Use `deno task ct dev` for rapid iteration during recipe development:

```bash
# Type check and execute
deno task ct dev ./recipe.tsx

# Type check only (no execution)
deno task ct dev ./recipe.tsx --no-run
```

**Discover more options:**
```bash
deno task ct dev --help
```

### 2. Deploying and Managing Charms

**Workflow pattern:**
1. List charms → `deno task ct charm ls`
2. Deploy new → `deno task ct charm new`
3. Update existing → `deno task ct charm setsrc` (faster than redeploying)
4. Inspect state → `deno task ct charm inspect`

**Discover commands:**
```bash
deno task ct charm --help
```

### 3. Reading and Writing Charm Data

**Key concepts:**
- **Result Cell** (default): Computed output of the charm
- **Input Cell**: Input parameters passed to the charm
- **Path syntax**: Use forward slashes (e.g., `items/0/name`, `config/database/host`)

**Commands:**
- `deno task ct charm get` - Read data from charm
- `deno task ct charm set` - Direct field modification
- `deno task ct charm call` - Execute handler (for validation/side effects)

**Decision guide:**
- Use **GET** to inspect charm state
- Use **SET** for simple value updates without business logic
- Use **CALL** for operations that need validation, computation, or side effects

**Important:** Values must be valid JSON. Strings need quotes: `'"text"'` not `'text'`

### 4. Linking Charms Together

Linking creates reactive data flow between charms:
- **Source side**: Reads from a charm's result/output field
- **Target side**: Writes to another charm's input field
- **Syntax**: `[source-charm]/[field] [target-charm]/[input-field]`
- **Reactivity**: When source updates, target automatically receives new data

**Example pattern:**
```bash
deno task ct charm link -i claude.key -a https://toolshed.saga-castor.ts.net/ -s space \
  sourceCharmID/emails targetCharmID/emailData
```

**Discover linking options:**
```bash
deno task ct charm link --help
```

### 5. Visualizing Space Architecture

Use `deno task ct charm map` to understand charm relationships:

```bash
# ASCII map
deno task ct charm map -i claude.key -a https://toolshed.saga-castor.ts.net/ -s space

# Graphviz DOT format (for visualization tools)
deno task ct charm map -i claude.key -a https://toolshed.saga-castor.ts.net/ -s space --format dot
```

### 6. Testing Patterns via CLI

The CLI provides faster feedback than browser-based testing and isolates data logic from UI rendering issues.

#### Why CLI Testing Matters

- **Faster feedback** than browser refresh cycles
- **Isolates data logic** from UI rendering issues
- **Scriptable and repeatable** for regression testing
- **Easier edge case testing** - just pipe JSON
- **Verifies reactivity** - see computed values update immediately

#### The setsrc Workflow

**Critical:** After initial deployment, **always use `setsrc` instead of `new`**:

```bash
# First deployment only
deno task ct charm new pattern.tsx -i claude.key -a http://localhost:8000 -s my-space
# Output: Created charm bafy... ← Note this ID!

# ALL subsequent iterations - update in place
deno task ct charm setsrc --charm bafy... pattern.tsx -i claude.key -a http://localhost:8000 -s my-space
```

**Why this matters:** Using `new` repeatedly on the same file clutters the space with duplicate charms. `setsrc` updates the existing charm in place.

**When to use each:**
- **`setsrc`**: Iterating on a single file/charm (same code evolving)
- **`charm new`**: Deploying separate sub-patterns for independent testing

**All of these happen in the SAME space.** A space holds many charms - think of it as a project workspace.

#### When to Create a New Space

Almost never during pattern development. Use a new space only for:
- Completely unrelated projects
- Clean-slate testing (no existing charms/data)
- Separate production vs development environments

**Common mistake:** Creating a new space when you want a new charm. Instead, use `charm new` in your existing space - both charms will coexist and you can test them independently or link them together.

See the **pattern-dev** skill for guidance on single-file evolution vs pattern composition approaches.

#### Stale Computed Values After `charm set`

**Gotcha:** `charm set` updates data but does NOT trigger computed re-evaluation. The CLI may return stale computed values until you run `charm step`.

```bash
# This workflow returns STALE computed values:
echo '[...]' | deno task ct charm set --charm ID expenses ...
deno task ct charm get --charm ID totalSpent ...  # May return old value!

# Fix: Run charm step after set to trigger re-evaluation
echo '[...]' | deno task ct charm set --charm ID expenses ...
deno task ct charm step --charm ID ...  # Runs scheduling step, triggers recompute
deno task ct charm get --charm ID totalSpent ...  # Now returns correct value
```

`charm step` runs a single scheduling step (start → idle → synced → stop) which pushes changes through the reactive graph.

#### Complete Testing Workflow

**1. Deploy initial version:**
```bash
deno task ct charm new 01-data-layer.tsx -i claude.key -a http://localhost:8000 -s my-space
# Output: Created charm bafyreia...
# Save this ID for all subsequent commands
```

**2. Set test input data + trigger recompute:**
```bash
# Set an array of expenses
echo '[{"description":"Coffee","amount":5,"category":"food"},{"description":"Gas","amount":40,"category":"transport"}]' | \
  deno task ct charm set --charm bafyreia... expenses -i claude.key -a http://localhost:8000 -s my-space

# Trigger computed re-evaluation (required for fresh values!)
deno task ct charm step --charm bafyreia... -i claude.key -a http://localhost:8000 -s my-space
```

**3. Verify computed outputs:**
```bash
# Check total calculation
deno task ct charm get --charm bafyreia... totalSpent -i claude.key -a http://localhost:8000 -s my-space
# Expected: 45

# Check category breakdown
deno task ct charm get --charm bafyreia... byCategory -i claude.key -a http://localhost:8000 -s my-space
# Expected: {"food":5,"transport":40}
```

**4. Test handlers:**
```bash
# Call addExpense handler
echo '{"description":"Lunch","amount":12,"category":"food"}' | \
  deno task ct charm call --charm bafyreia... addExpense -i claude.key -a http://localhost:8000 -s my-space

# Verify it worked
deno task ct charm get --charm bafyreia... totalSpent -i claude.key -a http://localhost:8000 -s my-space
# Expected: 57
```

**5. Inspect full state:**
```bash
deno task ct charm inspect --charm bafyreia... -i claude.key -a http://localhost:8000 -s my-space
```

**6. Iterate on code:**
```bash
# Edit pattern file, then update the deployed charm:
deno task ct charm setsrc --charm bafyreia... 01-data-layer.tsx -i claude.key -a http://localhost:8000 -s my-space

# Repeat from step 2 to verify changes
```

#### Testing Each Layer

When following the layered development methodology (see **pattern-dev** skill):

**Layer 1 (Data + Computeds):**
- Set input data → verify all computed values are correct
- Test edge cases: empty arrays, missing fields, large numbers

**Layer 2 (Handlers):**
- Call each handler → inspect state before/after
- Test validation: invalid inputs, boundary conditions

**Layer 3 (UI):**
- Now use browser to verify visual rendering
- Data flow is already verified, so UI issues are isolated

## Common Patterns and Gotchas

### Path Format

Always use forward slashes:
- ✅ `config/database/host`
- ❌ `config.database.host`

Array indices are numeric:
- ✅ `items/0/name`
- ❌ `items[0]/name`

### JSON Input Requirements

All values passed to `set` and `call` must be valid JSON:

```bash
# Strings (note the nested quotes)
echo '"hello world"' | deno task ct charm set ... title

# Numbers
echo '42' | deno task ct charm set ... count

# Objects
echo '{"name": "John"}' | deno task ct charm set ... user
```

### Error Handling

**Common issues:**
- Commands hang/timeout → Not connected to CT Tailnet (for `*.ts.net` URLs)
- Permission denied → Check identity file permissions (`chmod 600 claude.key`)
- Invalid path → Verify forward slash syntax
- JSON parse error → Check JSON formatting (proper quotes, no trailing commas)

**Debugging steps:**
1. For recipe errors: Run `deno task ct dev [recipe] --no-run` to check syntax
2. For connection issues: Verify Tailnet connection for `*.ts.net` URLs
3. For data issues: Use `deno task ct charm inspect` to examine charm state
4. For linking issues: Use `deno task ct charm map` to visualize connections

## Building Complex Applications

**Composability Pattern:**
1. Create small, focused recipes (each does one thing well)
2. Deploy recipes as separate charms
3. Link charms together for data flow
4. Use `deno task ct charm map` to visualize architecture
5. Add new functionality by deploying and linking new charms

**Example architecture:**
```
[User Input Form] → [Validator] → [Database Writer]
                                      ↓
                                  [Email Notifier]
```

Implement by creating 4 recipes, deploying as charms, then linking them together.

## Resources

### references/well-known-ids.md

Documentation of well-known charm IDs (like `allCharms`) that provide access to system-level data. Reference when building tools that need space-wide information.

## Remember

- **Local servers** - Always use `./scripts/restart-local-dev.sh`, never manual pkill
- **Use `--help` flags** - The tool itself is the documentation
- **Check `deno task ct charm --help`** before asking about available commands
- **Path syntax** - Always forward slashes, numeric array indices
- **JSON format** - All values must be valid JSON (strings need quotes)
- **Environment variables** - Set `CT_API_URL` and `CT_IDENTITY` for convenience
