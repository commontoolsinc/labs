# CT Binary Usage

## Essential Commands (90% of usage)

**Standard Parameters** (use these for all commands):
- Identity: `claude.key` (created automatically if missing)
- API URL: `https://toolshed.saga-castor.ts.net/`
- Space: Your choice (e.g., `2025-wiki`, `2024-07-15-claude-dev`)

When gathering this information from the user, consider saving `.common.json` and reading it next time to shortcut the process.

```bash
# READ data from charm
./dist/ct charm get --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [your-space] --charm [charm-id] [path]

# SET data directly in charm (value via stdin)
echo '[value]' | ./dist/ct charm set --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [your-space] --charm [charm-id] [path]

# CALL charm handler (JSON via stdin)
echo '[json-data]' | ./dist/ct charm call --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [your-space] --charm [charm-id] [handler-name]

# LIST charms in space
./dist/ct charm ls --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [your-space]

# DEPLOY new charm
./dist/ct charm new --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [your-space] [recipe-path]
```

**When to use each:**
- **GET**: Read any data from charm
- **SET**: Directly modify specific values (simple, fast)
- **CALL**: Use charm's handlers (for complex operations, validation, side effects)
- **LS**: Discover what charms exist in a space
- **NEW**: Deploy a recipe as a new charm

**Path Examples:**
```bash
# Read specific values
./dist/ct charm get [params] --charm [id] title
./dist/ct charm get [params] --charm [id] items/0/name
./dist/ct charm get [params] --charm [id] config/database/host

# Set specific values
echo '"New Title"' | ./dist/ct charm set [params] --charm [id] title
echo 'true' | ./dist/ct charm set [params] --charm [id] items/0/done
echo '{"host": "localhost"}' | ./dist/ct charm set [params] --charm [id] config/database

# Call handlers
echo '{"title": "New item"}' | ./dist/ct charm call [params] --charm [id] addItem
echo '{"key": "page", "value": "content"}' | ./dist/ct charm call [params] --charm [id] update
```

## Setup & Deployment

### Initial Setup

**Check CT binary:**
- Run `ls -la ./dist/ct`
- If missing: Run `deno task build-binaries --cli-only` (takes a few minutes)
- Verify with `./dist/ct --help`

**Identity management:**
- Run `ls -la claude.key`
- If missing: Run `./dist/ct id new > claude.key`

**Recipe development setup:**
- Navigate to your recipes repository
- Run `./dist/ct init` to set up TypeScript types for recipe development
- This creates/updates tsconfig.json and provides proper type definitions

### Environment Variables (Optional)

Set these to shorten commands:
- `CT_API_URL="https://toolshed.saga-castor.ts.net/"`
- `CT_IDENTITY="./claude.key"`

**Important:** For `*.ts.net` URLs, you must be connected to the CT Tailnet. Commands will hang or timeout if not connected.

### Recipe Development Commands

```bash
# Test recipe syntax
./dist/ct dev [recipe-path] --no-run

# Test recipe execution
./dist/ct dev [recipe-path]

# Get recipe source from deployed charm
./dist/ct charm getsrc --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] [output-path]

# Update recipe source in deployed charm
./dist/ct charm setsrc --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] [recipe-path]
```

## Advanced Features

### Working with Input vs Result Cells

**Result Cell** (default): Contains the computed output/result of a charm
**Input Cell**: Contains the input parameters/arguments passed to a charm

```bash
# Access input cell instead of result cell
./dist/ct charm get [params] --charm [id] [path] --input
echo '[value]' | ./dist/ct charm set [params] --charm [id] [path] --input
```

### Charm Inspection and Debugging

```bash
# Inspect charm details
./dist/ct charm inspect --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id]

# Get raw JSON output
./dist/ct charm inspect [params] --charm [id] --json
```

### Linking Charms (Core Concept)

**Linking is how you connect charms together** - it's the primary way to build complex applications from simple recipes.

**Basic Syntax:** `ct charm link [source] [target]/[field]`

```bash
# Link charm output to another charm's input
./dist/ct charm link --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] [source-charm]/[field] [target-charm]/[input-field]

# Link well-known ID to charm input
./dist/ct charm link --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] [well-known-id] [target-charm]/[input-field]
```

**How Links Work:**
- **Data Flow**: `charmA/fieldName → charmB/inputField` means `charmB.input.inputField = charmA.result.fieldName`
- **Source Side**: Reads from a charm's computed result/output field
- **Target Side**: Writes to another charm's input parameters
- **Live Updates**: When source charm updates, target automatically receives new data
- **Reactive**: Changes propagate through the entire linked chain automatically

**Common Patterns:**

```bash
# Email list → Feed into document generator
./dist/ct charm link [email-list-charm]/emails [doc-gen-charm]/emailData

# Search results → Feed into summarizer
./dist/ct charm link [search-charm]/results [summarizer-charm]/content

# Well-known charm list → Feed into page manager
./dist/ct charm link baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye [page-manager]/allCharms
```

**Why Links Matter:**
- **Composability**: Build complex workflows from simple parts
- **Separation of Concerns**: Each charm does one thing well
- **Data Synchronization**: No manual copying between charms
- **Scalability**: Add new functionality by linking new charms

### Primary Operations

**Call handlers** (most common for user actions):
```bash
# Call a handler with no arguments
./dist/ct charm call --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] handlerName

# Call a handler with JSON arguments
./dist/ct charm call --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] handlerName '{"key": "value"}'
```

**Get/Set data** (direct field access):
```bash
# Get a field from charm result
./dist/ct charm get --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] fieldName

# Get nested field with path syntax
./dist/ct charm get --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] data/users/0/email

# Set a field in charm result
echo '"New Value"' | ./dist/ct charm set --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] fieldName

# Set a field in charm input (use --input flag)
echo '{"config": "value"}' | ./dist/ct charm set --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id] config --input
```

### Space Visualization

**Map command** (see charm connections):
```bash
# ASCII map of all charms and links
./dist/ct charm map --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space]

# Graphviz DOT format for visualization tools
./dist/ct charm map --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --format dot
```

### Advanced Operations

**Apply inputs** (bulk input replacement - rarely needed):
```bash
# Replace all inputs at once (prefer call/set for most cases)
echo '{"input1": "value1", "input2": "value2"}' | ./dist/ct charm apply --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] --charm [id]
```

### Visualizing Space Maps

```bash
# ASCII format (default)
./dist/ct charm map --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space]

# Graphviz DOT format
./dist/ct charm map [params] --space [space] --format dot

# Render to image (requires Graphviz: brew install graphviz)
./dist/ct charm map [params] --space [space] --format dot | dot -Tpng -o map.png
```

**Online visualization:**
1. Run: `./dist/ct charm map [params] --space [space] --format dot`
2. Copy the DOT output
3. URL encode and append to: `https://dreampuf.github.io/GraphvizOnline/?engine=dot#`
4. Or paste directly into: `https://dreampuf.github.io/GraphvizOnline/`

## Well-Known IDs

CommonTools provides well-known IDs for accessing system-level data:

**allCharms (Charms List):**
- ID: `baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye`
- Contains a list of all charms in the current space
- Common usage: Link to charm inputs that need to access the full charm list
- Example: `./dist/ct charm link --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space [space] baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye [target-charm]/allCharms`

## Important Notes

- **Recipes**: Typically in a separate repository, not in the labs repo
- **Paths**: Always use absolute paths or full relative paths to recipes
- **Charm IDs**: Start with "bafy" and are long content hashes
- **Environment variables**: CT_API_URL and CT_IDENTITY can simplify commands
- **Tailnet**: For `*.ts.net` URLs, ensure you're connected to the CT Tailnet

## Error Handling

**If commands fail:**
- Check network connectivity and Tailnet connection
- Verify identity file permissions
- Ensure space name and charm ID are correct
- For recipe syntax errors, use `./dist/ct dev [recipe] --no-run`

**Path Format:**
- Use forward slashes: `config/database/host`
- Array indices are numeric: `users/0/profile`
- Support nested objects: `data/items/2/metadata/tags`
