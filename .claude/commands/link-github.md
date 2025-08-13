# GitHub Auto-Linking Command

This command finds GitHub URLs in page.tsx charms and creates linked GitHub repository fetcher charms for each URL.

## Prerequisites

- **Recipe Required**: The `github-repo-fetcher.tsx` recipe must exist in your recipes directory

## Usage

```bash
/link-github [API_URL] [SPACE_NAME] [IDENTITY_FILE] [RECIPES_PATH] [PAGE_CHARM_ID]
```

**Parameters:**
- `API_URL`: CommonTools API endpoint
- `SPACE_NAME`: Target space name
- `IDENTITY_FILE`: Path to CT identity key file
- `RECIPES_PATH`: Path to recipes directory containing `github-repo-fetcher.tsx`
- `PAGE_CHARM_ID`: Specific page charm ID to process (optional)

## Direct Execution Steps

### Step 1: Find Page Charms
```bash
# List all charms
./dist/ct charm ls --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME]

# For each charm, check if it's a page by trying to get its outline
./dist/ct charm get --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] --charm [CHARM_ID] outline

# If this returns data with a 'root' structure, it's a page charm
```

### Step 2: Extract GitHub URLs from Outline
For each page charm:
```bash
# IMPORTANT: For efficiency, especially when re-scanning, use jq to avoid pulling massive attachment data
# Get only nodes with empty attachments (unlinked URLs)
./dist/ct charm get --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] --charm [CHARM_ID] outline | jq '.root.children[].children[] | select(.attachments == []) | {body: .body, path: path(.)}'

# Or for a specific path to avoid large JSON responses:
./dist/ct charm get --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] --charm [CHARM_ID] outline | jq '.root.children[0].children[3]'

# Look for patterns like: https://github.com/[owner]/[repo]
```

### Step 3: Create GitHub Fetcher Charms
For each unique GitHub URL found:
```bash
# Create new github-repo-fetcher charm
./dist/ct charm new --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] [RECIPES_PATH]/github-repo-fetcher.tsx

# Set the repoUrl input (note the double quotes in the echo)
echo '"https://github.com/owner/repo"' | ./dist/ct charm set --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] --charm [NEW_CHARM_ID] repoUrl --input
```

### Step 4: Link to Page Attachments
For each node containing a GitHub URL:
```bash
# Link the github fetcher charm to the node's attachments array at index 0
./dist/ct charm link --identity [IDENTITY_FILE] --api-url [API_URL] --space [SPACE_NAME] [GITHUB_FETCHER_CHARM_ID] [PAGE_CHARM_ID]/[PATH_TO_NODE]/attachments/0

# Example path: charm1/outline/root/children/1/attachments/0
```

**Important Note**: The path requires the `page/` prefix because the input and output data shapes differ for page charms. While `ct charm get` returns the outline directly, when linking you must specify the `page/` prefix to target the correct input structure. You can verify this difference using `ct charm inspect [PAGE_CHARM_ID]` which shows the full input/output schema.

## How to Traverse the Outline

The outline structure looks like:
```json
{
  "root": {
    "body": "text that might contain https://github.com/user/repo",
    "children": [
      {
        "body": "more text",
        "children": [],
        "attachments": []
      }
    ],
    "attachments": []
  }
}
```

When searching:
1. Check the `body` field of each node
2. Recursively check all `children`
3. Record the path to any node containing a GitHub URL
4. Only link to nodes that actually contain the URL (not parent/child nodes)

## Error Handling

- **Non-page charms**: Skip silently if `ct charm get outline` fails
- **404 GitHub URLs**: Skip and continue with other URLs
- **Existing attachments**: Skip nodes that already have attachments (check with `attachments != []`)

## Complete Example

```bash
# Step 1: List charms
./dist/ct charm ls --identity ~/dev/.ct.key --api-url https://toolshed.saga-castor.ts.net --space 2025-08-06-ben-dev
# Returns: charm1, charm2, charm3

# Step 2: Check each for outline
./dist/ct charm get --identity ~/dev/.ct.key --api-url https://toolshed.saga-castor.ts.net --space 2025-08-06-ben-dev --charm charm1 outline
# Returns outline data - this is a page charm!

# Step 3: Found https://github.com/vercel/next.js in outline/root/children/0/body

# Step 4: Create fetcher
./dist/ct charm new --identity ~/dev/.ct.key --api-url https://toolshed.saga-castor.ts.net --space 2025-08-06-ben-dev ~/code/recipes/recipes/github-repo-fetcher.tsx
# Returns: newcharm123

# Step 5: Configure fetcher
echo '"https://github.com/vercel/next.js"' | ./dist/ct charm set --identity ~/dev/.ct.key --api-url https://toolshed.saga-castor.ts.net --space 2025-08-06-ben-dev --charm newcharm123 repoUrl --input

# Step 6: Link to page
./dist/ct charm link --identity ~/dev/.ct.key --api-url https://toolshed.saga-castor.ts.net --space 2025-08-06-ben-dev newcharm123 charm1/outline/root/children/0/attachments/0
```

## Summary Output

```
Found 3 page charms
Found 2 GitHub URLs:
  - https://github.com/vercel/next.js at charm1/outline/root/children/0
  - https://github.com/facebook/react at charm2/outline/root/children/1
Created 2 github-repo-fetcher charms
Successfully linked all GitHub repositories
```

---

# CLAUDE IMPLEMENTATION

When this command is invoked, Claude should:

1. **Parse arguments** from .common.json or command line
2. **Verify prerequisites** (recipes directory, CT binary)
3. **Execute the Direct Execution Steps** as documented above
4. **Track progress** using TodoWrite tool
5. **Report results** concisely

Do NOT use subagents unless dealing with 10+ page charms. Just follow the steps directly.

## Re-scanning Best Practices

When re-scanning for new URLs:

1. **Use precise jq queries** to filter only unlinked nodes:
   ```bash
   jq '.root.children[].children[] | select(.attachments == [])'
   ```

2. **Target specific paths** when you know where new URLs might be:
   ```bash
   jq '.root.children[0].children[3]'
   ```

3. **Avoid pulling full outline** when attachments contain large JSON data
   - Each linked GitHub repo adds ~200+ lines of JSON to the attachment
   - Use filtering to get only what you need

4. **Check attachment status** before creating new fetchers:
   - Only process nodes where `attachments == []`
   - This prevents duplicate fetchers for already-linked URLs
