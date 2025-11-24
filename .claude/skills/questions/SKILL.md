---
name: questions
description: Guide for searching, recording, and managing research questions and "how do I?" questions in docs/questions/. Use this skill when the user wants to search for existing questions, record new questions, review old/stale questions, or manage the question knowledge base. Triggers include "search questions", "record a question", "review old questions", or questions about the question management workflow.
---

# Questions Skill

**Use this skill when the user asks to search for questions, record a question, or manage the question knowledge base.**

## Overview

This repository maintains a question management system in `docs/questions/` for tracking research questions and "how do I?" questions across work sessions. The system prevents noise accumulation through active lifecycle management.

## When to Use This Skill

Invoke this skill when the user:
- Asks to search for existing questions on a topic
- Wants to record a new question
- Requests to review old or stale questions
- Needs to update or deprecate existing questions
- Asks about the question management workflow

## Available Tools

### `./record-answer.sh`

Interactive script for recording questions. Usage:

```bash
./record-answer.sh
```

The script will:
1. Prompt for the question text
2. Search for similar existing questions using ripgrep
3. Offer options:
   - Create new question
   - Update existing question
   - Supersede existing question with new one
4. Generate a file named `YYYY-MM-DD-slug.md` in `docs/questions/`
5. Open the file in the user's editor
6. Update `docs/questions/index.json`

### `./list-questions.sh`

List and filter questions. Usage:

```bash
# List open questions (default)
./list-questions.sh
./list-questions.sh open

# List answered questions
./list-questions.sh answered

# List deprecated questions
./list-questions.sh deprecated

# List questions with age warnings (>6 months)
./list-questions.sh aged

# List questions by tag
./list-questions.sh tag workflow

# List all questions
./list-questions.sh all
```

Output includes:
- Status indicators (● open, ✓ answered, ✗ deprecated)
- Age warnings (⚠ for questions with age_warning: true)
- File names with age in days (color-coded: green <90d, yellow <180d, red >180d)
- Question titles and tags

### Direct Search

Use ripgrep for content search:

```bash
# Search question content
rg "keyword" docs/questions/

# Search by tag
rg "tags: \[.*workflow.*\]" docs/questions/

# Search by status
rg "status: open" docs/questions/
```

## Question File Format

Each question is stored as `YYYY-MM-DD-slug.md`:

```yaml
---
date: 2025-11-24
updated: 2025-11-24
status: open|answered|deprecated
tags: [workflow, tooling, research]
related: [2025-11-20-similar-question.md]
supersedes: []
superseded_by: null
age_warning: false
---

# Question Title

## Context
Background and situation that prompted the question

## Question
The actual question stated clearly

## Answer
Current thinking or answer (filled in when answered)

## Notes
Additional context, observations, links
```

## Lifecycle Management

### Status Values
- **open**: Question not yet answered
- **answered**: Question has an answer (may still evolve)
- **deprecated**: Question is obsolete or superseded

### Age Management
- Questions older than 6 months automatically get `age_warning: true`
- Use `./list-questions.sh aged` to find questions needing review
- Review aged questions to either:
  - Update them with new information
  - Mark as deprecated if no longer relevant
  - Keep as-is if still valuable

### Superseding Questions
When a question replaces an older one:
1. New question sets `supersedes: [old-question.md]`
2. Old question gets `superseded_by: new-question.md`
3. Old question status becomes `deprecated`

## Workflow Examples

### Searching for Existing Questions

When user asks: "Do we have any questions about pattern deployment?"

```bash
# Search content
rg -i "pattern.*deploy" docs/questions/

# Or search tags
rg "tags: \[.*pattern.*\]" docs/questions/

# List all to scan
./list-questions.sh all
```

### Recording a New Question

When user says: "I want to record a question about error handling"

```bash
./record-answer.sh
# Follow prompts:
# 1. Enter question text
# 2. Review similar questions found
# 3. Choose to create new or update existing
# 4. File opens in editor for detailed content
```

### Reviewing Old Questions

When user asks: "What questions need attention?"

```bash
# Show aged questions
./list-questions.sh aged

# Show open questions
./list-questions.sh open

# Show deprecated questions (candidates for cleanup)
./list-questions.sh deprecated
```

### Updating a Question

When user says: "I found the answer to question X"

1. Read the question file
2. Update the `status` field to `answered`
3. Update the `updated` field to today's date
4. Fill in the `## Answer` section
5. Add any notes to `## Notes`

## Best Practices

1. **Search before creating**: Always search for similar questions first to avoid duplicates
2. **Be specific**: Good question titles and slugs improve discoverability
3. **Tag consistently**: Use consistent tags for better categorization
4. **Link related**: Cross-reference related questions in metadata
5. **Update answers**: When you learn more, update existing questions rather than creating new ones
6. **Deprecate actively**: Don't let obsolete questions accumulate
7. **Preserve context**: Even deprecated questions keep their content for historical reference

## Integration with Workflow

- When researching a topic, check for related questions first
- After solving a problem, consider if it's worth recording as a question
- During project reviews, scan aged questions for updates
- When answering questions, link to related questions for context

## File Locations

- Questions directory: `docs/questions/`
- Template: `docs/questions/_template.md`
- Index: `docs/questions/index.json`
- README: `docs/questions/README.md`
- Scripts: `./record-answer.sh`, `./list-questions.sh`

## Troubleshooting

### Script errors
- Ensure scripts are executable: `chmod +x record-answer.sh list-questions.sh`
- Check ripgrep is installed: `which rg`
- Verify jq is installed: `which jq`

### Missing questions
- Check `docs/questions/` directory exists
- Verify question files follow `YYYY-MM-DD-*.md` pattern
- Ensure YAML frontmatter is properly formatted

### Search not finding questions
- Try broader search terms
- Use `./list-questions.sh all` to see all questions
- Check for typos in tags or metadata
