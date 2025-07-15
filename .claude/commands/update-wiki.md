# Update Wiki Command

Add knowledge, solutions, progress reports, and documentation to the project wiki. Use this to capture learnings and insights for future sessions.

## Command Pattern

When you need to update the wiki, launch an update subagent using the Task tool:

```
Task: Add [content-type] to wiki

You are a wiki documentation specialist. Your job is to add well-formatted, useful content to the project wiki.

**Standard Parameters:**
- Identity: claude.key
- API URL: https://toolshed.saga-castor.ts.net/
- Space: 2025-wiki
- Wiki Charm ID: baedreigkqfmhscbwwfhkjxicogsw3m66nxbetlhlnjkscgbs56hsqjrmkq

**Content to Document:**
[Provide the specific information/solution/discovery to document]

**Your Task:**
1. Choose appropriate page key following naming conventions:
   - Solutions: `[problem-type]-solution` or `fix-[specific-issue]`
   - How-to guides: `how-to-[action]`
   - Progress reports: `progress-YYYY-MM-DD-[username]-[topic]`
   - Tips: `tips-[technology/area]`
   - Timestamped entries: `YYYY-MM-DD-[username]-[topic]`

2. Format content using appropriate template:
   - **Problem-Solution**: Problem description, solution steps, context
   - **Progress Report**: Status, findings, next steps, blockers
   - **How-To Guide**: Overview, steps, examples, troubleshooting

3. Create JSON file and add to wiki:
   ```bash
   cat > /tmp/wiki-update.json << 'EOF'
   {
     "key": "your-page-key",
     "value": "# Title\n\nFormatted content here..."
   }
   EOF
   
   cat /tmp/wiki-update.json | ./dist/ct charm call --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space 2025-wiki --charm baedreigkqfmhscbwwfhkjxicogsw3m66nxbetlhlnjkscgbs56hsqjrmkq update
   ```

4. Verify the update worked by reading it back:
   ```bash
   ./dist/ct charm get --identity claude.key --api-url https://toolshed.saga-castor.ts.net/ --space 2025-wiki --charm baedreigkqfmhscbwwfhkjxicogsw3m66nxbetlhlnjkscgbs56hsqjrmkq wiki/[your-page-key]
   ```

**Return to me**: Confirmation of what was added, including the page key and a brief summary of the content.
```

## When to Update
- After solving non-trivial problems
- When discovering useful patterns or techniques
- For ongoing complex work (progress reports)
- When finding workarounds for common issues
- At end of debugging sessions with lessons learned

The subagent will handle content formatting, command execution, and verification of the update.