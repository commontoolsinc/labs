# Interactive Recipe Imagination and Creation

This script guides Claude through creating new CommonTools recipes based on user ideas. It follows a streamlined approach similar to recipe development but focuses on bringing new recipe concepts to life.

## Prerequisites

**Before starting recipe imagination:**
- User should have an existing space or have run the space setup script
- Claude MUST read the common CT setup instructions in `.claude/commands/common/ct.md`

**Recipe Documentation Reference:**
Before working on recipes, search for these documentation files in the user's `recipes` folder:
- `RECIPES.md` - Core recipe development patterns and examples
- `COMPONENTS.md` - Available UI components and usage patterns
- `HANDLERS.md` - Event handler patterns and troubleshooting

The user provides an initial prompt describing what they want their recipe to do: $ARGUMENTS

## Script Flow for Claude

### STEP 1: Initial Setup and Context

**Read common setup instructions:**
- First, read `.claude/commands/common/ct.md` for shared CT binary setup
- Follow those instructions for CT binary check, identity management, environment setup
- Collect required parameters (API URL, space name, recipe path, identity file)

**Verify existing space:**
- Run: `./dist/ct charm ls --identity [keyfile] --api-url [api-url] --space [spacename]`
- Show user the existing charms in their space for context
- Ask clarifying questions about the recipe idea

### STEP 2: Requirements Gathering and Research

**Clarify the recipe requirements:**
1. Ask targeted questions about:
   - What inputs the recipe needs (other charm results, user inputs, external APIs)
   - What outputs it should produce
   - What UI interactions are needed
   - How it should integrate with existing charms

**Research existing patterns:**
1. Search user's recipe repo: `find [recipe-path] -name "*.tsx" -type f | head -20`
2. **Search patterns package:** Look in `packages/patterns` for related examples and reusable components
3. Look for similar recipes or reusable patterns
4. Check existing space charms for potential data sources and targets
5. Reference the recipe documentation files for patterns and components

### STEP 3: Design and Plan

**Create implementation plan:**
1. Design the recipe structure (single file vs multi-file)
2. Plan the input/output schemas
3. Identify UI components needed (reference COMPONENTS.md)
4. Plan integration and linking strategy
5. Present plan to user and get approval

### STEP 4: Implementation

**Create the recipe:**
1. Ensure TypeScript setup: User should have run `ct init` in recipes directory
2. Create the recipe file following CommonTools patterns
3. Implement UI components using `ct-` prefixed components
4. Define proper schemas and handlers (reference HANDLERS.md for patterns)
5. Add error handling and validation

**Test syntax (if requested or if deployment fails):**
- Run: `./dist/ct dev [recipe-file] --no-run`
- Fix any syntax errors

### STEP 5: Deploy and Test

**Deploy new charm:**
1. Deploy: `./dist/ct charm new --identity [keyfile] --api-url [api-url] --space [spacename] [recipe-file]`
2. Record the new CHARM_ID
3. Verify deployment: `./dist/ct charm ls --identity [keyfile] --api-url [api-url] --space [spacename]`

**Create integrations:**
1. Link to data sources: `./dist/ct charm link --identity [keyfile] --api-url [api-url] --space [spacename] [source]/[field] [target]/[input]`
2. Verify links work: `./dist/ct charm inspect --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id]`

**Test and refine:**
1. Use inspection commands to verify behavior
2. Use cell operations for testing: `./dist/ct charm get/set` commands
3. **Use Playwright for UI testing (if MCP available):** Test the recipe's user interface by navigating to the space URL and interacting with the deployed charm
4. Make refinements using `./dist/ct charm setsrc` if needed
5. Iterate based on user feedback

### STEP 6: Documentation and Handoff

**Finalize the recipe:**
- Verify it meets original requirements
- Ensure proper integration with existing charms
- Add helpful comments and documentation

**Repository management:**
- Help save recipe to correct location
- Guide git workflow if user wants to commit
- Provide usage instructions

## Common Recipe Patterns

**Recipe types to consider:**
- **Filter recipes**: Process collections, output filtered subsets
- **Transformer recipes**: Convert data between formats
- **Aggregator recipes**: Combine multiple inputs
- **Generator recipes**: Create new data based on inputs
- **UI recipes**: Provide interactive interfaces
- **Integration recipes**: Connect to external APIs

## Key Commands Reference

```bash
# List charms
./dist/ct charm ls --identity [key] --api-url [url] --space [space]

# Create new charm
./dist/ct charm new --identity [key] --api-url [url] --space [space] [recipe-file]

# Link charms
./dist/ct charm link --identity [key] --api-url [url] --space [space] [source]/[field] [target]/[input]

# Inspect charm
./dist/ct charm inspect --identity [key] --api-url [url] --space [space] --charm [id]

# Update recipe source
./dist/ct charm setsrc --identity [key] --api-url [url] --space [space] --charm [id] [recipe-file]

# Test recipe syntax
./dist/ct dev [recipe-file] --no-run

# Cell operations for testing
./dist/ct charm get --identity [key] --api-url [url] --space [space] --charm [id] [path]
echo '[json-value]' | ./dist/ct charm set --identity [key] --api-url [url] --space [space] --charm [id] [path]
```

## Notes for Claude

- **Always search `packages/patterns` and the recipes repository first** - Look for related examples before writing new code
- Start simple and iterate - build basic functionality first
- Reference the recipe documentation files frequently
- Test incrementally after each major change
- Don't test syntax before deploying unless explicitly requested or deployment fails
- Keep track of charm IDs when creating new ones
- Use cell operations for precise testing and debugging
- **Use Playwright MCP for comprehensive UI testing** - Navigate to the space URL and test the recipe's interface directly in the browser
- Focus on user needs and practical functionality

Remember: Recipe imagination is about turning ideas into working code. Help users build step by step, testing along the way, and creating recipes that solve real problems in their CommonTools spaces.
