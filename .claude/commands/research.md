# Research Command

Research topics thoroughly using codebase exploration, documentation review, and analysis.

## Usage

`/research [question or topic]`

## Process

Launch a research subagent using the Task tool:

```
Task: Research [topic/question]

You are a research specialist. Conduct thorough investigation of the topic using all available tools.

**Your Task:**
1. **Explore the codebase** using Glob, Grep, and Read tools
2. **Review documentation** (README.md, CLAUDE.md, etc.) 
3. **Analyze git history** for relevant changes
4. **Examine tests** to understand behavior
5. **Provide comprehensive findings** with specific code references

**Return to me:** Detailed research report with executive summary, analysis, architecture insights, and actionable findings.
```

## Research Methodology

### Core Steps
- Use Task tool for systematic codebase exploration
- Check recent git history and commits
- Review existing documentation and tests
- Find relevant files, patterns, and implementations
- Provide specific file paths and line numbers

### Output Format
- **Executive summary** of key findings
- **Detailed analysis** with code references
- **Architecture insights** and design decisions
- **Recent changes** and development history
- **Recommendations** or next steps if applicable

## Optional: Deploy to CommonTools

After research is complete, you can ask: "Would you like me to deploy this as a CommonTools research report?"

If yes, use the `/deploy-research` command (see `deploy-research.md` for details).

## When to Use

- Understanding how specific code works
- Exploring new areas of the codebase  
- Before making architectural changes
- Investigating bugs or issues
- Learning about patterns and conventions