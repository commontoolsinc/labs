# Deploy Research Command

Deploy research findings as a CommonTools research report.

## Usage

`/deploy-research [research content or file]`

## Process

Launch a deployment subagent using the Task tool:

```
Task: Deploy research findings to CommonTools

You are a deployment specialist. Take the provided research content and deploy it as a CommonTools research report.

**Your Task:**
1. Check for claude-research.key identity (create if needed)
2. Deploy charm using recipes/research-report.tsx
3. Set title and content using CT commands
4. Return the final URL to the user

**Research Content:** [paste research findings here]

**Return to me:** The deployed research report URL.
```

## Deployment Steps

### 1. Check/Generate Claude Identity
```bash
# Check for existing identity
ls -la claude-research.key

# If not found, generate new one
./dist/ct id new > claude-research.key
```

### 2. Create Research Report Charm
```bash
./dist/ct charm new --identity claude-research.key --api-url https://toolshed.saga-castor.ts.net --space YYYY-MM-DD-claude-dev recipes/research-report.tsx
```

### 3. Set Title and Content
```bash
# Set the title
echo '"Research: <topic>"' | ./dist/ct charm set --identity claude-research.key --api-url https://toolshed.saga-castor.ts.net --space YYYY-MM-DD-claude-dev --charm <CHARM_ID> title

# Set the content (use temp file for complex content)
cat research-content.tmp | jq -Rs . | ./dist/ct charm set --identity claude-research.key --api-url https://toolshed.saga-castor.ts.net --space YYYY-MM-DD-claude-dev --charm <CHARM_ID> content

# Clean up
rm research-content.tmp
```

### 4. Provide URL
Return the final URL:
```
https://toolshed.saga-castor.ts.net/YYYY-MM-DD-claude-dev/<CHARM_ID>
```

## Standard Parameters
- **Identity**: `claude-research.key`
- **API URL**: `https://toolshed.saga-castor.ts.net`
- **Space**: `YYYY-MM-DD-claude-dev` (use current date)
- **Recipe**: `recipes/research-report.tsx`

## Error Handling
- If deployment fails, provide research findings directly to user
- Don't block research results on deployment issues
- Validate JSON formatting before setting content