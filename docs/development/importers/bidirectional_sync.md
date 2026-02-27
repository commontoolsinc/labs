# Bidirectional Sync with External Canonical Source

This guide covers how to build reliable bidirectional synchronization between
Common Tools cells and an external system (filesystem, API, etc.) where the
**external source is canonical** — meaning it is the source of truth, and local
state is a reflection of it.

## Core Principles

### 1. Atomic Transactions with CAS Semantics

All actions in the Common Tools runtime (`computed()`, `action()`, `handler()`)
are atomic and have compare-and-swap (CAS) transaction guarantees. When code
reads data and then writes data, the runtime collects all mutations (`.set()`,
`.push()`, etc.) and applies them atomically at commit time. If any value that
was read has changed since the transaction began, the commit is aborted and the
action retries with the new data.

This is a powerful primitive for sync: you never have a half-applied state, and
you never silently lose a concurrent edit.

### 2. Local Edit Queue

Collect local edits into an array cell. Each edit describes the user's intent
(e.g., "rename file X to Y", "create item Z"). The queue is append-only during
normal operation.

Optimistically apply edits on top of the synced state in the same atomic
transaction that enqueues them. This gives instant UI feedback. Since the
external source is canonical, the next sync will overwrite the local state with
the real data — and that's fine. The optimistic state is just a bridge until the
sync catches up.

### 3. External Source Wins

On each sync cycle, read the full state from the external source and write it
into cells. This overwrites any locally-modified state. Local edits survive
because they live in the edit queue, which gets applied to the external source
_before_ reading it back.

### 4. Anti-Backsliding via Single Transaction

To prevent the window where synced state temporarily reverts a pending edit:

- In a **single transaction**, apply pending edits to the external source, read
  back the canonical state, write it to cells, and clear the edit queue.
- If the transaction fails, it's because a new local edit was appended. Since
  the queue is append-only, just retry — catch up with the newest edits and try
  again.
- Optionally move applied edits to an `appliedEdits` array for audit/UI
  purposes.

### 5. Stable Identity via `Cell.of()`

When writing items that have an external canonical ID, use
`Cell.of(externalId).set(...)` to create the data. This ensures that links
created in the fabric point to stable cells derived from the canonical ID,
rather than ephemeral cells that get replaced on each sync.

This is especially important for items inside arrays — without stable IDs, every
sync would create new cells and break any existing links.

### 6. Write Redirect Links for In-Flight Edits

When a local edit creates a new item (before it has a canonical ID), the edit
allocates a new cell. Once the external source assigns a canonical ID, create a
write redirect link from the edit-allocated cell to the canonical cell. This
ensures any links created between the edit and the sync remain valid.

```typescript
// After getting canonical ID for a newly created item:
const canonicalCell = Cell.of(canonicalId);
const editCell = item.asResolvedCell();
editCell.setRaw(canonicalCell.getAsWriteRedirectLink({ base: editCell }));
```

---

## Filesystem Daemon Sync

This is the primary pattern: a long-running daemon process that watches a
directory and keeps cells in sync with the filesystem.

### Architecture

```
┌──────────────┐       ┌──────────┐       ┌──────────────┐
│  Pattern UI  │──────▶│  Cells   │◀──────│    Daemon    │
│  (user edits │       │  (state  │       │  (fs watcher │
│   via queue) │       │  + queue)│       │   + syncer)  │
└──────────────┘       └──────────┘       └──────────────┘
                                                 │
                                          ┌──────┴──────┐
                                          │  Filesystem  │
                                          │  (canonical) │
                                          └─────────────┘
```

### Daemon Setup

```typescript
import { Runtime } from "@commontools/runner";
import { popFrame, pushFrameFromCause } from "@commontools/runner/builder";

const runtime = new Runtime(/* storage config */);

// Sync the cells you'll operate on
await Promise.all([
  stateCell.sync(),
  editsCell.sync(),
  runtime.storageManager.synced(),
]);
```

### The Sync Loop

```typescript
async function runSyncLoop(
  runtime: Runtime,
  space: MemorySpace,
  stateCell: Cell<State>,
  editsCell: Cell<Edit[]>,
  appliedEditsCell: Cell<Edit[]>,
  watchPath: string,
) {
  // Concurrency guard: only one sync runs at a time.
  // If a notification arrives mid-sync, we set syncAgain = true so
  // another full cycle runs immediately after the current one finishes.
  // Worst case: we re-read the filesystem, produce no diffs, no-op.
  let syncInProgress = false;
  let syncAgain = false;

  const debouncedSync = debounce(sync, 100);

  function scheduleSync() {
    syncAgain = true;
    debouncedSync();
  }

  // Watch filesystem for changes
  const watcher = fs.watch(watchPath, { recursive: true }, scheduleSync);

  // Watch edit queue for new entries
  editsCell.sink(scheduleSync);

  async function sync() {
    if (syncInProgress) {
      syncAgain = true;
      return;
    }

    syncInProgress = true;
    try {
      do {
        syncAgain = false;
        await doSync();
      } while (syncAgain);
    } finally {
      syncInProgress = false;
    }
  }

  async function doSync() {
    let editWatermark = 0; // Track which edits have been applied to fs
    const editIdMap: Map<Edit, string> = new Map(); // Survives CAS retries
    let committed = false;

    while (!committed) {
      // Wait for any in-flight syncs to settle
      await runtime.storageManager.synced();

      // Create transaction and frame
      const tx = runtime.edit();
      const frame = pushFrameFromCause("my-importer", {
        runtime,
        tx,
        space,
      });

      try {
        const edits = editsCell.get();

        // 1. Apply NEW edits to the filesystem (only past the watermark)
        //    On first iteration watermark is 0, so all edits are applied.
        //    On retry (tx failed because new edits arrived), only the
        //    new edits beyond the watermark are applied — earlier ones
        //    are already on disk.
        for (let i = editWatermark; i < edits.length; i++) {
          const edit = edits[i];
          try {
            applyEditToFilesystem(edit, watchPath);
            if (edit.type === "create") {
              editIdMap.set(edit, getCanonicalId(edit, watchPath));
            }
          } catch (err) {
            if (isSystemError(err)) {
              // System error: keep edit in queue, crash loud.
              // Operator fixes the condition, restarts daemon.
              throw new Error(
                `System error applying edit: ${err.message}. ` +
                  `Edit remains in queue. Fix the issue and restart.`,
              );
            }
            // Conflict error: move to failedEdits for user reformulation
            failedEditsCell.push({ edit, error: err.message });
          }
        }
        editWatermark = edits.length;

        // 2. Read full filesystem state, build cell structure
        //    IMPORTANT: Use Cell.of(canonicalId) for each item that has
        //    an external ID. This ensures stable links in the fabric.
        const fsState = readFilesystemState(watchPath);
        stateCell.set(
          buildStateFromFs(fsState), // Must use Cell.of() internally — see below
        );

        // 3. Write redirect links for newly created items
        for (const [edit, canonicalId] of editIdMap) {
          const canonicalCell = Cell.of(canonicalId);
          const editCell = edit.tempRef.asResolvedCell();
          editCell.setRaw(
            canonicalCell.getAsWriteRedirectLink({ base: editCell }),
          );
        }

        // 4. Clear edit queue, record applied edits
        appliedEditsCell.push(...edits);
        editsCell.set([]);
      } finally {
        popFrame();
      }

      // 5. Commit — retry if transaction failed
      const { error } = await tx.commit();
      if (!error) {
        committed = true;
      }
      // If error, loop again: a new edit was appended, so catch up.
      // The watermark ensures we don't re-apply edits to the filesystem.
    }
  }

  // Initial sync
  scheduleSync();
}
```

### Building State with Stable Identity

> **TODO(seefeld):** `Cell.of()` in handler frames creates cells scoped to that
> handler invocation. For importers operating outside a pattern, we need a shared
> frame so `Cell.of()` produces consistent cells across the whole import. Current
> workaround: `pushFrameFromCause` with a stable cause string. This needs
> platform-level support.

The `buildStateFromFs` function (or equivalent) **must** use `Cell.of()` for
every sub-item that has an external canonical ID. For example:

```typescript
function buildStateFromFs(fsState: FsState): State {
  return {
    items: fsState.items.map((item) =>
      // Cell.of() ensures this item has a stable cell derived from
      // its canonical ID. Links to this item survive across syncs.
      Cell.of(item.canonicalId).set({
        name: item.name,
        path: item.path,
        // ...
      })
    ),
  };
}
```

This is not a post-processing step — it must happen as part of constructing the
state structure. If you write the structure first and then try to set up
`Cell.of()` mappings afterward, the items in the array will have ephemeral cell
IDs that break on every sync.

### Don't Diff — Let the Runtime Do It

When writing the full state to cells, write the entire structure at once with a
single `.set()`. Don't manually diff old vs. new state. The cell infrastructure
diffs internally and only persists the minimal changes.

Only consider manual diffing once the dataset is too large to load into memory
at once. You're far from that threshold.

### Process Safety: Lockfiles

Only one daemon instance should run per sync target. Use a lockfile with the
daemon's PID:

```typescript
const lockPath = path.join(watchPath, ".sync.lock");

function acquireLock(): boolean {
  try {
    // Atomic create — fails if file exists
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    // Check if the existing lock's PID is still alive
    const existingPid = parseInt(fs.readFileSync(lockPath, "utf8"));
    try {
      process.kill(existingPid, 0); // Signal 0 = check if alive
      return false; // Process is alive, lock is valid
    } catch {
      // Stale lock from a crashed process — reclaim it
      fs.writeFileSync(lockPath, String(process.pid));
      return true;
    }
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(lockPath);
  } catch {}
}

// Clean up on exit
process.on("exit", releaseLock);
process.on("SIGINT", () => {
  releaseLock();
  process.exit();
});
process.on("SIGTERM", () => {
  releaseLock();
  process.exit();
});
```

### Error Handling: Failed Edits

Not all edit failures are equal. Two categories require different strategies:

- **System errors** (permissions, disk full, network timeout): The environment
  is broken — retrying won't help until an operator intervenes. **Keep the
  failed edit in the queue** (don't clear it) and **crash the daemon with a
  clear error message.** The operator fixes the condition (frees disk, fixes
  permissions), restarts the daemon, and the edit applies naturally on the next
  sync cycle.
- **Conflict errors** (file was deleted externally, path collision): The edit
  can't succeed as-is and won't succeed on retry either. Move to a `failedEdits`
  queue and surface to the user for reformulation. The daemon continues running.

```typescript
// In the edit application loop:
try {
  applyEditToFilesystem(edit, watchPath);
} catch (err) {
  if (isSystemError(err)) {
    // Don't clear the queue — this edit and all after it are preserved.
    // Crash loud so the operator knows what to fix.
    throw new Error(
      `System error applying edit: ${err.message}. ` +
        `Edit remains in queue. Fix the issue and restart.`,
    );
  }
  // Conflict: move to failed queue, continue with remaining edits
  failedEditsCell.push({ edit, error: err.message });
}
```

---

## Pattern (UI) Side

The pattern that presents this synced state to users is straightforward because
the daemon handles all the complexity.

### Rendering

Render directly from the synced state cell. No local state management, no
optimistic-update tracking in the UI layer.

```tsx
const myPattern = pattern<{ state: State; edits: Edit[] }>(
  ({ state, edits }) => {
    return (
      <div>
        {state.items.map((item) => <div key={item.id}>{item.name}</div>)}
      </div>
    );
  },
);
```

### Editing

On user interaction, atomically (via `action()` or `handler()`) do two things:

1. Append the edit to the edit queue
2. Optimistically apply the change to the local state

```tsx
const onRename = handler<{ item: Item; edits: Edit[] }>(
  ({ item, edits }, newName: string) => {
    // Enqueue the edit
    edits.push({ type: "rename", id: item.id, name: newName });

    // Optimistic update — will be overwritten by next sync
    item.name = newName;
  },
);
```

Because both mutations happen in a single atomic transaction, the UI never sees
an inconsistent state.

### Rendering Pending State

There are two simple approaches — choose based on your UI needs:

**Option A: Inline pending state.** Link the edit data directly into the state
structure. It renders while it's there, and automatically disappears when the
sync overwrites the state. No cleanup logic needed — reactivity handles it.

**Option B: Render the queues.** Show the `edits` array (pending) and
`appliedEdits` array (done) directly. This works well for progress indicators or
"syncing..." badges.

```tsx
{
  edits.length > 0 && (
    <span class="sync-badge">Syncing {edits.length} changes...</span>
  );
}
```

---

## API / Webhook Sync

API-based sync (e.g., syncing GitHub issues) shares the same core principles as
filesystem sync but differs in important ways:

- **Operations are asynchronous and may fail independently.** A single "apply
  edits" step may involve multiple API calls, some of which succeed and some
  fail.
- **Reading canonical state requires an API call** that may be slow or
  rate-limited, unlike reading the filesystem which is effectively instant.
- **There is no filesystem as a merge point.** The daemon pattern uses the
  filesystem as an implicit merge layer (write edits to files, read files back).
  With an API, you need explicit merge logic.

For webhook infrastructure details, see
[docs/specs/webhook-ingress/README.md](/docs/specs/webhook-ingress/README.md).

### Edits as Lifecycle Entities

In filesystem sync, edits are simple intent records that get applied and cleared
in a single transaction. API sync can't do that — API calls take time, may fail,
and may be confirmed asynchronously via webhook. So each edit becomes a
first-class entity with its own lifecycle:

```
pending → in-flight → succeeded | failed
```

An edit carries:

- **type** — the action (e.g., `"create-issue"`, `"close-pr"`, `"add-star"`)
- **target** — cell reference or canonical ID indicating where to render this
  edit (e.g., "this belongs on the issues list", "this belongs on PR #42")
- **payload** — the data for the action
- **stage** — `pending`, `in-flight`, `succeeded`, or `failed`
- **error** — error info when `failed`
- **timestamps** — `createdAt`, `sentAt`, `resolvedAt`

```typescript
interface ApiEdit {
  type: string;
  target: CellReference; // Where this edit should render
  payload: Record<string, unknown>;
  stage: "pending" | "in-flight" | "succeeded" | "failed";
  error?: string;
  createdAt: number;
  sentAt?: number;
  resolvedAt?: number;
}
```

A computed index maps targets to their pending edits for efficient lookup:

```typescript
const editsByTarget = computed(() => {
  const index = new Map<CellReference, ApiEdit[]>();
  for (const edit of editsCell.get()) {
    if (edit.stage === "pending" || edit.stage === "in-flight") {
      const list = index.get(edit.target) ?? [];
      list.push(edit);
      index.set(edit.target, list);
    }
  }
  return index;
});
```

#### Heavy vs. Lightweight Actions

Not all edits are treated the same:

- **Heavy actions** (create issue, close PR, merge branch): Do NOT optimistically
  apply to local state. Instead, render the edit itself as a pending action in the
  UI — a grayed-out card with a spinner. When the API responds or a webhook
  confirms success, write the real entity with `Cell.of(canonicalId)`. No write
  redirects are needed because the edit was never materialized as a cell in the
  state structure.

- **Lightweight actions** (star, emoji react, label toggle): CAN be optimistically
  applied to local state, just like filesystem edits. The next sync overwrites
  with canonical data.

The key insight: heavy actions avoid the write-redirect complexity entirely by
keeping the edit and the canonical entity as separate things until confirmation.

### Outbound: Triggering API Actions

When the user performs an action:

1. **Create the edit** — atomically append to the edits cell with
   `stage: "pending"`
2. **Fire the API call** — immediately dispatch the request and advance to
   `stage: "in-flight"`
3. **On success** — write the canonical entity via `Cell.of(canonicalId)`,
   advance edit to `succeeded`, clean up
4. **On failure** — mark edit as `failed` with error info

```typescript
const createIssue = handler<{ edits: ApiEdit[] }>(
  ({ edits }, title: string, body: string) => {
    const edit: ApiEdit = {
      type: "create-issue",
      target: issueListRef,
      payload: { title, body },
      stage: "pending",
      createdAt: Date.now(),
    };
    edits.push(edit);

    // Fire immediately — runs after the transaction commits
    queueMicrotask(async () => {
      edit.stage = "in-flight";
      edit.sentAt = Date.now();
      try {
        const result = await github.createIssue({ title, body });
        // Write canonical entity
        Cell.of(`issue:${result.number}`).set({
          number: result.number,
          title: result.title,
          body: result.body,
          state: result.state,
        });
        edit.stage = "succeeded";
        edit.resolvedAt = Date.now();
      } catch (err) {
        edit.stage = "failed";
        edit.error = err.message;
        edit.resolvedAt = Date.now();
      }
    });
  },
);
```

> **Future:** A retry mechanism for edits that never got a response (network
> failure, process restart). For now, assume we always get a response — either
> immediately from the API call or asynchronously via webhook.

### Inbound: Webhook Incremental Updates

Webhooks deliver events as they happen. Each event is applied as an incremental
update in a single transaction:

```typescript
async function handleWebhookEvent(event: WebhookEvent) {
  // Deduplicate via event ID (idempotency)
  if (processedEvents.has(event.id)) return;
  processedEvents.add(event.id);

  // Handle out-of-order delivery: ignore stale updates
  const existing = Cell.of(`issue:${event.issue.number}`).get();
  if (existing && existing.updatedAt > event.issue.updatedAt) return;

  // Apply the update
  Cell.of(`issue:${event.issue.number}`).set({
    number: event.issue.number,
    title: event.issue.title,
    body: event.issue.body,
    state: event.issue.state,
    updatedAt: event.issue.updatedAt,
  });

  // If this confirms a pending edit, advance it
  const pendingEdit = findMatchingEdit(event);
  if (pendingEdit) {
    pendingEdit.stage = "succeeded";
    pendingEdit.resolvedAt = Date.now();
  }
}
```

Key considerations:

- **Idempotency** — Deduplicate via event ID. Webhooks may be delivered more than
  once.
- **Ordering** — Use timestamps or sequence numbers to ignore stale updates.
  If event B has an older timestamp than data you already have, skip it.
- **Confirming edits** — When a webhook confirms an action you initiated, advance
  the corresponding edit to `succeeded`.

For webhook infrastructure, see
[docs/specs/webhook-ingress/README.md](/docs/specs/webhook-ingress/README.md).

### Consistency Backstop: Full Rebuild

Webhooks are best-effort. To catch missed events, drift, and eventual consistency
gaps, periodically (or on user request) run a full rebuild:

```typescript
async function fullRebuild() {
  // Read everything from the API
  const allIssues = await github.listAllIssues();
  const allPRs = await github.listAllPullRequests();

  // Write full structure in a single transaction
  const tx = runtime.edit();
  const frame = pushFrameFromCause("github-importer", { runtime, tx, space });
  try {
    stateCell.set({
      issues: allIssues.map((issue) =>
        Cell.of(`issue:${issue.number}`).set({
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          updatedAt: issue.updatedAt,
        })
      ),
      pullRequests: allPRs.map((pr) =>
        Cell.of(`pr:${pr.number}`).set({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          updatedAt: pr.updatedAt,
        })
      ),
    });
  } finally {
    popFrame();
  }
  await tx.commit();
}
```

This is the same pattern as filesystem sync: read everything, write with
`Cell.of()`, single transaction. The only difference is the data source.

### Pattern (UI) Integration for API Sync

The pattern renders canonical state as normal, plus overlays pending and failed
edits at the appropriate locations:

```tsx
const issueList = pattern<{ state: State; edits: ApiEdit[] }>(
  ({ state, edits }) => {
    const pendingEdits = computed(() =>
      edits.filter((e) =>
        e.target === issueListRef &&
        (e.stage === "pending" || e.stage === "in-flight")
      )
    );
    const failedEdits = computed(() =>
      edits.filter((e) => e.target === issueListRef && e.stage === "failed")
    );

    return (
      <div>
        {/* Canonical state */}
        {state.issues.map((issue) => <IssueCard issue={issue} />)}

        {/* Pending edits: grayed-out cards with spinner */}
        {pendingEdits.map((edit) => (
          <div class="pending-card">
            <Spinner /> {edit.payload.title}
          </div>
        ))}

        {/* Failed edits: error + retry/cancel */}
        {failedEdits.map((edit) => (
          <div class="failed-card">
            <span class="error">{edit.error}</span>
            <button onClick={() => retryEdit(edit)}>Retry</button>
            <button onClick={() => cancelEdit(edit)}>Cancel</button>
          </div>
        ))}
      </div>
    );
  },
);
```

Succeeded edits auto-disappear: once a webhook or full rebuild writes the
canonical entity, the edit is marked `succeeded` and filtered out of the pending
display. No manual cleanup needed — reactivity handles it.

---

## Applied Edits Lifecycle

The `appliedEdits` array records edits that were successfully synced. Its
lifecycle is TBD per use case. Some options:

- **Keep it simple.** Since this is O(user operations), the array stays small
  enough that unbounded growth is not a concern in practice.
- **Date-based history.** Periodically move old entries to a dated archive cell
  (e.g., `appliedEdits-2026-02-27`), keeping the active array short.
- **Fixed window.** Keep the last N entries and discard older ones.
- **Pattern-driven cleanup.** Let the UI pattern clear `appliedEdits` after
  rendering confirmation to the user.

Start simple (keep everything in the array) and add cleanup when you actually
need it.

---

## Summary

| Concern                | Solution                                               |
| ---------------------- | ------------------------------------------------------ |
| Atomicity              | CAS transactions — all mutations commit or retry       |
| Optimistic updates     | Apply edits to local state in same tx as enqueue       |
| External canonical     | Overwrite local state from external source each sync   |
| Anti-backsliding       | Single tx: apply edits + update state + clear queue    |
| Stable identity        | `Cell.of(externalId)` for canonical-ID-bearing items   |
| In-flight link safety  | Write redirect links from temp cells to canonical ones |
| Process safety         | Lockfile with PID, stale lock recovery                 |
| System edit failures   | Keep in queue, crash daemon, operator restarts         |
| Conflict edit failures | Move to failedEdits queue, surface to user             |
| UI pending state       | Render from edit queue; auto-clears on sync            |
| Edit lifecycle         | Staged entities: pending → in-flight → succeeded/failed |
| Heavy actions          | Render as pending edits, not optimistic state          |
| Webhook sync           | Incremental updates via `Cell.of()`; full rebuild as backstop |
