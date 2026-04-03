---
name: fuse-workflow
description: >
  Guide for hybrid workflows using CF FUSE filesystem mounting alongside the
  browser and CLI. Use when mounting spaces, editing cells via the filesystem,
  developing patterns for filesystem interaction, running agents against mounted
  spaces, or combining browser + filesystem + CLI workflows. Triggers include
  "mount a space", "edit cells from filesystem", "use FUSE", "hybrid workflow",
  "filesystem sync", or working with pieces across both browser and CLI.
user-invocable: false
---

# FUSE Hybrid Workflows

**This workflow is evolving.** As we discover new dynamics, update this skill to
capture them. Offer to do so when patterns emerge that aren't documented here.

## What CF FUSE Does

Mounts a Common Fabric space as a local filesystem. Cells become files and
directories. Reads and writes are bidirectional — edit a file, the cell updates;
change a cell in the browser, the file updates within ~1 second.

## Quick Start

```bash
# Prerequisites
brew install --cask fuse-t          # macOS only, requires sudo

# Identity (reuse existing or create one)
ls cf.key || deno run -A packages/cli/mod.ts id derive "implicit trust" > cf.key

# Environment
export CF_API_URL=http://localhost:8000
export CF_IDENTITY=./cf.key

# Mount
deno task cf fuse mount /tmp/cf

# Explore a space (connects on demand — any name works)
ls /tmp/cf/home/pieces/
ls /tmp/cf/my-space/pieces/

# Unmount
deno task cf fuse unmount /tmp/cf
```

## Filesystem Layout

```
/tmp/cf/
  <space>/                        # connected on first access
    pieces/
      <piece-name>/
        meta.json                 # read-only: id, entityId, name, patternName
        input.json                # full input cell as JSON
        input/                    # exploded input — each key is a file or dir
          title                   # raw text (no quotes): "My Title"
          count                   # raw text: "42"
        result.json               # full result cell as JSON
        result/
          items/
            0/
              text                # raw text: "Buy milk"
              done                # raw text: "false"
            0.json                # atomic: {"text":"Buy milk","done":false}
          addItem.handler         # write-only: send JSON to trigger handler
      .index.json                 # name → entity ID mapping
    entities/                     # access by entity ID (on demand)
    space.json                    # { did, name }
  .spaces.json                    # known spaces
  .status                         # connection state
```

## Reading and Writing

```bash
# Read scalar
cat pieces/my-note/input/title           # => My Title

# Read JSON subtree
cat pieces/my-note/input.json            # => full input as JSON
cat pieces/my-note/result/items/0.json   # => single item as JSON

# Write scalar (type auto-detected: number, boolean, null, or string)
echo -n "New Title" > pieces/my-note/input/title

# Write JSON (atomic multi-field update)
echo '{"text":"Updated","done":true}' > pieces/my-note/result/items/0.json

# Trigger handler
echo '{"title":"New Item"}' > pieces/my-note/result/addItem.handler

# Create field
touch pieces/my-note/result/newField     # creates empty string
mkdir pieces/my-note/result/metadata     # creates empty object

# Delete field
rm pieces/my-note/result/oldField
rm -r pieces/my-note/result/items/0      # removes + re-indexes array
```

## The Hybrid Workflow

The power is in combining FUSE, CLI, and browser simultaneously:

### Deploy + Mount + Edit

```bash
# 1. Develop a pattern
deno task cf check packages/patterns/my-app/main.tsx --no-run

# 2. Deploy to a space
deno task cf piece new packages/patterns/my-app/main.tsx -s my-space
# => Created piece bafyreia...

# 3. Mount and interact via filesystem
deno task cf fuse mount /tmp/cf
ls /tmp/cf/my-space/pieces/my-app/result/

# 4. Edit cells from terminal while viewing in browser
echo -n "Updated content" > /tmp/cf/my-space/pieces/my-app/input/title
# => Browser shows the change within ~1 second

# 5. Iterate on the pattern
deno task cf piece setsrc packages/patterns/my-app/main.tsx --piece bafyreia...
# => Result updates in both browser AND filesystem
```

### Cross-Space Operations

```bash
# Copy data between spaces
cp /tmp/cf/space-a/pieces/notes/result/items.json /tmp/backup.json
cat /tmp/backup.json | jq '.' > /tmp/cf/space-b/pieces/notes/input/items.json

# Grep across an entire space
grep -r "TODO" /tmp/cf/my-space/pieces/*/result/content

# Diff two pieces
diff /tmp/cf/my-space/pieces/note-1/result/content \
     /tmp/cf/my-space/pieces/note-2/result/content
```

### Agent Workflows

Multiple agents can read/write cells via the filesystem while a human works in
the browser. Each agent sees the same live data:

```bash
# Agent reads a piece's state
cat /tmp/cf/my-space/pieces/assistant/result.json | jq '.messages'

# Agent writes to a handler
echo '{"message":"Hello from agent"}' > \
  /tmp/cf/my-space/pieces/assistant/result/sendMessage.handler

# Agent monitors for changes (polling — fswatch may not work with FUSE-T)
while true; do cat /tmp/cf/my-space/pieces/task/result/status; sleep 2; done
```

### Pattern Development Loop

Combine pattern-dev with FUSE for a tight feedback loop:

```bash
# 1. Write pattern in packages/patterns/my-pattern/main.tsx
# 2. Type check
deno task cf check packages/patterns/my-pattern/main.tsx --no-run
# 3. Deploy
deno task cf piece new packages/patterns/my-pattern/main.tsx -s dev-space
# 4. Mount
deno task cf fuse mount /tmp/cf
# 5. Set input via filesystem (faster than cf piece set for complex data)
cat test-data.json > /tmp/cf/dev-space/pieces/my-pattern/input.json
# 6. Read result
cat /tmp/cf/dev-space/pieces/my-pattern/result.json | jq '.'
# 7. Iterate: edit pattern → setsrc → result updates automatically
```

## Important Gotchas

### Identity Mismatch

The CLI identity key creates a _different space_ than the browser. If you deploy
with `cf.key` but browse with your browser identity, you'll see different
spaces.

**Fix:** Use the browser's space name when mounting:

```bash
# Find your browser space name from the URL or shell UI
ls /tmp/cf/2026-03-09-ben/pieces/   # connects on demand
```

### No `step` Needed via FUSE

Unlike `cf piece set` which requires `cf piece step` to trigger recomputation,
FUSE writes go through `cell.set()` directly, which triggers reactive updates
automatically.

### Writes Are Fire-and-Forget

FUSE returns success before the cell write completes. If toolshed is down,
writes silently fail. Check the browser to confirm writes landed.

### FUSE-T Cache TTL

Changes from the browser appear in the filesystem within ~1 second (FUSE-T NFS
cache). Not instant. If you need to force a re-read, `cat` the `.json` file (not
the exploded directory).

### Large Pieces

Pieces with large `$UI` trees or complex schemas produce huge `result.json`
files (100KB+). Reading them works but is slow. Prefer reading specific fields
via the exploded directory: `cat result/title` instead of `cat result.json`.

### Mount Stability

The FUSE daemon can crash if patterns throw uncaught errors during reactive
updates. If the mount stops responding but the process is still running:

```bash
pkill -f "packages/fuse/mod.ts"
umount /tmp/cf 2>/dev/null
# Remount
deno task cf fuse mount /tmp/cf
```

### macOS Resource Forks

Finder and some macOS tools create `._` resource fork files. The FUSE mount
rejects these with EACCES. Use CLI tools, not Finder, to browse mounted spaces.

```bash
"MOUNT/SPACE/pieces/📝 Note Name/setTitle.handler" --value "New Title"
```

**String enum values need JSON quoting:**

```bash
"MOUNT/SPACE/pieces/Reading List (N)/result/addItem.handler" \
  --title "Book Title" --author "Author" --type '"book"'
# '"book"' not 'book' — the outer quotes are shell, inner are JSON
```

**Void handlers can be invoked with no args:**

```bash
"MOUNT/SPACE/pieces/Contact Book/result/onAddContact.handler"
```

Use `--value null` only if you specifically need the older explicit form.

**NEVER redirect to handler files (CT-1417):**

```bash
echo '{"title":"x"}' > piece.handler  # SILENTLY FAILS — write does nothing
```

**After ANY handler call — re-read pieces.json immediately:**

```bash
cat "MOUNT/SPACE/pieces/pieces.json"
# Piece names include count suffixes that update on every mutation:
# Reading List (0) → Reading List (1) → Reading List (2)
# All previously constructed FUSE paths are invalid after a mutation.
```

### Writing to `[FS]` note pieces

Use Read/Write/Edit tools directly on `index.md`. Never use handler invocation
for notes.

```
1. Read  "MOUNT/SPACE/pieces/📝 Note Name/index.md"  — capture frontmatter
2. Edit  targeted changes to body only, leaving frontmatter intact
   OR
   Write  full replacement — must include frontmatter (entityId + title from step 1)
```

**Preserve the frontmatter.** Losing `entityId` corrupts the piece.

### Input cell writes (Python pattern)

For bulk writes to input cell arrays (e.g. populating a Contact Book):

```python
import json

contacts = [
    {"name": "Alice", "email": "alice@example.com", "phone": "", "company": "",
     "tags": ["team"], "notes": "Context here", "createdAt": 1234567890000},
    # ...
]

try:
    open("MOUNT/SPACE/pieces/Contact Book/input/contacts.json", "w").write(
        json.dumps(contacts)
    )
except FileNotFoundError:
    pass  # FUSE close quirk — write succeeded despite the error

# Verify success:
import subprocess
result = subprocess.run(
    ["cat", "MOUNT/SPACE/pieces/Contact Book/result/contacts.json"],
    capture_output=True, text=True
)
data = json.loads(result.stdout)
print(f"{len(data)} contacts written")
```

**`input/` directory layout** — two things coexist, only one is the write
target:

- `input/contacts.json` — writable flat JSON array (**correct write target**)
- `input/contacts/` — directory of individual cell-slot files (read-only view)
- Writing to `input/contacts/N` does not work as expected

---

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
name: `Reading List (0)` → `Reading List (1)` → `Reading List (2)`

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

### Error-that-succeeds patterns

**Reading List `addItem.handler`:** prints an error-looking message on stderr,
but the item IS added. Do not retry. Verify via `result/summary`.

**FUSE write `FileNotFoundError on close` (Python):** write succeeded. The error
is a FUSE-T close quirk. Verify success via `result/` — not by absence of error.

**Shell heredoc writes fail on FUSE:**

```bash
cat > "MOUNT/SPACE/pieces/📝 Note/index.md" << 'EOF'  # DOES NOT WORK
content
EOF
```

Use Python `open(...).write(...)` or the Write tool instead.

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
# → last 20 events as plain text, newest at bottom
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
# Re-read pieces.json — name now reflects content: "✨ Standup notes mention..."
```

**Kind values:** `"note"` (📌) | `"todo"` (☐) | `"wish"` (✨)

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

**Discover open annotations:**

```bash
# Annotation pieces are named with kind prefix: 📌 ✨ ☐
cat "MOUNT/SPACE/pieces/pieces.json" | python3 -c "
import json, sys
p = json.load(sys.stdin)
for x in p:
    n = x['name']
    if any(n.startswith(e) for e in ['📌', '✨', '☐']):
        print(x['name'], '—', x.get('summary','')[:60])
"
```

---

## Pattern Source: `.src/` Directory

Every piece exposes its pattern source under `.src/` in the FUSE mount. Read to
understand how a piece works; write to modify it live.

```
MOUNT/SPACE/pieces/My Piece/
  .src/
    main.tsx       ← pattern source — readable and writable
    error.log      ← synthetic, read-only — pattern execution errors
```

**Read source:**

```bash
cat "MOUNT/SPACE/pieces/My Piece/.src/main.tsx"
```

**Modify source** (use Python — shell redirect fails on FUSE):

```python
path = "MOUNT/SPACE/pieces/My Piece/.src/main.tsx"
src = open(path).read()
# ... modify src ...
open(path, "w").write(modified_src)
# Write triggers setsrc automatically — no ct piece setsrc needed
```

**Check for errors after modifying:**

```bash
cat "MOUNT/SPACE/pieces/My Piece/.src/error.log"
# Empty = no errors; non-empty = compile or runtime error in new source
```

---

## Cleanup

```bash
ct piece rm --piece $ID --space SPACE
```

Use this to clean up duplicate pieces deployed by accident (no `--confirm`
needed). Check `pieces.json` for orphaned pieces with `-2` or `-3` suffixes.

---

## Running Agents

Agent system prompts live at `.claude/commands/agents/<name>.md`. Structure:

- First line: constraints (read-only access, temp dir, no git/network)
- Role description
- CT Space Filesystem reference (generic MOUNT/SPACE placeholders)
- "Start here" loop

Agent runner script pattern:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd ~/code/labs
export CT_IDENTITY=./shared.key
export CT_API_URL=http://localhost:8000
unset CLAUDECODE

OUTPUT="${TRACE_FILE:-/dev/stderr}"

claude -p --dangerously-skip-permissions --model sonnet \
  --output-format stream-json --verbose \
  --max-turns 128 \
  --append-system-prompt-file .claude/commands/agents/<name>.md \
  "Begin your Pass ${PASS_NUM:-1} run." >> "$OUTPUT" 2>&1
```

Traces land in `TRACE_FILE` when set. Score with
`python3 scripts/score-pass.py <trace.jsonl>`.

---

## Reference

- `packages/fuse/mod.ts` — FUSE daemon entry point
- `packages/fuse/cell-bridge.ts` — cell-to-filesystem bridge
- `packages/fuse/tree-builder.ts` — JSON-to-tree conversion
- `docs/specs/fuse-filesystem/` — 7-part specification
- Use the `cf` skill, or read `skills/cf/SKILL.md`, for CLI command reference
- Use the `pattern-dev` skill, or read `skills/pattern-dev/SKILL.md`, for
  pattern development
