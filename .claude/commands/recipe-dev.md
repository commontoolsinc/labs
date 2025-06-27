# Interactive Recipe Development Script

This script guides Claude through recipe development with the `ct` utility after initial space setup. Claude should follow these steps to help users modify recipes, create new ones, and network them together.

## Prerequisites

**Before starting recipe development:**
- User should have already run the space setup script or have an existing space
- Claude should read the common CT setup instructions in `.claude/commands/ct-common.md`

## Script Flow for Claude

### STEP 1: Initial Setup and Context

**Read common setup instructions:**
- First, read `.claude/commands/ct-common.md` for shared CT binary setup
- Follow those instructions for:
  - CT binary check
  - Identity management
  - Environment setup
  - Parameter collection (API URL, space name, recipe path)

**Verify existing space:**
- Run: `./dist/ct charm ls --identity [keyfile] --api-url [api-url] --space [spacename]`
- Show user the existing charms in their space
- Ask user what they want to work on (modify existing recipe, create new one, or adjust networking)

### STEP 2: Recipe Development Workflows

#### Workflow A: Modifying Existing Recipes

**Get recipe source:**
1. Ask user which charm they want to modify (show charm list if needed)
2. Run: `./dist/ct charm getsrc --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id]`
3. Save the output to a temporary file or show user the current source
4. Ask what changes they want to make

**Edit recipe:**
1. Guide user through making changes to the recipe code
2. If saving to file: Create a temporary file with the modified recipe
3. Test syntax locally: `./dist/ct dev [modified-recipe-path] --no-run`
4. Show any syntax errors and help fix them

**Update recipe source:**
1. Once syntax is valid, update the charm:
   `./dist/ct charm setsrc --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id] [modified-recipe-path]`
2. Verify update: `./dist/ct charm inspect --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id]`
3. Explain what changed and how it affects the charm's behavior

#### Workflow B: Creating New Recipes

**Design new recipe:**
1. Ask user what the recipe should do
2. Help them understand:
   - What inputs it needs (other charm results, well-known cells, user inputs)
   - What outputs it should produce
   - What processing logic is required

**Create recipe file:**
1. Guide user through creating a new .tsx file
2. Start with a template based on their requirements
3. Test syntax: `./dist/ct dev [new-recipe-path] --no-run`
4. Iterate on the recipe until it's correct

**Deploy new charm:**
1. Create the charm: `./dist/ct charm new --identity [keyfile] --api-url [api-url] --space [spacename] [new-recipe-path]`
2. Record the new CHARM_ID
3. Help user connect it to other charms as needed

#### Workflow C: Networking and Linking

**Inspect current connections:**
1. For each charm, run: `./dist/ct charm inspect --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id]`
2. Show user the current inputs and outputs
3. Identify unconnected inputs or useful outputs

**Create new links:**
1. Ask user what data flow they want to create
2. Help them understand source → target relationships
3. Execute links: `./dist/ct charm link --identity [keyfile] --api-url [api-url] --space [spacename] [source-charm]/[field] [target-charm]/[input-field]`
4. Verify the link worked by inspecting the target charm

**Remove links (if needed):**
1. If user wants to disconnect charms, guide them through identifying which links to remove
2. Use appropriate unlink commands (if available in ct)

### STEP 3: Advanced Recipe Development

**Working with complex data flows:**
1. Help user visualize the data flow between charms
2. Suggest intermediate processing recipes if needed
3. Guide creation of aggregator or transformer recipes

**Debugging recipes:**
1. Use inspect commands to see actual data: `./dist/ct charm inspect --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id] --json`
2. Help user understand why recipes might not be producing expected results
3. Suggest logging or debug outputs in recipes

**Recipe patterns:**
- **Filter recipes**: Take collection input, output filtered subset
- **Transformer recipes**: Convert data from one format to another  
- **Aggregator recipes**: Combine multiple inputs into single output
- **Generator recipes**: Create new data based on inputs
- **Side-effect recipes**: Perform actions (send emails, create files, etc.)

### STEP 4: Testing and Validation

**Test recipe changes:**
1. After any modification, inspect affected charms
2. Trace data flow through the network
3. Verify outputs match expectations

**Create test scenarios:**
1. Help user create test charms with known inputs
2. Connect to recipes being developed
3. Verify outputs are correct

### Common Recipe Development Tasks

**Finding recipe examples:**
- Search user's recipe repo: `find [recipe-path] -name "*.tsx" -type f | xargs grep -l "[pattern]"`
- Show similar recipes as examples
- Help adapt existing recipes for new purposes

**Understanding recipe structure:**
- Explain CommonTools recipe format
- Show how to define inputs, outputs, and processing
- Guide on using UI components and controls

**Performance considerations:**
- Advise on efficient data processing
- Suggest when to use pagination or batching
- Help optimize expensive operations

### Error Handling

**Recipe syntax errors:**
- Parse error messages from `ct dev`
- Guide user to fix TypeScript/JSX issues
- Suggest proper imports and types

**Runtime errors:**
- Help interpret charm execution errors
- Debug data type mismatches
- Fix missing or incorrect inputs

**Network errors:**
- Diagnose connection issues
- Verify API URL and identity
- Check space permissions

### Notes for Claude

- Always verify recipe syntax before deploying
- Keep track of charm IDs when creating new ones
- Help user understand data flow direction (source → target)
- Encourage incremental development and testing
- Save modified recipes to files before using setsrc
- Use inspect commands liberally to show current state

### Quick Command Reference

**Development Commands:**
```bash
# Get recipe source
./dist/ct charm getsrc --identity [key] --api-url [url] --space [space] --charm [id]

# Update recipe source  
./dist/ct charm setsrc --identity [key] --api-url [url] --space [space] --charm [id] [recipe-file]

# Test recipe syntax
./dist/ct dev [recipe-file] --no-run

# Create new charm
./dist/ct charm new --identity [key] --api-url [url] --space [space] [recipe-file]

# Link charms
./dist/ct charm link --identity [key] --api-url [url] --space [space] [source]/[field] [target]/[input]

# Inspect charm
./dist/ct charm inspect --identity [key] --api-url [url] --space [space] --charm [id]

# List all charms
./dist/ct charm ls --identity [key] --api-url [url] --space [space]
```

### Recipe Development Best Practices

1. **Start simple**: Create basic recipes first, then add complexity
2. **Test incrementally**: Deploy and test each change
3. **Use meaningful names**: Name charms and fields descriptively
4. **Document recipes**: Add comments explaining logic
5. **Handle errors**: Include error handling in recipes
6. **Validate inputs**: Check data types and required fields
7. **Output consistently**: Use predictable output structures

Remember: Recipe development is iterative. Help users build step by step, testing along the way.