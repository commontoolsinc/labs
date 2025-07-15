# Research Command

Research topics thoroughly using codebase exploration, documentation review, and analysis.

## Usage

`/research [question or topic]`

## Process

Launch a research subagent using the Task tool, then always ask about deployment:

```
Task: Research [topic/question]

You are a research specialist. Conduct thorough investigation of the topic using all available tools.

**Your Task:**
1. **Consult the wiki first** - Read .claude/commands/search-wiki.md to learn how to check for existing knowledge on this topic
2. **Explore the codebase** using Glob, Grep, and Read tools
3. **Review documentation** (README.md, CLAUDE.md, etc.)
4. **Analyze git history** for relevant changes
5. **Examine tests** to understand behavior
6. **Provide comprehensive findings** with specific code references

**Return to me:** Detailed research report with executive summary, analysis, architecture insights, and actionable findings.

**CRITICAL:** After delivering the report, you MUST ask the user if they want to deploy it using the /deploy-research command.
```

## Research Methodology

### Core Steps
- **Start with wiki search** to avoid duplicating previous research
- Use Task tool for systematic codebase exploration
- Check recent git history and commits
- Review existing documentation and tests
- Find relevant files, patterns, and implementations
- Provide specific file paths and line numbers

### Required Final Step
- **Always ask about deployment** - Even if the user doesn't seem interested, you must offer the /deploy-research option

### Output Format
- **Executive summary** of key findings
- **Detailed analysis** with code references
- **Architecture insights** and design decisions
- **Recent changes** and development history
- **Recommendations** or next steps if applicable

## Required: Ask About Deployment

After research is complete, you MUST ask: "Would you like me to deploy this as a CommonTools research report?"

If yes, use the `/deploy-research` command (see `deploy-research.md` for details).

## When to Use

- Understanding how specific code works
- Exploring new areas of the codebase
- Before making architectural changes
- Investigating bugs or issues
- Learning about patterns and conventions
