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
  - Recipe development TypeScript setup (user should run `ct init` in recipes directory)

### STEP 2: Space-Specific Setup

**Get space name:**
- Ask user what they want to name their space (no spaces, lowercase recommended)
- Store as variable for commands

**Find recipe path:**
- Follow the recipe path discovery process from common/ct.md
- Once recipe path is found, user should run `ct init` in the recipes directory to set up TypeScript types
- Additionally, look specifically for these key recipes:
  - `find [user-provided-path] -name "*gmail*" -o -name "*email*" -o -name "*list*" | head -5`
  - Verify key recipes exist: `ls -la [user-provided-path]/coralreef/gmail.tsx` (or find where gmail.tsx is located)
  - If recipes are in a subfolder, help them find the right path: `find [user-provided-path] -name "recipes" -type d`

### STEP 3: Execute Space Setup Workflow

**For each step below, Claude should:**
1. Explain what we're doing
2. Run the command
3. Capture and show the charm ID from output
4. Verify the operation worked
5. Store charm IDs for later linking

**Create gmail charm:**
- Run: `./dist/ct charm new --identity [keyfile] --api-url [api-url] --space [spacename] [recipe-path]/coralreef/gmail.tsx`
- Extract and record the GMAIL_CHARM_ID from output
- Verify: `./dist/ct charm ls --identity [keyfile] --api-url [api-url] --space [spacename]`

**Create email-list charm:**
- Verify recipe exists: `ls -la [recipe-path]/email-list.tsx`
- Run: `./dist/ct charm new --identity [keyfile] --api-url [api-url] --space [spacename] [recipe-path]/email-list.tsx`
- Record EMAIL_LIST_CHARM_ID
- Link gmail results to email-list input: `./dist/ct charm link --identity [keyfile] --api-url [api-url] --space [spacename] [GMAIL_CHARM_ID]/emails [EMAIL_LIST_CHARM_ID]/emails`

**Create all-lists charm:**
- Verify recipe exists: `ls -la [recipe-path]/all-lists.tsx`
- Run: `./dist/ct charm new --identity [keyfile] --api-url [api-url] --space [spacename] [recipe-path]/all-lists.tsx`
- Record ALL_LISTS_CHARM_ID
- Link to well-known charms list: `./dist/ct charm link --identity [keyfile] --api-url [api-url] --space [spacename] baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye [ALL_LISTS_CHARM_ID]/allCharms`

**Create all-pages charm:**
- Verify recipe exists: `ls -la [recipe-path]/all-pages.tsx`
- Run: `./dist/ct charm new --identity [keyfile] --api-url [api-url] --space [spacename] [recipe-path]/all-pages.tsx`
- Record ALL_PAGES_CHARM_ID
- Link to well-known charms list: `./dist/ct charm link --identity [keyfile] --api-url [api-url] --space [spacename] baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye [ALL_PAGES_CHARM_ID]/allCharms`

**Create custom list charm:**
- Verify recipe exists: `ls -la [recipe-path]/list.tsx`
- Run: `./dist/ct charm new --identity [keyfile] --api-url [api-url] --space [spacename] [recipe-path]/list.tsx`
- Record LIST_CHARM_ID

**Create custom page charm:**
- Verify recipe exists: `ls -la [recipe-path]/page.tsx`
- Run: `./dist/ct charm new --identity [keyfile] --api-url [api-url] --space [spacename] [recipe-path]/page.tsx`
- Record PAGE_CHARM_ID

**Create page manager charm:**
- Verify recipe exists: `ls -la [recipe-path]/page-manager.tsx`
- Run: `./dist/ct charm new --identity [keyfile] --api-url [api-url] --space [spacename] [recipe-path]/page-manager.tsx`
- Record PAGE_MANAGER_CHARM_ID
- Link lists: `./dist/ct charm link --identity [keyfile] --api-url [api-url] --space [spacename] [ALL_LISTS_CHARM_ID]/lists [PAGE_MANAGER_CHARM_ID]/lists`
- Link pages: `./dist/ct charm link --identity [keyfile] --api-url [api-url] --space [spacename] [ALL_PAGES_CHARM_ID]/pages [PAGE_MANAGER_CHARM_ID]/pages`

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
- Verify files exist before proceeding: `ls -la [corrected-path]/gmail.tsx`

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
1. Gmail charm → extract emails field
2. Email-list charm → link to gmail/emails
3. All-lists charm → link to well-known charms list (baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye)
4. All-pages charm → link to well-known charms list
5. Custom list charm → standalone
6. Custom page charm → standalone
7. Page manager charm → link to all-lists/lists and all-pages/pages

### Well-Known IDs:
- Charms list in any space: `baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye`

### Space Setup Specific Notes:
- See `.claude/commands/common/ct.md` for general troubleshooting
- Recipe files needed for initial setup:
  - gmail.tsx (in coralreef subfolder)
  - email-list.tsx
  - all-lists.tsx
  - all-pages.tsx
  - list.tsx
  - page.tsx
  - page-manager.tsx
- Verify all these recipes exist before starting the setup workflow
