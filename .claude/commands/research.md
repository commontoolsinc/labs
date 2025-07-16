# Research Command

Research topics expediently and accurately using codebase exploration, documentation review, and analysis.

## Usage

`/research [question or topic]`

## Process

Launch a research subagent using the Task tool, then always ask about deployment:

```
Task: Research [topic/question]

You are a research specialist. Conduct thorough investigation of the topic using all available tools.

**First, learn how to use ct:** Read .claude/commands/common/ct.md to understand how to use the CommonTools system.

**Your Task:**
1. **Consult the wiki first** - Read .claude/commands/search-wiki.md to learn how to check for existing knowledge on this topic
2. **Explore the codebase** using Glob, Grep, and Read tools
3. **Review documentation** (README.md, CLAUDE.md, etc.)
4. **Analyze very recent git history** for relevant changes
5. **Examine tests** to understand behavior
6. **Provide comprehensive findings** with specific code references

**Return to me:** Research report with executive summary, analysis, architecture insights, and actionable findings.

**CRITICAL:** After delivering the report, you MUST ask the user if they want to deploy it using the .claude/commands/deploy-research.md command.
```

## Research Methodology

### Core Steps
- **Learn ct usage first** - Read .claude/commands/common/ct.md to understand CommonTools
- **Start with wiki search** to avoid duplicating previous research
- Use Task tool for systematic codebase exploration
- Check recent git history and commits
- Review existing documentation and tests
- Find relevant files, patterns, and implementations
- Provide specific file paths and line numbers

### Required Final Step
- **Always ask about deployment** - Even if the user doesn't seem interested, you must offer the .claude/commands/deploy-research.md option

### Output Format
- **Executive summary** of key findings
- **Detailed analysis** with code references
- **Architecture insights** and design decisions
- **Recent changes** and development history
- **Recommendations** or next steps if applicable

## Required: Ask About Deployment

After research is complete, you MUST ask: "Would you like me to deploy this as a CommonTools research report?"

If yes, use the .claude/commands/deploy-research.md command. Make sure to read .claude/commands/common/ct.md first to understand how to use the CommonTools system properly.

## When to Use

- Understanding how specific code works
- Exploring new areas of the codebase
- Before making architectural changes
- Investigating bugs or issues
- Learning about patterns and conventions
