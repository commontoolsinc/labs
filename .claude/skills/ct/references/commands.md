# CT Command Reference

This reference provides detailed command syntax and examples for the ct binary.

## Standard Parameters

Most commands accept these standard parameters:

- `--identity` / `-i` `<path>`: Path to identity keyfile (default: `claude.key`)
- `--api-url` / `-a` `<url>`: URL of the fabric instance
- `--space` / `-s` `<space>`: Space name or DID
- `--charm` / `-c` `<charm>`: Target charm ID (for charm-specific commands)

**Environment Variables:**
- `CT_API_URL`: URL of the fabric instance
- `CT_IDENTITY`: Path to identity keyfile

## Command Groups

### Identity Commands (`ct id`)

**Create new identity:**
```bash
./dist/ct id new > claude.key
```

**Get DID from keyfile:**
```bash
./dist/ct id did <keypath>
```

**Derive identity from passphrase:**
```bash
./dist/ct id derive <passphrase>
```

### Development Commands (`ct dev`)

**Test recipe locally with execution:**
```bash
./dist/ct dev ./recipe.tsx
```

**Type check recipe without execution:**
```bash
./dist/ct dev ./recipe.tsx --no-run
```

**Compile without type checking:**
```bash
./dist/ct dev ./recipe.tsx --no-check
```

**Save compiled output:**
```bash
./dist/ct dev ./recipe.tsx --output out.js
```

**Show transformed source:**
```bash
./dist/ct dev ./recipe.tsx --show-transformed
```

**Use named export:**
```bash
./dist/ct dev ./recipe.tsx --main-export myRecipe
```

### Initialization Commands (`ct init`)

**Initialize TypeScript environment for recipes:**
```bash
./dist/ct init
```

Creates/updates tsconfig.json for proper type definitions in recipe development.

### Charm Commands (`ct charm`)

#### List Charms

**List all charms in space:**
```bash
./dist/ct charm ls --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space]
```

#### Deploy Charm

**Deploy recipe as new charm:**
```bash
./dist/ct charm new --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] [recipe-path]
```

#### Get Data

**Get field from charm result:**
```bash
./dist/ct charm get --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] [path]
```

**Get field from charm input:**
```bash
./dist/ct charm get --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] [path] --input
```

**Path examples:**
- `title` - top-level field
- `items/0/name` - array element field
- `config/database/host` - nested object field

#### Set Data

**Set field in charm result (value via stdin):**
```bash
echo '"New Value"' | ./dist/ct charm set --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] [path]
```

**Set field in charm input:**
```bash
echo '{"config": "value"}' | ./dist/ct charm set --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] [path] --input
```

**Important:** Values must be valid JSON. Strings need double quotes: `'"text"'`

#### Call Handler

**Call handler with no arguments:**
```bash
./dist/ct charm call --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] [handler-name]
```

**Call handler with JSON arguments (via stdin):**
```bash
echo '{"key": "value"}' | ./dist/ct charm call --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] [handler-name]
```

**Call handler with JSON arguments (inline):**
```bash
./dist/ct charm call --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] [handler-name] '{"key": "value"}'
```

#### Link Charms

**Link charm field to another charm's input:**
```bash
./dist/ct charm link --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] [source-charm]/[field] [target-charm]/[input-field]
```

**Examples:**
```bash
# Basic link
./dist/ct charm link --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] bafycharm1/emails bafycharm2/emailData

# Nested field link
./dist/ct charm link --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] bafycharm1/data/users/0/email bafycharm2/config/primaryEmail

# Link well-known ID
./dist/ct charm link --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye bafycharm1/allCharms
```

**How linking works:**
- Source side: Reads from charm's result/output field
- Target side: Writes to charm's input parameters
- Data flows automatically when source updates
- Changes propagate reactively through linked chains

#### Recipe Source Management

**Get recipe source from deployed charm:**
```bash
./dist/ct charm getsrc --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] [output-path]
```

**Update recipe source in deployed charm:**
```bash
./dist/ct charm setsrc --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] [recipe-path]
```

#### Inspect and Debug

**Inspect charm details:**
```bash
./dist/ct charm inspect --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id]
```

**Get raw JSON output:**
```bash
./dist/ct charm inspect --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] --json
```

**Display rendered view:**
```bash
./dist/ct charm view --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id]
```

**Render charm UI to HTML:**
```bash
./dist/ct charm render --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id]
```

#### Apply Inputs (Bulk Replacement)

**Replace all inputs at once (via stdin):**
```bash
echo '{"input1": "value1", "input2": "value2"}' | ./dist/ct charm apply --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id]
```

Note: Prefer `call` or `set` for most cases. Use `apply` only when replacing all inputs is needed.

#### Step Execution

**Run single scheduling step:**
```bash
./dist/ct charm step --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id]
```

Executes: start → idle → synced → stop

#### Remove Charm

**Remove a charm:**
```bash
./dist/ct charm rm --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id]
```

#### Visualization

**ASCII map of charms and links:**
```bash
./dist/ct charm map --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space]
```

**Graphviz DOT format:**
```bash
./dist/ct charm map --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --format dot
```

**Render to image (requires Graphviz):**
```bash
./dist/ct charm map --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --format dot | dot -Tpng -o map.png
```

**Online visualization:**
1. Generate DOT output
2. URL encode and append to: `https://dreampuf.github.io/GraphvizOnline/?engine=dot#`
3. Or paste into: `https://dreampuf.github.io/GraphvizOnline/`

## Common Patterns

### When to Use Each Command

- **GET**: Read any data from charm (result or input)
- **SET**: Directly modify specific values (simple, fast)
- **CALL**: Use charm's handlers (for complex operations, validation, side effects)
- **LINK**: Connect charms for reactive data flow
- **LS**: Discover what charms exist in a space
- **NEW**: Deploy a recipe as a new charm
- **GETSRC/SETSRC**: Retrieve or update recipe source code

### Path Syntax

- Use forward slashes: `config/database/host`
- Array indices are numeric: `users/0/profile`
- Nested objects: `data/items/2/metadata/tags`

### JSON Input Requirements

Values passed to `set` and `call` must be valid JSON:
- Strings: `'"text"'` (note the quotes)
- Numbers: `'42'`
- Booleans: `'true'` or `'false'`
- Objects: `'{"key": "value"}'`
- Arrays: `'["item1", "item2"]'`

### Error Handling

**If commands fail:**
- Check network connectivity and Tailnet connection (for `*.ts.net` URLs)
- Verify identity file exists and has correct permissions
- Ensure space name and charm ID are correct
- For recipe syntax errors, use `./dist/ct dev [recipe] --no-run`

**Common issues:**
- Commands hang/timeout → Not connected to CT Tailnet
- Permission denied → Check identity file permissions
- Invalid path → Verify path syntax with forward slashes
- JSON parse error → Check JSON formatting (proper quotes, no trailing commas)
