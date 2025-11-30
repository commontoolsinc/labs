# Question Management System

This directory manages research questions and "how do I?" questions across work sessions, with built-in workflows to prevent noise accumulation over time.

## Philosophy

- **Low friction**: Quick to record, fast to search
- **Natural evolution**: Questions can be updated, deprecated, or superseded
- **Context preservation**: Track when/why questions were asked and how answers evolved
- **Prevent noise**: Active lifecycle management keeps the question base fresh

## Directory Structure

```
docs/questions/
├── README.md              # This file
├── _template.md           # Template for new questions
├── index.json            # Metadata index for fast searching
└── YYYY-MM-DD-slug.md    # Individual question files
```

## Question File Format

Each question is stored as `YYYY-MM-DD-slug.md` with YAML frontmatter:

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
Why was this question asked? What's the background?

## Question
The actual question goes here.

## Answer
Current thinking or answer (for answered questions).

## Notes
Additional context, links, related thoughts.
```

## Metadata Fields

- **date**: When question was created (YYYY-MM-DD)
- **updated**: Last modification date
- **status**: `open` | `answered` | `deprecated`
- **tags**: Array of topic tags for categorization
- **related**: Links to related question files
- **supersedes**: Questions this one replaces
- **superseded_by**: If deprecated, link to replacement question
- **age_warning**: Auto-set to `true` if >6 months old without updates

## Workflows

### Recording a Question

```bash
./record-answer.sh
```

Interactive workflow:
1. Enter your question text
2. Script searches for similar questions
3. If similar found: option to update existing or mark as superseded
4. If new: creates file from template with auto-generated slug
5. Opens in your editor for detailed content entry
6. Updates index.json for fast future searches

### Listing Questions

```bash
# List all open questions
./list-questions.sh open

# List answered questions
./list-questions.sh answered

# List deprecated questions
./list-questions.sh deprecated

# List questions by tag
./list-questions.sh tag workflow

# List questions with age warnings
./list-questions.sh aged
```

### Searching Questions

```bash
# Content search
rg "keyword" docs/questions/

# Tag search
rg "tags: \[.*workflow.*\]" docs/questions/

# Status search
rg "status: open" docs/questions/
```

## Lifecycle Management

### Age Warnings
Questions older than 6 months automatically get `age_warning: true` to prompt review.

### Deprecation
Mark questions as deprecated when:
- The answer is no longer relevant
- The question has been superseded by a better formulation
- The context has changed making the question obsolete

Always link to replacement via `superseded_by` field.

### Superseding Questions
When recording a similar question that replaces an old one:
1. Set `supersedes: [old-question.md]` in new question
2. Set `superseded_by: new-question.md` in old question
3. Update old question status to `deprecated`

### Manual Review
Periodically review:
- Questions with `age_warning: true`
- Deprecated questions (candidates for archival)
- Open questions that may now be answered

## Best Practices

1. **Be specific**: Good slugs and titles make future searches easier
2. **Tag thoughtfully**: Consistent tags improve discoverability
3. **Link related**: Cross-reference related questions
4. **Update answers**: When you learn more, update the answer section
5. **Deprecate actively**: Don't let obsolete questions accumulate
6. **Preserve context**: Even deprecated questions keep their content for historical reference

## Integration with Claude Code

The `.claude/skills/questions.md` skill guides AI agents on using this system. When working with Claude Code:
- Ask "search questions about X" to find related questions
- Say "record a question" to create a new entry
- Request "review old questions" for maintenance tasks
