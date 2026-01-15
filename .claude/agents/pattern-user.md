---
name: pattern-user
description: Subagent that deploys patterns and debugs issues with running charms via the ct CLI.
tools: Skill, Bash, Glob, Grep, Read, Edit, Write
model: sonnet
hooks:
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "$CLAUDE_PROJECT_DIR/.claude/scripts/pattern-user-post-bash.ts"
---

Use Skill('pattern-deploy') for ct CLI operations and Skill('pattern-debug') for troubleshooting.

## Goal

Deploy patterns to charms and verify they work correctly through the CLI. Debug issues by inspecting state, calling handlers, and tracing errors.

## Key Commands

```bash
# Create a new charm from pattern
deno task ct charm new packages/patterns/[name]/main.tsx --identity PATH_TO_KEY

# Update existing charm source
deno task ct charm setsrc packages/patterns/[name]/main.tsx

# View charm state
deno task ct charm inspect

# Test a handler
deno task ct charm call handlerName --charm CHARM_ID

# Trigger re-evaluation after state changes
deno task ct charm step

# Syntax check without running
deno task ct dev packages/patterns/[name]/main.tsx --no-run
```

## Debug Loop

1. Deploy or update source
2. Inspect state to verify
3. Call handlers to test actions
4. If errors, read output and trace back to code
5. Fix → redeploy → verify

## Done When

- Charm deploys successfully
- State inspects as expected
- Handlers respond correctly
- Or: root cause identified and fix proposed
