# Interactive Space Setup Script

This script guides Claude through setting up a complete space with the `ct` utility. Claude should follow these steps to interactively help the user set up recipes and network them together in a space.

## Script Flow for Claude

### STEP 1: Initial Setup Check and Preparation

**Check if user is in the right directory:**
- Run `pwd` to see current directory
- If not in `labs`, ask user to `cd` to the labs directory

**Check CT binary:**
- Run `ls -la ./dist/ct`
- If missing: Run `deno task build-binaries --cli-only` (this takes a few minutes)
- Verify with `./dist/ct --help`

**Check for identity keyfile:**
- Run `ls -la *.key`
- If no keyfiles found: Run `./dist/ct id new > space-identity.key`
- If keyfiles exist, ask user which one to use or create a new one

**Set up environment (recommend but don't require):**
- Ask if they want to set environment variables to make commands shorter
- If yes: Guide them to set `CT_API_URL="[their-api-url]"` and `CT_IDENTITY="./their-keyfile.key"`

### STEP 2: Gather Parameters

**Get API URL:**
- Ask user: "What is your CT API URL? (e.g., https://ct.dev, https://toolshed.saga-castor.ts.net/, or your custom instance)"
- Store as variable for all commands
- Test connectivity: `./dist/ct charm ls --identity [keyfile] --api-url [user-api-url] --space test-connection` (this might fail but shows if URL works)

**Get space name:**
- Ask user what they want to name their space (no spaces, lowercase recommended)
- Store as variable for commands

**Find recipe path (recipes are in a separate repo, not in labs):**
- Ask user: "Where is your recipe repository located? Please provide the full path (e.g., /Users/username/my-recipes or ../my-recipe-repo)"
- User will need to provide the path to their recipe repository
- Once they provide a path, verify it exists: `ls -la [user-provided-path]`
- Look for recipe files in their repo: `find [user-provided-path] -name "*.tsx" | head -10`
- Look specifically for key recipes: `find [user-provided-path] -name "*gmail*" -o -name "*email*" -o -name "*list*" | head -5`
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
- Link: `./dist/ct charm link --identity [keyfile] --api-url [api-url] --space [spacename] [GMAIL_CHARM_ID]/emails [EMAIL_LIST_CHARM_ID]/emails`

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

**If any command fails:**
- Show the error
- Check common issues (file permissions, network, file existence)
- Offer solutions or ask user for clarification
- Don't continue to dependent steps until current step works

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

### Notes for Claude

- Always run commands and show real output to user
- Extract and track charm IDs as you go (they start with "bafy")
- Verify each step worked before proceeding
- Be helpful if user needs to troubleshoot
- Ask questions when paths or parameters are unclear
- Keep track of what's been created to avoid duplicates

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

### Key Commands Claude Will Use:
- `./dist/ct charm new --identity [keyfile] --api-url [api-url] --space [spacename] [recipe-path]` - Create charm
- `./dist/ct charm link --identity [keyfile] --api-url [api-url] --space [spacename] [source]/[field] [target]/[field]` - Link charms
- `./dist/ct charm ls --identity [keyfile] --api-url [api-url] --space [spacename]` - List charms
- `./dist/ct charm inspect --identity [keyfile] --api-url [api-url] --space [spacename] --charm [id]` - Inspect charm details
- `./dist/ct charm inspect --identity [keyfile] --api-url [api-url] --space [spacename] [charmId]` - Inspect charm details (alternative syntax)
- `./dist/ct charm inspect --identity [keyfile] --api-url [api-url] --space [spacename] [charmId] --json` - Output raw JSON data

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

### Troubleshooting for Claude:
- If commands fail, check file existence first
- Charm IDs start with "bafy" and are long content hashes
- Recipe files are .tsx files in a separate repository (not in labs)
- Users must provide the full path to their recipe repository
- Users must provide their CT API URL (not always https://ct.dev)
- Environment variables CT_API_URL and CT_IDENTITY can simplify commands
- Test recipes with `./dist/ct dev [full-path-to-recipe] --no-run` if there are issues
- Always use absolute paths or full relative paths to the external recipe repo
- If API connection fails, verify the URL is correct and accessible
