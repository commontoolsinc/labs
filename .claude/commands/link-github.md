# GitHub Auto-Linking Command

This command automatically detects GitHub URLs in page.tsx charm outliner trees and creates linked GitHub repository fetcher charms for each discovered URL.

## Usage

```bash
/link-github [API_URL] [SPACE_NAME] [IDENTITY_FILE] [RECIPES_PATH] [PAGE_CHARM_ID]
```

**Parameters:**
- `API_URL`: CommonTools API endpoint (e.g., `https://toolshed.saga-castor.ts.net/`)
- `SPACE_NAME`: Target space name
- `IDENTITY_FILE`: Path to CT identity key file
- `RECIPES_PATH`: Path to recipes directory containing `github-repo-fetcher.tsx`
- `PAGE_CHARM_ID`: Specific page charm ID to process (optional - if not provided, scans all page charms)

### Example Usage

```bash
# Process all page charms in a space
/link-github https://toolshed.saga-castor.ts.net/ space ~/dev/.ct.key /Users/ben/code/recipes/recipes

# Process a specific page charm
/link-github https://toolshed.saga-castor.ts.net/ space ~/dev/.ct.key /Users/ben/code/recipes/recipes baedreieh2l6lhin5p4avk7hloirv75fllarf6di47vhnsfclwexn26jnfm
```

### Test Results

The command has been validated with the following test case:
- **Detected GitHub URL**: `https://github.com/vercel/next.js` in page charm `baedreieh2l...`
- **Created GitHub fetcher charm**: `baedreifiv7...` configured for vercel/next.js repository
- **Successfully linked**: GitHub fetcher attached to `outline/root/children/0/children/0/attachments/0`
- **Data verification**: Attachment contains complete Next.js repository metadata (133,486 stars, 28,954 forks, MIT license, etc.)

## Workflow

This command orchestrates a complex multi-step process using subagents and parallel execution:

### Phase 1: Discovery and Analysis
1. **Find Page Charms**: Scan space for page.tsx-based charms
2. **Extract Outline Trees**: Get the complete outliner structure from each page
3. **Detect GitHub URLs**: Parse through all nodes and their body text to find GitHub repository URLs
4. **Map Insertion Points**: Identify exactly where attachments should be linked

### Phase 2: Preparation and Creation
1. **Create GitHub Fetcher Charms**: Deploy new github-repo-fetcher.tsx instances for each unique URL
2. **Prepare Attachment Slots**: Insert `[null]` placeholders in the attachment arrays
3. **Configure Repository URLs**: Set the repoUrl input for each GitHub fetcher charm

### Phase 3: Linking and Verification
1. **Execute Charm Links**: Connect GitHub fetcher charms to their attachment slots
2. **Verify Links**: Ensure all connections are established correctly
3. **Report Results**: Provide summary of created charms and established links

## Implementation Strategy

The command uses specialized subagents for different phases:

- **`codebase-researcher`**: For analyzing existing page structures and finding GitHub URLs
- **`plan-implementer`**: For executing the systematic charm creation and linking process
- **`systematic-debugger`**: For troubleshooting any linking failures

## Parallelization

To optimize performance, the command:
- Processes multiple page charms simultaneously
- Creates GitHub fetcher charms in parallel batches
- Executes multiple link operations concurrently
- Uses efficient CT operations to minimize API calls

## Context Management

Since this process involves many operations across multiple charms:
- Maintains a working state file during execution
- Batches CT operations to reduce context overhead
- Uses incremental processing to handle large spaces
- Provides progress reporting throughout execution

## Error Handling

The command handles common failure scenarios:
- Invalid GitHub URLs (skips with warning)
- Charm creation failures (retries with different approaches)
- Link operation failures (provides detailed diagnostics)
- Network timeouts (implements retry logic)

## Example Output

```
🔍 Scanning space 'project-docs' for page charms...
   Found 3 page charms to analyze

📖 Analyzing outliner trees for GitHub URLs...
   charm-abc123: Found 2 GitHub URLs
   charm-def456: Found 1 GitHub URL  
   charm-ghi789: No GitHub URLs found

🛠️  Creating GitHub fetcher charms...
   ✓ Created fetcher for https://github.com/user/repo1 (charm-new001)
   ✓ Created fetcher for https://github.com/org/repo2 (charm-new002)
   ✓ Created fetcher for https://github.com/team/repo3 (charm-new003)

🔗 Linking charms to attachment points...
   ✓ Linked charm-new001 → charm-abc123/outline/root/children/0/attachments/0
   ✓ Linked charm-new002 → charm-abc123/outline/root/children/1/children/0/attachments/0
   ✓ Linked charm-new003 → charm-def456/outline/root/children/2/attachments/0

✅ Successfully processed 3 GitHub URLs across 2 page charms
   Created 3 new GitHub fetcher charms
   Established 3 attachment links
```

## Technical Notes

### GitHub URL Detection Pattern
The command uses regex pattern: `https://github\.com/[^/\s]+/[^/\s]+(?:/[^\s]*)?`

### Attachment Linking Process
1. Insert `[null]` at target attachment path: `echo '[null]' | ct charm set ... attachments/N`
2. Execute link operation: `ct charm link source-charm target-charm/path/to/attachments/N`

### Data Structures
The command maintains internal state tracking:
- `pageCharms`: Map of charm IDs to their outliner structures
- `githubUrls`: Array of discovered URLs with their insertion points
- `createdCharms`: Map of GitHub URLs to their fetcher charm IDs
- `linkOperations`: Array of pending/completed link operations

### Performance Optimizations
- Uses CT's batch operations where possible
- Implements intelligent caching of charm data
- Parallelizes independent operations
- Minimizes redundant API calls through smart state management

## Future Enhancements

- Support for other repository platforms (GitLab, Bitbucket)
- Configurable attachment insertion strategies
- Integration with existing GitHub fetcher charms (reuse instead of create new)
- Advanced GitHub URL parsing (branches, commits, issues)
- Dry-run mode for testing without making changes

---

# CLAUDE IMPLEMENTATION

When this command is invoked, Claude should execute the following workflow:

## Step 1: Parameter Setup and Validation

```markdown
Parse command arguments and set up CT parameters:
- API_URL (required)
- SPACE_NAME (required) 
- IDENTITY_FILE (required)
- RECIPES_PATH (required)
- PAGE_CHARM_ID (optional)

Verify CT binary and identity file exist.
Verify recipes path contains github-repo-fetcher.tsx.
```

## Step 2: Launch Discovery Subagent

```markdown
Use Task tool with codebase-researcher agent:

"I need you to discover and analyze page charms in a CommonTools space to find GitHub URLs for automated linking.

Parameters:
- API URL: [API_URL]
- Space: [SPACE_NAME] 
- Identity: [IDENTITY_FILE]
- Target charm ID: [PAGE_CHARM_ID] (if specified)

Tasks:
1. List all charms in the space using: `./dist/ct charm ls --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME]`

2. Filter for page charms (either by name pattern or by inspecting charm structure)

3. For each page charm, extract the complete outliner tree using: `./dist/ct charm get --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] --charm [CHARM_ID] outline`

4. Scan through all nodes recursively to find GitHub URLs in body text using pattern: `https://github\.com/[^/\s]+/[^/\s]+`

5. For each GitHub URL found, record:
   - The URL itself
   - The exact path to the node containing it (e.g., 'outline/root/children/0/children/1')
   - Whether there's already an attachments array at that location
   - The index where a new attachment should be inserted

Return a detailed analysis with:
- Total page charms found
- GitHub URLs discovered (URL, location path, insertion point)
- Any existing attachments that might need to be preserved
- Recommended attachment insertion strategy for each URL"
```

## Step 3: Launch Creation and Linking Subagent

```markdown
Use Task tool with plan-implementer agent:

"Based on the GitHub URL analysis, systematically create GitHub fetcher charms and link them to page outliner attachments.

Analysis Data: [Pass results from Step 2]

Implementation Plan:
1. For each unique GitHub URL discovered:
   a. Create a new GitHub fetcher charm using: `./dist/ct charm new --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] [RECIPES_PATH]/github-repo-fetcher.tsx`
   b. Set the repoUrl input: `echo '\"[GITHUB_URL]\"' | ./dist/ct charm set --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] --charm [NEW_CHARM_ID] repoUrl --input`
   c. Record the new charm ID for linking

2. For each attachment insertion point:
   a. Ensure attachments array exists or create it: `echo '[]' | ./dist/ct charm set --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] --charm [PAGE_CHARM_ID] [PATH_TO_ATTACHMENTS]` (if needed)
   b. Add null placeholder: `echo '[null]' | ./dist/ct charm set --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] --charm [PAGE_CHARM_ID] [PATH_TO_ATTACHMENTS]/[INDEX]`
   c. Create the link: `./dist/ct charm link --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] [GITHUB_FETCHER_CHARM_ID] [PAGE_CHARM_ID]/[PATH_TO_ATTACHMENTS]/[INDEX]`

3. Verify all links are working by inspecting the final attachment structures

Execute this plan systematically, providing progress updates and handling any errors that occur. Use parallel execution where possible for creating multiple GitHub fetcher charms simultaneously."
```

## Step 4: Results Processing and Reporting

```markdown
After both subagents complete:

1. Collect and summarize results:
   - Number of page charms processed
   - Number of GitHub URLs found and processed
   - Number of new GitHub fetcher charms created
   - Number of successful attachment links established
   - Any errors or warnings encountered

2. Display formatted results showing:
   - Each GitHub URL and its linked location
   - New charm IDs created
   - Links established

3. Optionally verify a few links by checking the attachment structures contain the expected GitHub fetcher data
```

## Error Handling Strategy

```markdown
If Step 2 (Discovery) fails:
- Use systematic-debugger agent to diagnose CT connection issues
- Retry with simpler charm listing approaches
- Provide meaningful error messages about space access or identity problems

If Step 3 (Implementation) fails:
- Use systematic-debugger agent to identify specific failures
- Implement retry logic for failed charm creations
- Provide recovery suggestions for partial completion scenarios
- Ensure no orphaned charms are left in invalid states

For any network or CT operation failures:
- Implement exponential backoff retry logic
- Provide clear diagnostic information
- Suggest manual recovery steps if automated retry fails
```

## Context Management

```markdown
To manage context efficiently:
1. Store intermediate results in TodoWrite tool for tracking progress
2. Use concise data structures when passing information between subagents
3. Focus subagent prompts on specific, actionable tasks
4. Minimize redundant CT operations by caching charm data where possible
5. Use parallel Task tool invocations for independent operations
```

## Performance Optimizations

```markdown
1. Batch CT operations where possible:
   - Group multiple `ct charm get` operations into parallel bash commands
   - Create multiple GitHub fetcher charms simultaneously

2. Use smart caching:
   - Cache outliner tree data to avoid re-fetching
   - Reuse GitHub fetcher charms for duplicate URLs (future enhancement)

3. Intelligent parallelization:
   - Process multiple page charms simultaneously during discovery
   - Create GitHub fetcher charms in parallel batches
   - Execute link operations concurrently where safe
```

This implementation provides a robust, maintainable approach to automated GitHub URL linking that can handle complex scenarios while providing clear feedback and error recovery.