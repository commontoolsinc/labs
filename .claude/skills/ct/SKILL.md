---
name: ct
description: Guide for using the ct (CommonTools) binary to interact with charms, recipes, and the Common Fabric. Use this skill when deploying recipes, managing charms, linking data between charms, or debugging recipe execution. Triggers include requests to "deploy this recipe", "call a handler", "link these charms", "get data from charm", or "test this recipe locally".
---

# CT (CommonTools CLI)

## Overview

The `ct` binary is the primary command-line interface for interacting with the CommonTools framework. Use this skill when working with recipes (TypeScript programs that define interactive data transformations), charms (deployed instances of recipes), and the Common Fabric (the distributed runtime for charms).

## When to Use This Skill

Use this skill for:
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

Use `ct dev` for rapid iteration during recipe development:

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
1. List charms → `ct charm ls`
2. Deploy new → `ct charm new`
3. Update existing → `ct charm setsrc` (faster than redeploying)
4. Inspect state → `ct charm inspect`

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
- `ct charm get` - Read data from charm
- `ct charm set` - Direct field modification
- `ct charm call` - Execute handler (for validation/side effects)

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

Use `ct charm map` to understand charm relationships:

```bash
# ASCII map
deno task ct charm map -i claude.key -a https://toolshed.saga-castor.ts.net/ -s space

# Graphviz DOT format (for visualization tools)
deno task ct charm map -i claude.key -a https://toolshed.saga-castor.ts.net/ -s space --format dot
```

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
3. For data issues: Use `ct charm inspect` to examine charm state
4. For linking issues: Use `ct charm map` to visualize connections

## Building Complex Applications

**Composability Pattern:**
1. Create small, focused recipes (each does one thing well)
2. Deploy recipes as separate charms
3. Link charms together for data flow
4. Use `ct charm map` to visualize architecture
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

- **Use `--help` flags** - The tool itself is the documentation
- **Check `ct charm --help`** before asking about available commands
- **Path syntax** - Always forward slashes, numeric array indices
- **JSON format** - All values must be valid JSON (strings need quotes)
- **Environment variables** - Set `CT_API_URL` and `CT_IDENTITY` for convenience
