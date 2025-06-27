# Common CT Binary Setup and Configuration

This document contains shared setup instructions for the CT binary that are used by multiple command scripts.

## Initial CT Binary Check

**Check CT binary:**
- Run `ls -la ./dist/ct`
- If missing: Run `deno task build-binaries --cli-only` (this takes a few minutes)
- Verify with `./dist/ct --help`

## Identity Management

**Check for identity keyfile:**
- Run `ls -la *.key`
- If no keyfiles found: Run `./dist/ct id new > space-identity.key`
- If keyfiles exist, ask user which one to use or create a new one

## Environment Setup

**Set up environment (recommend but don't require):**
- Ask if they want to set environment variables to make commands shorter
- If yes: Guide them to set `CT_API_URL="[their-api-url]"` and `CT_IDENTITY="./their-keyfile.key"`
- This will allow shorter commands without repeating --identity and --api-url flags

## Parameter Collection

**Get API URL:**
- Ask user: "What is your CT API URL? (e.g., https://ct.dev, https://toolshed.saga-castor.ts.net/, or your custom instance)"
- Store as variable for all commands
- Test connectivity: `./dist/ct charm ls --identity [keyfile] --api-url [user-api-url] --space test-connection` (this might fail but shows if URL works)

**Get space name:**
- Ask user what space they want to work with
- Store as variable for commands

**Find recipe path:**
- Ask user: "Where is your recipe repository located? Please provide the full path (e.g., /Users/username/my-recipes or ../my-recipe-repo)"
- User will need to provide the path to their recipe repository
- Once they provide a path, verify it exists: `ls -la [user-provided-path]`
- Look for recipe files in their repo: `find [user-provided-path] -name "*.tsx" | head -10`

## Error Handling

**If any command fails:**
- Show the error
- Check common issues (file permissions, network, file existence)
- Offer solutions or ask user for clarification

**If API connection fails:**
- Verify the URL is correct and accessible
- Check network connectivity
- Verify identity file permissions

## Key CT Commands Reference

### Basic Commands:
- `./dist/ct charm new --identity [keyfile] --api-url [api-url] --space [spacename] [recipe-path]` - Create charm
- `./dist/ct charm link --identity [keyfile] --api-url [api-url] --space [spacename] [source] [target]/[field]` - Link data
- `./dist/ct charm ls --identity [keyfile] --api-url [api-url] --space [spacename]` - List charms
- `./dist/ct charm inspect --identity [keyfile] --api-url [api-url] --space [spacename] --charm [id]` - Inspect charm details
- `./dist/ct charm inspect --identity [keyfile] --url [full-url-with-charm-id]` - Inspect charm details (URL syntax)
- `./dist/ct charm inspect --identity [keyfile] --api-url [api-url] --space [spacename] --charm [id] --json` - Output raw JSON data

### Recipe Development Commands:
- `./dist/ct charm getsrc --identity [keyfile] --api-url [api-url] --space [spacename] --charm [id]` - Get recipe source code
- `./dist/ct charm setsrc --identity [keyfile] --api-url [api-url] --space [spacename] --charm [id] [recipe-path]` - Update recipe source
- `./dist/ct dev [recipe-path] --no-run` - Test recipe syntax locally

## Understanding Linking

**Basic Syntax:** `ct charm link [source] [target]/[field]`

**Charm-to-Charm Linking:**
- `ct charm link charmA/fieldName charmB/inputField` means `charmB.input.inputField = charmA.result.fieldName`
- The source reads from the charm's computed result/output
- The target writes to the charm's input parameters

**Well-Known ID Linking:**
- `ct charm link wellKnownCellId charmB/inputField` links a well-known cell directly to a charm's input
- Well-known IDs don't need field paths since they reference specific cells

**Important:**
- Source can be either `charmId/fieldName` (reads from charm result) or just `wellKnownId` (reads entire cell)
- Target is always `charmId/fieldName` (writes to charm input)
- The link creates live data flow - when source updates, target receives new data

## Important Notes

- Recipes are typically in a separate repository, not in the labs repo
- Always use absolute paths or full relative paths to recipes
- Charm IDs start with "bafy" and are long content hashes
- Environment variables CT_API_URL and CT_IDENTITY can simplify commands