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

## Prerequisites and Setup

### Running CT: Binary vs Source

The `ct` command can be run in two ways:

**1. As a compiled binary (recommended for production):**

```bash
./dist/ct [command]
```

Verify the binary exists:

```bash
ls -la ./dist/ct
```

If missing, build it with:

```bash
deno task build-binaries --cli-only
```

**2. From source (for active development):**

```bash
deno task ct [command]
```

Use this approach when actively developing the ct tool itself, as it runs the latest source code without requiring a rebuild.

**Which to use:**
- Use `./dist/ct` by default and in production environments
- Use `deno task ct` when actively developing/debugging the ct tool
- If uncertain, try `./dist/ct` first; if the binary doesn't exist, use `deno task ct`

### Identity Management

Check for existing identity:

```bash
ls -la claude.key
```

If missing, create one:

```bash
./dist/ct id new > claude.key
```

To get the DID (Decentralized Identifier) of an identity:

```bash
./dist/ct id did claude.key
```

### Recipe Development Setup

When working in a recipes repository, initialize TypeScript support:

```bash
./dist/ct init
```

This creates/updates `tsconfig.json` with proper type definitions for recipe development.

### Standard Parameters

Most commands require these parameters:
- `--identity` / `-i`: Path to identity keyfile (commonly `claude.key`)
- `--api-url` / `-a`: Fabric instance URL (commonly `https://toolshed.saga-castor.ts.net/`)
- `--space` / `-s`: Space name or DID

**Environment Variables:** Set `CT_API_URL` and `CT_IDENTITY` to avoid repeating these parameters.

**Important:** For `*.ts.net` URLs, ensure connection to the CT Tailnet. Commands will hang/timeout if not connected.

## Core Workflows

### 1. Testing Recipes Locally

Before deploying, test recipes locally using `ct dev`:

**Type check and execute:**
```bash
./dist/ct dev ./recipe.tsx
```

**Type check only (no execution):**
```bash
./dist/ct dev ./recipe.tsx --no-run
```

**Show transformed TypeScript:**
```bash
./dist/ct dev ./recipe.tsx --show-transformed
```

**Save compiled output:**
```bash
./dist/ct dev ./recipe.tsx --output compiled.js
```

Use `ct dev` for rapid iteration during recipe development. Fix syntax errors before deploying.

### 2. Deploying and Managing Charms

**List charms in a space:**
```bash
./dist/ct charm ls --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name]
```

**Deploy a recipe as a new charm:**
```bash
./dist/ct charm new --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] [path/to/recipe.tsx]
```

**Inspect charm details:**
```bash
./dist/ct charm inspect --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] --charm [charm-id]
```

**Get charm recipe source:**
```bash
./dist/ct charm getsrc --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] --charm [charm-id] ./output.tsx
```

**Update charm recipe source:**
```bash
./dist/ct charm setsrc --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] --charm [charm-id] [path/to/updated-recipe.tsx]
```

### 3. Reading and Writing Charm Data

Charms have two cells:
- **Result Cell** (default): Computed output/result of the charm
- **Input Cell**: Input parameters/arguments passed to the charm

**Get value from result cell:**
```bash
./dist/ct charm get --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] --charm [charm-id] [path]
```

**Get value from input cell:**
```bash
./dist/ct charm get --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] --charm [charm-id] [path] --input
```

**Set value in result cell (via stdin):**
```bash
echo '"New Value"' | ./dist/ct charm set --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] --charm [charm-id] [path]
```

**Set value in input cell:**
```bash
echo '{"key": "value"}' | ./dist/ct charm set --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] --charm [charm-id] [path] --input
```

**Path syntax examples:**
- `title` - top-level field
- `items/0/name` - array element field
- `config/database/host` - nested object field

**Important:** Values must be valid JSON. Strings need quotes: `'"text"'` not `'text'`

### 4. Calling Charm Handlers

Handlers are functions defined in recipes that perform operations with validation and side effects. Use `call` instead of `set` for complex operations.

**Call handler with no arguments:**
```bash
./dist/ct charm call --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] --charm [charm-id] [handler-name]
```

**Call handler with JSON arguments (via stdin):**
```bash
echo '{"title": "New Item", "priority": 1}' | ./dist/ct charm call --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] --charm [charm-id] addItem
```

**Call handler with JSON arguments (inline):**
```bash
./dist/ct charm call --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] --charm [charm-id] updateStatus '{"status": "completed"}'
```

### 5. Linking Charms Together

Linking is the primary way to build complex applications from simple recipes. Links create reactive data flow between charms.

**How linking works:**
- **Source side**: Reads from a charm's result/output field
- **Target side**: Writes to another charm's input field
- **Syntax**: `[source-charm]/[field] → [target-charm]/[input-field]`
- **Reactivity**: When source updates, target automatically receives new data

**Basic link:**
```bash
./dist/ct charm link --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] bafySourceCharm/emails bafyTargetCharm/emailData
```

**Nested field link:**
```bash
./dist/ct charm link --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] bafyCharmA/data/users/0/email bafyCharmB/config/primaryEmail
```

**Link well-known ID (e.g., all charms list):**
```bash
./dist/ct charm link --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye bafyTargetCharm/allCharms
```

**Common patterns:**
- Email list → Document generator
- Search results → Summarizer
- Database query → Dashboard display
- Form input → Validation processor

### 6. Visualizing Space Architecture

**ASCII map of charms and connections:**
```bash
./dist/ct charm map --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name]
```

**Generate Graphviz diagram:**
```bash
./dist/ct charm map --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] --format dot
```

**Render to PNG (requires Graphviz installed):**
```bash
./dist/ct charm map --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space-name] --format dot | dot -Tpng -o map.png
```

**Online visualization:**
1. Generate DOT output
2. Paste into https://dreampuf.github.io/GraphvizOnline/

## Decision Guide: Which Command to Use

**GET vs SET vs CALL:**
- **GET**: Read data from charm (result or input cell)
- **SET**: Direct field modification (simple, fast, no validation)
- **CALL**: Execute handler (complex operations, validation, side effects)

**When to use each:**
- Use **GET** to inspect charm state
- Use **SET** for simple value updates without business logic
- Use **CALL** for operations that need validation, computation, or side effects
- Use **LINK** to establish reactive data flow between charms

**GETSRC vs SETSRC:**
- **GETSRC**: Retrieve recipe source code from deployed charm
- **SETSRC**: Update recipe source code in deployed charm

Use these when iterating on deployed charms or extracting recipes for local development.

## Common Patterns and Best Practices

### Path Format

Always use forward slashes for paths:
- ✅ `config/database/host`
- ❌ `config.database.host`

Array indices are numeric:
- ✅ `items/0/name`
- ❌ `items[0]/name`

### JSON Input Requirements

All values passed to `set` and `call` must be valid JSON:

```bash
# Strings (note the nested quotes)
echo '"hello world"' | ./dist/ct charm set ... title

# Numbers
echo '42' | ./dist/ct charm set ... count

# Booleans
echo 'true' | ./dist/ct charm set ... enabled

# Objects
echo '{"name": "John", "age": 30}' | ./dist/ct charm set ... user

# Arrays
echo '["item1", "item2"]' | ./dist/ct charm set ... tags
```

### Error Handling

**Common issues:**
- Commands hang/timeout → Not connected to CT Tailnet
- Permission denied → Check identity file permissions (`chmod 600 claude.key`)
- Invalid path → Verify forward slash syntax
- JSON parse error → Check JSON formatting (proper quotes, no trailing commas)

**Debugging steps:**
1. For recipe errors: Run `./dist/ct dev [recipe] --no-run` to check syntax
2. For connection issues: Verify Tailnet connection for `*.ts.net` URLs
3. For data issues: Use `ct charm inspect` to examine charm state
4. For linking issues: Use `ct charm map` to visualize connections

### Building Complex Applications

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

### references/commands.md

Comprehensive command reference with all flags, options, and detailed examples. Consult when needing specific command syntax or advanced features.

### references/well-known-ids.md

Documentation of well-known charm IDs (like `allCharms`) that provide access to system-level data. Reference when building tools that need space-wide information.

## Quick Reference

**Most common commands:**

```bash
# Test recipe locally
./dist/ct dev ./recipe.tsx

# List charms
./dist/ct charm ls -i claude.key -a https://toolshed.saga-castor.ts.net/ -s myspace

# Deploy recipe
./dist/ct charm new -i claude.key -a https://toolshed.saga-castor.ts.net/ -s myspace ./recipe.tsx

# Get data
./dist/ct charm get -i claude.key -a https://toolshed.saga-castor.ts.net/ -s myspace -c bafyID title

# Call handler
echo '{"name": "value"}' | ./dist/ct charm call -i claude.key -a https://toolshed.saga-castor.ts.net/ -s myspace -c bafyID handler

# Link charms
./dist/ct charm link -i claude.key -a https://toolshed.saga-castor.ts.net/ -s myspace bafyA/field bafyB/input
```
