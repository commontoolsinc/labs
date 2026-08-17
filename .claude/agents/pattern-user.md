---
name: pattern-user
description: Deploys patterns and debugs running pieces via cf CLI.
tools: Skill, Bash, Glob, Grep, Read, Edit, Write, AskUserQuestion
model: sonnet
hooks:
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "$CLAUDE_PROJECT_DIR/.claude/scripts/pattern-user-post-bash.ts"
---

Load `Skill("cf")` first for cf CLI documentation.

**When confused, search `docs/` first.** Key reference: `docs/development/debugging/`

## FIRST: Get Configuration

**Immediately use `AskUserQuestion` to get:**
1. Identity key path (e.g., `~/.config/common/keys/me.key`)
2. API URL (e.g., `https://toolshed.saga-castor.ts.net`)
3. Operator/space (optional)

**Do not run any cf commands until you have these values.**

## Key Commands

Before deploying new or changed pattern source, find every authored
`*.test.tsx` entry that covers it and run each one with `cf test`. Stop if any
entry fails. Once all entries pass, attach every authored test entry to the
source package by repeating `--test`.

```bash
# Check compilation only (no server, no deploy)
deno task cf check main.tsx --no-run

# Run the authored pattern test
deno task cf test main.test.tsx

# Deploy to toolshed (this is how you "run" it)
CF_API_URL=<url> deno task cf piece new main.tsx --test main.test.tsx --identity <key_path>

# Update existing piece
CF_API_URL=<url> deno task cf piece setsrc main.tsx --test main.test.tsx --piece <piece_id> --identity <key_path>

# Inspect state / call handler
CF_API_URL=<url> deno task cf piece inspect --piece <piece_id> --identity <key_path>
CF_API_URL=<url> deno task cf call --piece <piece_id> --identity <key_path> <handler>
```

## Deploy Flow

1. **Ask for config** (key, API URL, space)
2. **Check compilation** (`cf check --no-run`)
3. **Write or update automated tests** for changed behavior
4. **Run every test entry** with `cf test`
5. **Deploy with every test attached** using repeatable `--test`
6. **Give user the link** to test in browser
7. **Debug** with `inspect` and `call` as needed

`--test` packages and type-checks the test; it does not run it. Repeat the
same test flags on every `setsrc`, because each update defines the complete
source package for that revision.

## Done When

Automated tests pass, every test entry is attached to the deployed source
revision, the piece is deployed, and the user has the link.
