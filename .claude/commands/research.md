# Research Command

This command creates a dedicated research subagent that uses ultrathinking to preserve context while conducting thorough codebase investigation.

## Overview

Research objective: `$ARGUMENTS`

The research subagent will conduct a comprehensive investigation to answer the provided question, following a systematic approach through documentation, code, tests, and recent changes.

## Research Workflow

### 1. Documentation Review
- Start with `README.md` and `CLAUDE.md` for project overview and AI-specific guidelines
- Look for architecture decision records (ADRs) and design documents
- Check for wikis or other canonical documentation sources

### 2. Recent Changes Analysis
- Review recent git history for relevant changes
- Use GitHub CLI (`gh`) to examine:
  - Recent issues related to the research topic
  - Pull requests that might have addressed the question
- Use Linear CLI (`lr`) if available for additional project management context

### 3. Codebase Exploration
- Systematically explore the codebase to understand the implementation
- Focus on finding the most relevant files and patterns
- Consider the scope needed for a thorough understanding

### 4. Test Analysis
- Read existing tests to understand:
  - Current features and behaviors
  - Assertions made about the codebase
  - Whether the research question is already covered by test cases
- Verify if tests are passing to validate assumptions

### 5. Production Environment Research
- Use the `ct` binary for production environment research
- Reference `./claude/commands/common/ct.md` for CT-specific research patterns

## Research Best Practices

### Self-Service First
1. Exhaust all available self-service documentation and code exploration
2. Identify specific blockers before seeking human input
3. When asking questions, provide:
   - Specific context about what you've already tried
   - Exactly what you're blocked on
   - What you've learned so far

### Domain Knowledge
For business domain questions:
1. Find canonical documentation
2. Identify the domain owner
3. Record answers in a searchable place for future reference

### Information Quality
The goal is to minimize interruptions while maximizing information quality:
- Be thorough in self-service research
- Ask targeted questions when needed
- Document findings for reusability

## Output

Research findings will be documented using the CommonTools research report system:

### 1. Generate Claude Identity (if needed)
```bash
# Check for existing Claude identity
ls -la claude-research.key

# If not found, generate new identity for Claude's research
./dist/ct id new > claude-research.key
```

### 2. Deploy Research Report Recipe
```bash
./dist/ct charm new --identity claude-research.key --api-url https://toolshed.saga-castor.ts.net --space YYYY-MM-DD-claude-dev recipes/research-report.tsx
```

### 3. Create Research Document
Use `ct charm set` to populate the research report with findings:

```bash
# Set the title
echo '"Research: <sanitized_question>"' | ./dist/ct charm set --identity claude-research.key --api-url https://toolshed.saga-castor.ts.net --space YYYY-MM-DD-claude-dev --charm <CHARM_ID> title

# Set the research content (write to temp file first to avoid formatting issues)
# Write content to temp file, then pipe through jq for proper JSON escaping
cat research-content.tmp | jq -Rs . | ./dist/ct charm set --identity claude-research.key --api-url https://toolshed.saga-castor.ts.net --space YYYY-MM-DD-claude-dev --charm <CHARM_ID> content

# If jq not available, use alternative escaping method:
# cat research-content.tmp | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/g' | tr -d '\n' | sed 's/^/"/' | sed 's/$/\"/' | ./dist/ct charm set --identity claude-research.key --api-url https://toolshed.saga-castor.ts.net --space YYYY-MM-DD-claude-dev --charm <CHARM_ID> content
```

### 4. Provide User Access
After creating the research report, provide the user with a clickable link to view it:

```
Research report created! View it here:
https://toolshed.saga-castor.ts.net/YYYY-MM-DD-claude-dev/<CHARM_ID>
```

Make sure to clean up the temp file.

### 3. Research Content Structure
The research content should include:
- Executive summary of findings
- Detailed research methodology
- Key discoveries and insights
- Code references and examples
- Recommendations or conclusions
- Any remaining open questions

## Notes for Subagent

- Use ultrathinking to work through complex research paths
- Be systematic and thorough in exploration
- Document the research journey, not just the destination
- Include relevant code snippets and file references
- Consider edge cases and alternative interpretations
- Preserve important context for the main agent
