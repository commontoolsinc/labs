# Interactive Space Setup Script

This script guides Claude through setting up a complete space with the `ct` utility. Claude should follow these steps to interactively help the user set up recipes and network them together in a space.

## Script Flow for Claude

### STEP 1: Initial Setup Check and Preparation

**Read common setup instructions:**
- First, read `.claude/commands/common/ct.md` for shared CT binary setup and configuration
- Follow those instructions for:
  - Checking if user is in the right directory (should be in `labs`)
  - CT binary check and build if needed
  - Identity keyfile management
  - Environment variable setup (CT_API_URL and CT_IDENTITY)
  - API URL collection and connectivity test
  - **Note:** Claude Code cannot cd into directories. User should run `ct init` manually in their recipes directory for TypeScript setup

### STEP 2: Space-Specific Setup

**Get space name:**
- Ask user what they want to name their space (no spaces, lowercase recommended)
- Store as variable for commands

**Find recipe path:**
- Follow the recipe path discovery process from common/ct.md
- **Important:** User must run `ct init` manually in their recipes directory (Claude Code cannot cd into directories)
- Look specifically for these key recipes:
  - `find [user-provided-path] -name "*gmail*" -o -name "*simple-list*" -o -name "*page*" -o -name "*factory*" | head -10`
  - Verify key recipes exist: `ls -la [user-provided-path]/gmail.tsx [user-provided-path]/simple-list.tsx [user-provided-path]/page.tsx [user-provided-path]/factory.tsx`
  - If recipes are in a subfolder, help them find the right path: `find [user-provided-path] -name "recipes" -type d`

### STEP 3: Execute Space Setup Workflow

**For each step below, Claude should:**
1. Explain what we're doing
2. Run the command
3. Capture and show the charm ID from output
4. Verify the operation worked
5. Store charm IDs for later linking

**Create simple-list charm:**
- Verify recipe exists: `ls -la [recipe-path]/simple-list.tsx`
- Run: `./dist/ct charm new --identity [keyfile] --api-url [api-url] --space [spacename] [recipe-path]/simple-list.tsx`
- Extract and record the SIMPLE_LIST_CHARM_ID from output
- Verify: `./dist/ct charm ls --identity [keyfile] --api-url [api-url] --space [spacename]`

**Create gmail charm:**
- Verify recipe exists: `ls -la [recipe-path]/gmail.tsx`
- Run: `./dist/ct charm new --identity [keyfile] --api-url [api-url] --space [spacename] [recipe-path]/gmail.tsx`
- Record GMAIL_CHARM_ID

**Create page charm:**
- Verify recipe exists: `ls -la [recipe-path]/page.tsx`
- Run: `./dist/ct charm new --identity [keyfile] --api-url [api-url] --space [spacename] [recipe-path]/page.tsx`
- Record PAGE_CHARM_ID
- Link well-known charms list to page allCharms input: `./dist/ct charm link --identity [keyfile] --api-url [api-url] --space [spacename] baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye [PAGE_CHARM_ID]/allCharms`
- Link well-known charms list to page mentionable input: `./dist/ct charm link --identity [keyfile] --api-url [api-url] --space [spacename] baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye [PAGE_CHARM_ID]/mentionable`

**Create factory charm:**
- Verify recipe exists: `ls -la [recipe-path]/factory.tsx`
- Run: `./dist/ct charm new --identity [keyfile] --api-url [api-url] --space [spacename] [recipe-path]/factory.tsx`
- Record FACTORY_CHARM_ID
- Link well-known charms list to factory allCharms input: `./dist/ct charm link --identity [keyfile] --api-url [api-url] --space [spacename] baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye [FACTORY_CHARM_ID]/allCharms`
- Link well-known charms list to factory mentionable input: `./dist/ct charm link --identity [keyfile] --api-url [api-url] --space [spacename] baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye [FACTORY_CHARM_ID]/mentionable`

### STEP 4: Final Verification and Optional Setup

**Show final space:**
- Run: `./dist/ct charm ls --identity [keyfile] --api-url [api-url] --space [spacename]`
- Explain what each charm does

**Offer additional recipes:**
- Run: `find [recipe-path] -name "*.tsx" -type f`
- Ask user if they want to deploy any additional recipes
- For each additional recipe: verify, create charm, ask about linking needs

### Error Handling

**General error handling:**
- Refer to error handling section in `.claude/commands/common/ct.md` for common issues
- Don't continue to dependent steps until current step works

**Space setup specific errors:**

**If recipe files are missing:**
- Ask user to double-check the recipe repository path
- Help user locate them: `find [user-provided-path] -name "*.tsx" -type f`
- Look in common subdirectories: `find [user-provided-path] -name "recipes" -type d`
- Ask user to provide the correct path to their recipe repository
- Verify all required files exist before proceeding: `ls -la [corrected-path]/simple-list.tsx [corrected-path]/gmail.tsx [corrected-path]/page.tsx [corrected-path]/factory.tsx`

**If charm creation fails:**
- Test recipe syntax with `./dist/ct dev [recipe] --no-run`
- Check network connectivity
- Verify identity file permissions

### Data Management During Setup

**Viewing charm data:**
Use the new cell get commands to inspect charm data during setup:
```bash
# View charm input parameters
./dist/ct charm get --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id] title

# View nested data
./dist/ct charm get --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id] config/apiKey

# View array elements
./dist/ct charm get --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id] items/0/name
```

**Modifying charm data:**
Use cell set commands to configure charms during setup:
```bash
# Set simple values
echo '"Updated Title"' | ./dist/ct charm set --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id] title

# Set configuration objects
echo '{"apiKey": "your-key", "enabled": true}' | ./dist/ct charm set --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id] config

# Set array data
echo '[{"name": "Item 1"}, {"name": "Item 2"}]' | ./dist/ct charm set --identity [keyfile] --api-url [api-url] --space [spacename] --charm [charm-id] items
```

### Notes for Claude

- Always run commands and show real output to user
- Extract and track charm IDs as you go (they start with "bafy")
- Verify each step worked before proceeding
- Be helpful if user needs to troubleshoot
- Ask questions when paths or parameters are unclear
- Keep track of what's been created to avoid duplicates
- Use cell get/set commands to inspect and configure charm data as needed

### Important: External Recipe Repository Handling

- **Recipes are NOT in the labs repo** - they are in a separate repository
- **Always ask user for the full path** to their recipe repository first
- **Example paths might be:**
  - `/Users/username/my-recipes`
  - `../my-recipe-repo`
  - `/home/user/projects/recipe-collection`
- **Validate the path exists** before proceeding: `ls -la [user-path]`
- **Find recipes in their repo** with: `find [user-path] -name "*.tsx" | head -10`
- **Use full paths in all ct commands** - don't assume recipes are local to labs
- **If user gives wrong path**, help them find the right location with find commands

## Reference Information for Claude

### Key Commands and Linking Concepts:
- See `.claude/commands/common/ct.md` for:
  - Complete list of CT commands
  - Understanding linking syntax and concepts
  - Examples of charm-to-charm and well-known ID linking

### Expected Workflow:
1. Simple-list charm → standalone list for basic items
2. Gmail charm → standalone email fetcher
3. Page charm → link well-known charms list to its allCharms and mentionable inputs
4. Factory charm → link well-known charms list to its allCharms and mentionable inputs

### Well-Known IDs:
- Charms list in any space: `baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye`

### Space Setup Specific Notes:
- See `.claude/commands/common/ct.md` for general troubleshooting
- Recipe files needed for initial setup:
  - simple-list.tsx
  - gmail.tsx
  - page.tsx
  - factory.tsx
- Verify all these recipes exist before starting the setup workflow
- Remember: Claude Code cannot cd into directories - user must manually run `ct init` in their recipes directory
