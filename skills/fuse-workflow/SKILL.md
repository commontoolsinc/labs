---
name: fuse-workflow
description: >
  Agent operating guide for CT FUSE filesystem mounting. Use when running
  agents against mounted spaces, reading/writing pieces via the filesystem,
  deploying patterns, calling handlers, or populating structured pieces. Triggers
  include "mount a space", "run an agent on CT", "deploy a pattern via FUSE",
  "call a handler", "populate a Contact Book", or any agent workflow that touches
  a mounted space.
user-invocable: false
---

# CT FUSE Agent Workflow

Ground-truth reference for agents operating on Common Tools spaces via FUSE.
Validated through Runs 9–11. Update this skill when new friction patterns
emerge.

---

## Piece Types (start here)

The most important thing to internalise. Two layouts, one for each piece type.

### `[FS]` pieces (notes)

Pattern exports the `[FS]` symbol. Content is a single `index.md` at the piece
root.

```
MOUNT/SPACE/pieces/📝 Note Name/
  index.md            ← raw markdown, YAML frontmatter (entityId, title)
  setTitle.handler    ← callable executable at piece root
  editContent.handler ← callable executable at piece root
  .handlers           ← schema listing (one line per callable)
  input/
  meta.json
```

### Non-`[FS]` pieces (everything else)

Notebook, todo-list, contacts, reading-list, calendar, etc. Data lives under
`result/`.

```
MOUNT/SPACE/pieces/Piece Name (N)/
  result/
    summary           ← plain-text summary (always readable — use this)
    items.json        ← may return VNode blobs — prefer summary
    addItem.handler   ← callable executable IN result/ (not at piece root)
    contacts.json     ← (contact-book specific)
  input/
    contacts.json     ← writable JSON array (contact-book specific)
  .handlers           ← schema listing at piece root
  meta.json
```

**The most common confusion:** agents look for handlers at the piece root for
non-`[FS]` pieces and find nothing. Handlers for non-`[FS]` pieces are in
`result/`.

---

## Session Setup

```bash
cd ~/code/labs
export CT_IDENTITY=./shared.key
export CT_API_URL=http://localhost:8000

# If running a headless agent (not inside Claude Code):
unset CLAUDECODE
```

**Mount:**

```bash
ct fuse mount /tmp/ct-mount --background
sleep 3  # wait for SummaryIndex warmup before accessing pieces
```

**Health check — do this first every session:**

```bash
ls /tmp/ct-mount/  # if empty or hangs, mount is stale
# Remount:
ct fuse mount /tmp/ct-mount --background && sleep 3
```

---

## Reading Pieces

### Start with pieces.json — always

```bash
cat "MOUNT/SPACE/pieces/pieces.json"
# → [{ id, name, pattern, summary }, ...]
```

Use this to:

- Find the current piece name (including its count suffix) before any handler
  call
- Get the piece `id` for `ct piece step` calls
- Check whether a piece already exists before deploying
- Confirm piece count after deploy

**Never use `ls pieces/` to discover pieces** — directory listing is unreliable
for filtering.

### Reading `[FS]` notes

```bash
cat "MOUNT/SPACE/pieces/📝 Note Name/index.md"
# → raw markdown with YAML frontmatter:
# ---
# entityId: bafy...
# title: Note Name
# ---
# (body content)
```

No JSON decoding. Read the frontmatter — you'll need `entityId` and `title` if
you Write back.

### Reading structured data

```bash
# Always prefer summary — plain text, always works:
cat "MOUNT/SPACE/pieces/Piece Name (N)/result/summary"

# Notebook entries:
cat "MOUNT/SPACE/pieces/Work Journal/result/notes.json"

# Todo items:
cat "MOUNT/SPACE/pieces/Todo List (N)/result/items.json"

# WARNING: result/items.json on Reading List and similar list pieces may return
# VNode blobs (reactive piece references), not clean JSON records. Use summary.
```

### Discovering handler schema

```bash
cat "MOUNT/SPACE/pieces/Piece Name (N)/.handlers"
# → addItem.handler  { title: string, author: string, type: "book" | "article" | ... }
# One line per callable.
```

---

## Writing and Invoking

### Handler invocation — direct executable, not redirect

Handlers are executables. Invoke them directly with CLI flags.

**Non-`[FS]` pieces — handler is in `result/`:**

```bash
"MOUNT/SPACE/pieces/Todo List (N)/result/addItem.handler" --title "Task title"
```

**`[FS]` pieces — handler is at piece root:**

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

- `ct skill` or `skills/ct/SKILL.md` — CLI command reference
- `packages/patterns/index.md` — pattern index for deployable pieces
- `Common Fabric/ct-fuse-agent-run11-report.md` (work-notes vault) — full
  friction point inventory with 13 documented issues and their workarounds
- `packages/fuse/cell-bridge.ts` — FUSE daemon implementation
