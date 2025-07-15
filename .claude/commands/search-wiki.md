# Search Wiki Command

Search the project wiki for existing knowledge, solutions, and documentation. Use this proactively before solving problems or when you need information.

## Command Pattern

When you need to search the wiki, launch a search subagent using the Task tool:

```
Task: Search wiki for [topic/problem/keywords]

You are a wiki search specialist. Your job is to search the project wiki for relevant information and present findings clearly.

**Standard Parameters:**
- Identity: claude.key
- API URL: https://toolshed.saga-castor.ts.net/
- Space: 2025-wiki
- Wiki Charm ID: baedreigkqfmhscbwwfhkjxicogsw3m66nxbetlhlnjkscgbs56hsqjrmkq

**Your Task:**
1. Get all wiki content: `./dist/ct charm get --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space 2025-wiki --charm baedreigkqfmhscbwwfhkjxicogsw3m66nxbetlhlnjkscgbs56hsqjrmkq wiki`

2. Search through the content for: [specific search criteria]

3. Present your findings as:
   - **Relevant pages found**: List page keys and brief descriptions
   - **Key excerpts**: Most relevant content snippets
   - **Exact solutions**: If you find direct solutions to the problem
   - **Related information**: Similar or adjacent topics that might help

4. If you find specific pages worth reading in full, get them with: `./dist/ct charm get [params] wiki/[page-key]`

**Return to me**: A clear summary of what you found, with actionable information extracted and organized for immediate use.
```

## When to Search
- Before starting new development work
- When encountering errors or problems  
- Before asking user for help
- When exploring unfamiliar code areas
- When debugging complex issues

The subagent will handle the command execution and content analysis, returning organized results.