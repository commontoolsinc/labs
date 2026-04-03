# fs-sync-example

A working example of bidirectional sync between a Common Tools pattern and the
filesystem. A todo list UI syncs with a markdown file (`/tmp/todos.md`) via a
daemon process.

## Architecture

```
┌──────────────┐       cells        ┌──────────┐       read/write       ┌──────────────┐
│   Pattern    │ ◄──────────────► │  Daemon  │ ◄──────────────────► │  todos.md    │
│  (UI + state)│    edits/todos     │ (sync)   │    parse/serialize     │  (canonical) │
└──────────────┘                    └──────────┘                        └──────────────┘
```

- **Pattern** (`todo-list-pattern.tsx`) — Renders the todo list, handles user
  actions (create, toggle, delete, edit), and enqueues edits with optimistic
  local updates.
- **Daemon** (`daemon.ts`) — Watches both the edit queue cell and the filesystem
  for changes. Applies edits to the markdown file, then reads the file back as
  the canonical state. Uses CAS retry loops and edit watermarks to handle
  concurrent changes.
- **Markdown file** — The source of truth. Human-editable. Changes made directly
  to the file are picked up by the daemon and reflected in the UI.

## Files

| File                             | Purpose                                           |
| -------------------------------- | ------------------------------------------------- |
| `src/todo-list-pattern.tsx`      | UI pattern with handlers and optimistic updates   |
| `src/todo-list-pattern.test.tsx` | Pattern tests (run with `deno task ct test`)      |
| `src/daemon.ts`                  | Sync loop: CAS retries, edit watermark, Cell.of() |
| `src/run-daemon.ts`              | CLI launcher for the daemon                       |
| `src/types.ts`                   | Shared types (Todo, Edit, FailedEdit)             |
| `src/markdown.ts`                | Markdown parser/serializer for the todo file      |
| `src/markdown.test.ts`           | Tests for the markdown parser                     |

## Running

```bash
# 1. Start local dev servers
./scripts/restart-local-dev.sh

# 2. Deploy the pattern
deno task ct piece new src/todo-list-pattern.tsx \
  -i ~/.ct/main.key -a http://localhost:8000 -s my-space

# 3. Start the sync daemon
deno run --allow-all src/run-daemon.ts \
  --piece <PIECE_ID> \
  --api-url http://localhost:8000 \
  --identity ~/.ct/main.key \
  --space my-space \
  --file /tmp/todos.md
```

## Testing

Pattern tests use the `ct test` runner (not plain `deno test`):

```bash
deno task ct test packages/fs-sync-example/src/todo-list-pattern.test.tsx
```

Markdown parser tests run with standard deno test:

```bash
deno test packages/fs-sync-example/src/markdown.test.ts
```

## Documentation

This example implements the patterns described in
[docs/development/importers/bidirectional_sync.md](../../docs/development/importers/bidirectional_sync.md),
covering CAS retry loops, edit watermarks, Cell.of() for stable identity, and
error classification.
