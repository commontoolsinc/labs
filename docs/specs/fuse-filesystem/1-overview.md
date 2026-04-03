# 1. Overview and Motivation

## What

A FUSE (Filesystem in Userspace) daemon that mounts Common Fabric spaces as a
local filesystem. Cells appear as files and directories. Standard Unix tools
(`cat`, `ls`, `jq`, `vim`, `grep`, etc.) work against live cell data.

## Why

- **Unix composability**: Pipe cell data through standard tools. `grep` across
  an entire space. Use `watchman`/`fswatch` for change notifications.
- **Editor integration**: Open cell data in any editor. Save writes back to the
  cell.
- **Scripting**: Shell scripts can read/write cell data without the `cf` CLI's
  overhead of spinning up a full runtime per invocation.
- **Exploration**: `tree`, `find`, `ls -la` to understand space structure.
- **Git-like workflows**: Diff cell values, track changes over time.
- **AI/LLM tooling**: Agents can interact with spaces through filesystem
  operations, which every agent framework already supports.

## Non-Goals (v1)

- Real-time collaborative editing through the filesystem (eventual consistency
  is fine).
- Exposing the full causal history (versions) as filesystem content. May come
  later.
- Replacing the CLI or browser UI. This is a complementary interface.
- Sub-millisecond latency. FUSE adds overhead; this is for convenience, not
  high-frequency access.

## Example Session

```bash
# Mount (all spaces accessible under one mountpoint)
cf fuse mount ~/mnt/cf --api-url http://localhost:8000

# List known spaces (home is always present)
ls ~/mnt/cf/
# => home/

# List pieces in the home space
ls ~/mnt/cf/home/pieces/
# => todo-app/  weather-widget/  notes/

# Read a piece's result
cat ~/mnt/cf/home/pieces/todo-app/result.json
# => {"items":[{"text":"Buy milk","done":false}],"title":"My Todos"}

# Drill into JSON structure as directories
ls ~/mnt/cf/home/pieces/todo-app/result/
# => items/  title

cat ~/mnt/cf/home/pieces/todo-app/result/title
# => My Todos

ls ~/mnt/cf/home/pieces/todo-app/result/items/
# => 0/

cat ~/mnt/cf/home/pieces/todo-app/result/items/0/text
# => Buy milk

# Access a named space (doesn't need to appear in ls)
ls ~/mnt/cf/my-space/pieces/
# => some-other-piece/

# Write to a cell
echo -n "Buy oat milk" > ~/mnt/cf/home/pieces/todo-app/result/items/0/text

# Write JSON to the whole cell
echo '{"items":[{"text":"Buy oat milk","done":true}],"title":"Todos"}' \
  > ~/mnt/cf/home/pieces/todo-app/result.json

# Trigger a handler
echo '{"item":"New task"}' > ~/mnt/cf/home/pieces/todo-app/result/addItem.handler

# Unmount
cf fuse unmount ~/mnt/cf
```

---

**Next:** [Path Scheme and Filesystem Layout](./2-path-scheme.md)
