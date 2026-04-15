---
name: fuse-agent
description: >
  Agent-specific interaction patterns for working with FUSE-mounted spaces.
  Use when deploying patterns via FUSE, working with Activity Logs, Annotations,
  or coordinating agent workflows that read/write pieces through the filesystem.
  Triggers include "deploy a pattern", "log an event", "create annotation",
  "agent workflow", or managing piece lifecycle via FUSE.
user-invocable: false
---

# FUSE Agent Workflows

Patterns for agents that interact with FUSE-mounted Common Fabric spaces. For
FUSE mounting, filesystem layout, and low-level read/write mechanics, see the
`fuse-workflow` skill.

## Deploying Patterns

```bash
cd ~/code/labs
export CF_IDENTITY=./shared.key CF_API_URL=http://localhost:8000

# 1. Deploy and capture piece ID
ID=$(cf piece new packages/patterns/<path>.tsx \
  --space SPACE --root packages/patterns 2>/dev/null | head -1)

# 2. Set title
cf piece call --quiet --piece $ID --space SPACE setTitle -- --value "My Title"

# 3. Step to materialise
cf piece step --piece $ID --space SPACE

# 4. Re-read pieces.json immediately — stale after deploy
cat "MOUNT/SPACE/pieces/pieces.json"
```

**Pattern index:** `cat ~/code/labs/packages/patterns/index.md`

**After deploying a structural piece:**

1. Re-read `pieces.json` — get the current name with count suffix
2. Read `.handlers` — discover available operations, never assume schema
3. Populate using direct handler invocation
4. Verify via `result/summary`
5. Append wikilink to any source note that motivated the deploy

---

## Lifecycle Gotchas

### Piece name instability

Every handler call that changes piece state updates the count suffix in the
name: `Reading List (0)` -> `Reading List (1)` -> `Reading List (2)`

All previously constructed FUSE paths are immediately invalid. Before every
handler call:

```bash
# Find current name dynamically:
cat "MOUNT/SPACE/pieces/pieces.json" | python3 -c \
  "import json,sys; p=json.load(sys.stdin); print(next(x['name'] for x in p if 'Reading' in x['name']))"
```

### When to run `cf piece step`

| Operation                     | Step needed?                               |
| ----------------------------- | ------------------------------------------ |
| `cf piece call` (CLI)         | Always                                     |
| `cf piece set` (CLI)          | Always                                     |
| FUSE handler invocation       | Sometimes — if count suffix doesn't update |
| Read/Write/Edit on `index.md` | Never                                      |

When in doubt after a FUSE handler call: run
`cf piece step --piece $ID --space SPACE`, then re-read `pieces.json`.

### NFS timeout and remount

macOS logs `nfs server fuse-t: not responding` / `is alive again` under agent
load. Reads stall during the window.

```bash
# Detect: mount is stale if this hangs or returns empty
ls /tmp/cf-mount/

# Remount:
cf fuse mount /tmp/cf-mount --background && sleep 3
```

Add `sleep 2` before verification reads if you see repeated stalls.

### Transport disconnection (silent write failures)

Long-running FUSE mounts (24h+) can lose their backend transport. Symptom: all
writes appear to succeed (no error), but values don't persist — cells stay empty
or revert. The FUSE process is still running but useless.

**Diagnose:**

```bash
tail -20 /tmp/ct-fuse-<mount-name>.log
# Look for: "ConnectionError: memory/v2 transport closed"
```

**Fix:** Kill and remount. Remount before each experiment run to be safe.

Agent handlers (`markIdle.handler`, `appendLearned.handler`, etc.) will also
fail silently with a dead transport — the handler appears to execute but no
state changes. If agents report "learned" entries that don't show up in
`input/learned`, check the transport first.

### Secure-mode time/random pitfalls in handlers

Pattern handlers and actions may run under SES secure mode. Avoid raw zero-arg
`new Date()` and `Math.random()` inside authored patterns — both can throw under
secure mode.

Use Common Fabric safe builtins instead:

```ts
import { nonPrivateRandom, safeDateNow } from "commonfabric";

const now = safeDateNow();
const iso = new Date(now).toISOString();
const id = `${now.toString(36)}-${
  nonPrivateRandom().toString(36).slice(2, 11)
}`;
```

This specifically matters for:

- `activity-log.tsx` event creation / timestamps
- `agent.tsx` lifecycle handlers (`markIdle`, `markError`)
- any handler-generated IDs or timestamps in experiment support patterns

For event IDs in authored patterns, avoid `Math.random()` too. A safe pattern
is:

```ts
const now = safeDateNow();
const id = `${now.toString(36)}-${
  nonPrivateRandom().toString(36).slice(2, 11)
}`;
const timestamp = new Date(now).toISOString();
```

If a handler fails with messages like:

- `secure mode Calling new %SharedDate%() with no arguments throws`
- `secure mode %SharedMath%.random() throws`

check the pattern source before assuming the agent invoked it incorrectly.

---

## Activity Log Pattern

The Activity Log (`activity-log/activity-log.tsx`) is a structured event stream
for recording agent actions. Log events incrementally as you work — not in one
batch at the end.

**Calling `logEvent.handler`:**

```bash
# Get current name first — count suffix changes with every event
LOG_NAME=$(cat "MOUNT/SPACE/pieces/pieces.json" | python3 -c \
  "import json,sys; p=json.load(sys.stdin); \
   print(next(x['name'] for x in p if 'Activity Log' in x['name']))")

"MOUNT/SPACE/pieces/$LOG_NAME/result/logEvent.handler" \
  --agent "deployer" \
  --action "deployed" \
  --piece-name "Contact Book" \
  --note "Contacts mentioned in standup notes with no structured tracking"

# Note: handler CLIs expose object fields as kebab-case flags (`piece-name`),
# not camelCase (`pieceName`). `--help` on the handler shows the exact flags.
# When in doubt, prefer `--json` / `--json-file` to avoid flag-name mismatches.

# Re-read pieces.json after — name changes on every event
```

**Input fields** (all string, all optional except `agent` and `action`):

| Field       | Type    | Example                                 |
| ----------- | ------- | --------------------------------------- |
| `agent`     | string  | `"deployer"`                            |
| `action`    | string  | `"deployed"`, `"populated"`, `"linked"` |
| `pieceName` | string? | `"Contact Book"`                        |
| `note`      | string? | one-line detail                         |

**Read log state** (after any agent has run):

```bash
cat "MOUNT/SPACE/pieces/Activity Log (N)/result/summary"
# -> last 20 events as plain text, newest at bottom
```

---

## Annotation Pattern

Annotations (`annotation.tsx`) are pieces that record observations, flags, and
wishes. Use them to leave notes about things noticed without necessarily acting.

**Deploy and configure via CF CLI:**

```bash
ID=$(cf piece new packages/patterns/annotation.tsx \
  --space SPACE --root packages/patterns 2>/dev/null | head -1)
echo '"Standup notes mention 5 people with no structured contact list"' \
  | cf piece set --piece $ID content --space SPACE
echo '"wish"' | cf piece set --piece $ID kind --space SPACE
cf piece step --piece $ID --space SPACE
# Re-read pieces.json — name now reflects content: "Standup notes mention..."
```

**Kind values:** `"note"` | `"todo"` | `"wish"`

**Status values:** `"open"` | `"in-progress"` | `"resolved"` | `"dismissed"`

**When to use each kind:**

- `"note"` — record an observation without acting: _"3 standup entries reference
  a project that has no piece"_
- `"wish"` — request for another agent or a future pass: _"Deploy a Calendar
  pattern — there are 4 dated events in the Work Journal"_
- `"todo"` — flag incomplete work: _"Contact Book has 3 entries with no email
  address"_

**Mark a wish resolved** (when fulfilling another agent's annotation):

```bash
echo '"resolved"' | cf piece set --piece $WISH_ID status --space SPACE
cf piece step --piece $WISH_ID --space SPACE
```

**Discover open annotations** — deploy `annotation-manager.tsx` for an
aggregated view, or query `pieces.json` directly:

```bash
cat "MOUNT/SPACE/pieces/pieces.json" | python3 -c "
import json, sys
p = json.load(sys.stdin)
for x in p:
    if x.get('patternName','') == 'annotation':
        print(x['name'], '—', x.get('summary','')[:60])
"
```

---

## Agent Piece (`agent/agent.tsx`)

Each agent is a piece in the space with its own cells for directive, learned
state, and lifecycle. Deploy one per agent in the space.

```
MOUNT/SPACE/pieces/🤖 Deployer/
  result/
    summary                  ← "Deployer: last run summary" or "Deployer (no runs yet)"
    markRunning.handler      ← call at start of run (auto-logs to Activity Log)
    markIdle.handler         ← call when done: --summary "what you did"
    markError.handler        ← call on failure: --summary "what went wrong"
    appendLearned.handler    ← append a learning: --entry "today I learned X"
    setDirective.handler     ← update directive: --value "new directive text"
    setLearned.handler       ← replace all learned: --value "full learned text"
  input/
    agentName                ← raw text: "Deployer"
    directive                ← raw text: the agent's full directive/instructions
    enabled                  ← raw text: "true" or "false"
    learned                  ← raw text: accumulated learnings
    status                   ← raw text: "idle" | "running" | "error"
    lastRun                  ← raw text: ISO timestamp of last run
    lastRunSummary           ← raw text: summary from last markIdle/markError
  .handlers
  meta.json
```

### Agent lifecycle

**Important:** Always re-resolve the piece name before each handler call. Piece
name suffixes can change after handler invocations (e.g. `Counter-1` becomes
`Counter-2`), so a stale `$AGENT_NAME` will target a non-existent path.

```bash
# Helper function: resolve current piece name (call before each handler use)
resolve_agent() {
  cat "MOUNT/SPACE/pieces/pieces.json" | python3 -c \
    "import json,sys; p=json.load(sys.stdin); \
     print(next(x['name'] for x in p if 'Deployer' in x['name']))"
}

# 1. Read your directive
AGENT_NAME=$(resolve_agent)
cat "MOUNT/SPACE/pieces/$AGENT_NAME/input/directive"

# 2. Mark running (auto-logs "started" to Activity Log)
AGENT_NAME=$(resolve_agent)
"MOUNT/SPACE/pieces/$AGENT_NAME/result/markRunning.handler"

# 3. Do your work...
# Log individual actions to Activity Log as you go (see Activity Log section)

# 4. Record learnings
AGENT_NAME=$(resolve_agent)
"MOUNT/SPACE/pieces/$AGENT_NAME/result/appendLearned.handler" \
  --entry "2026-04-07: Calendar addEvent throws pattern-load-error but succeeds"

# 5. Mark idle when done (auto-logs "completed" to Activity Log)
AGENT_NAME=$(resolve_agent)
"MOUNT/SPACE/pieces/$AGENT_NAME/result/markIdle.handler" \
  --summary "Deployed Contact Book and Calendar, left 2 wishes for Populator"
# Or on error:
AGENT_NAME=$(resolve_agent)
"MOUNT/SPACE/pieces/$AGENT_NAME/result/markError.handler" \
  --summary "FUSE mount unresponsive after 3 retries"
```

`markRunning`, `markIdle`, and `markError` automatically log to the Activity Log
via `wish("#activity-log")`. You still log individual actions (deploys,
populates, links) manually — the lifecycle handlers just record start/stop.

### Discovering agents

```bash
cat "MOUNT/SPACE/pieces/pieces.json" | python3 -c "
import json, sys
p = json.load(sys.stdin)
for x in p:
    if x.get('patternName','') == 'agent':
        print(x['name'], '—', x.get('summary','')[:60])
"
```

---

## Cleanup

```bash
cf piece rm --piece $ID --space SPACE
```

Use this to clean up duplicate pieces deployed by accident (no `--confirm`
needed). Check `pieces.json` for orphaned pieces with `-2` or `-3` suffixes.
