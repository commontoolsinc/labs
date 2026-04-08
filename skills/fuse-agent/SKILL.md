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
export CT_IDENTITY=./shared.key CT_API_URL=http://localhost:8000

# 1. Deploy and capture piece ID
ID=$(ct piece new packages/patterns/<path>.tsx \
  --space SPACE --root packages/patterns 2>/dev/null | head -1)

# 2. Set title
ct piece call --quiet --piece $ID --space SPACE setTitle -- --value "My Title"

# 3. Step to materialise
ct piece step --piece $ID --space SPACE

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

### When to run `ct piece step`

| Operation                     | Step needed?                               |
| ----------------------------- | ------------------------------------------ |
| `ct piece call` (CLI)         | Always                                     |
| `ct piece set` (CLI)          | Always                                     |
| FUSE handler invocation       | Sometimes — if count suffix doesn't update |
| Read/Write/Edit on `index.md` | Never                                      |

When in doubt after a FUSE handler call: run
`ct piece step --piece $ID --space SPACE`, then re-read `pieces.json`.

### NFS timeout and remount

macOS logs `nfs server fuse-t: not responding` / `is alive again` under agent
load. Reads stall during the window.

```bash
# Detect: mount is stale if this hangs or returns empty
ls /tmp/ct-mount/

# Remount:
ct fuse mount /tmp/ct-mount --background && sleep 3
```

Add `sleep 2` before verification reads if you see repeated stalls.

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
  --pieceName "Contact Book" \
  --note "Contacts mentioned in standup notes with no structured tracking"

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

**Deploy and configure via CT CLI:**

```bash
ID=$(ct piece new packages/patterns/annotation.tsx \
  --space SPACE --root packages/patterns 2>/dev/null | head -1)
echo '"Standup notes mention 5 people with no structured contact list"' \
  | ct piece set --piece $ID content --space SPACE
echo '"wish"' | ct piece set --piece $ID kind --space SPACE
ct piece step --piece $ID --space SPACE
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
echo '"resolved"' | ct piece set --piece $WISH_ID status --space SPACE
ct piece step --piece $WISH_ID --space SPACE
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

## Cleanup

```bash
ct piece rm --piece $ID --space SPACE
```

Use this to clean up duplicate pieces deployed by accident (no `--confirm`
needed). Check `pieces.json` for orphaned pieces with `-2` or `-3` suffixes.
