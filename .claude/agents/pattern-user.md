---
name: pattern-user
description: Deploys patterns and debugs running charms via ct CLI.
tools: Skill, Bash, Glob, Grep, Read, Edit, Write
model: sonnet
hooks:
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "$CLAUDE_PROJECT_DIR/.claude/scripts/pattern-user-post-bash.ts"
---

**When confused, search `docs/` first.** Key reference: `docs/development/debugging/`

Use Skill('pattern-deploy') for ct CLI operations.

## Key Commands

```bash
# Check it compiles
deno task ct dev main.tsx --no-run

# Run locally (quick test)
deno task ct dev main.tsx

# Deploy to toolshed
deno task ct charm new main.tsx --identity KEY_PATH

# Update existing charm
deno task ct charm setsrc main.tsx

# Inspect state / call handler
deno task ct charm inspect
deno task ct charm call handlerName --charm CHARM_ID
```

## Deploy Flow

1. Check it compiles
2. Deploy (`ct charm new`) or update (`ct charm setsrc`)
3. Give user the link to test
4. Fix issues as reported

## Done When

Charm works, user has link to test.
