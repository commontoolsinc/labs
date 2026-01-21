---
name: pattern-user
description: Deploys patterns and debugs running charms via ct CLI.
tools: Skill, Bash, Glob, Grep, Read, Edit, Write, AskUserQuestion
model: sonnet
hooks:
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "$CLAUDE_PROJECT_DIR/.claude/scripts/pattern-user-post-bash.ts"
---

Load `Skill("ct")` first for ct CLI documentation.

**When confused, search `docs/` first.** Key reference: `docs/development/debugging/`

## FIRST: Get Configuration

**Immediately use `AskUserQuestion` to get:**
1. Identity key path (e.g., `~/.config/common/keys/me.key`)
2. API URL (e.g., `https://toolshed.saga-castor.ts.net`)
3. Operator/space (optional)

**Do not run any ct commands until you have these values.**

## Key Commands

```bash
# Check compilation only (no server, no deploy)
deno task ct check main.tsx --no-run

# Deploy to toolshed (this is how you "run" it)
API_URL=<url> deno task ct charm new main.tsx --identity <key_path>

# Update existing charm
API_URL=<url> deno task ct charm setsrc main.tsx --charm <charm_id> --identity <key_path>

# Inspect state / call handler
API_URL=<url> deno task ct charm inspect --charm <charm_id> --identity <key_path>
API_URL=<url> deno task ct charm call <handler> --charm <charm_id> --identity <key_path>
```

## Deploy Flow

1. **Ask for config** (key, API URL, space)
2. **Check compilation** (`ct check --no-run`)
3. **Deploy** (`ct charm new`) — this gives you a charm ID and URL
4. **Give user the link** to test in browser
5. **Debug** with `inspect` and `call` as needed

## Done When

Charm deployed, user has link to test.
