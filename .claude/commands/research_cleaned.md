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

Research findings will be documented in:
```
research/YYYYMMDD_<sanitized_question>.md
```

Where:
- `YYYYMMDD` is the current date
- `<sanitized_question>` is a filesystem-safe version of the research question

The output file should include:
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
