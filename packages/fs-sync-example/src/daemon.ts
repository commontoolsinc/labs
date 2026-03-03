/**
 * Filesystem sync daemon for a todo list backed by a markdown file.
 *
 * Demonstrates every load-bearing piece from the bidirectional_sync doc:
 * - CAS retry loop with editWatermark
 * - editIdMap surviving retries
 * - Single-transaction commit (apply edits + update state + clear queue)
 * - Cell.of() for stable identity
 * - Write redirect links for in-flight creates
 * - Lockfile for process safety
 * - System vs conflict error handling
 */

import { Runtime } from "@commontools/runner";
import { popFrame, pushFrameFromCause } from "@commontools/runner";
import type { Cell, MemorySpace } from "@commontools/runner";
import { debounce } from "@std/async";

import type { Edit, FailedEdit, State } from "./types.ts";
import type { Todo } from "./types.ts";
import { parseMarkdown, serializeMarkdown } from "./markdown.ts";

// ---------------------------------------------------------------------------
// Lockfile
// ---------------------------------------------------------------------------

function acquireLock(lockPath: string): boolean {
  try {
    Deno.writeTextFileSync(lockPath, String(Deno.pid), {
      createNew: true,
    });
    return true;
  } catch {
    // Check if the existing lock's PID is still alive
    try {
      const existingPid = parseInt(
        Deno.readTextFileSync(lockPath),
        10,
      );
      Deno.kill(existingPid, "SIGCONT"); // throws if process is dead
      return false; // Process is alive, lock is valid
    } catch {
      // Stale lock — reclaim it
      Deno.writeTextFileSync(lockPath, String(Deno.pid));
      return true;
    }
  }
}

function releaseLock(lockPath: string) {
  try {
    Deno.removeSync(lockPath);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function isSystemError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("permission denied") ||
    msg.includes("no space left") ||
    msg.includes("disk full") ||
    msg.includes("enospc") ||
    msg.includes("eacces")
  );
}

// ---------------------------------------------------------------------------
// Apply a single edit to the markdown file on disk
// ---------------------------------------------------------------------------

interface ApplyResult {
  canonicalId?: string; // Set for "create" edits
}

function applyEdit(
  edit: Edit,
  filePath: string,
): ApplyResult {
  const text = Deno.readTextFileSync(filePath);
  const state = parseMarkdown(text);

  switch (edit.type) {
    case "create": {
      const id = `T-${String(state.nextId).padStart(2, "0")}`;
      state.todos.push({
        id,
        description: edit.description,
        done: false,
      });
      state.nextId++;
      Deno.writeTextFileSync(filePath, serializeMarkdown(state));
      return { canonicalId: id };
    }

    case "toggle": {
      const todo = state.todos.find((t) => t.id === edit.id);
      if (!todo) {
        throw new Error(
          `Cannot toggle: todo ${edit.id} not found (deleted externally?)`,
        );
      }
      todo.done = edit.done;
      Deno.writeTextFileSync(filePath, serializeMarkdown(state));
      return {};
    }

    case "delete": {
      const idx = state.todos.findIndex((t) => t.id === edit.id);
      if (idx === -1) {
        // Already gone — not an error, just a no-op
        return {};
      }
      state.todos.splice(idx, 1);
      Deno.writeTextFileSync(filePath, serializeMarkdown(state));
      return {};
    }
  }
}

// ---------------------------------------------------------------------------
// Build cell state from filesystem using Cell.of() for stable identity
// ---------------------------------------------------------------------------

function buildStateFromFs(
  filePath: string,
  CellOf: (value: unknown) => Cell<any>,
): State {
  const text = Deno.readTextFileSync(filePath);
  const parsed = parseMarkdown(text);

  return {
    // Cell.of() ensures stable cell identity derived from the canonical ID.
    // Links to this todo survive across syncs.
    todos: parsed.todos.map((todo) =>
      CellOf(todo.id).set({
        id: todo.id,
        description: todo.description,
        done: todo.done,
      }) as unknown as Todo
    ),
  };
}

// ---------------------------------------------------------------------------
// The sync loop — follows the doc's structure exactly
// ---------------------------------------------------------------------------

/**
 * Map from create-edit index to the temporary cell allocated by the pattern.
 * The daemon uses this to write redirect links from temp cells to canonical
 * cells once the canonical ID is known.
 */
export type TempRefMap = Map<number, Cell<Todo>>;

export function runSyncLoop(
  runtime: Runtime,
  space: MemorySpace,
  stateCell: Cell<State>,
  editsCell: Cell<Edit[]>,
  appliedEditsCell: Cell<Edit[]>,
  failedEditsCell: Cell<FailedEdit[]>,
  todoFilePath: string,
  CellConstructor: { of: (value: unknown) => Cell<any> },
  tempRefs?: TempRefMap,
) {
  const lockPath = todoFilePath + ".lock";
  if (!acquireLock(lockPath)) {
    throw new Error(
      `Another sync daemon is already running (lockfile: ${lockPath})`,
    );
  }

  // Clean up on exit
  const cleanup = () => releaseLock(lockPath);
  globalThis.addEventListener("unload", cleanup);

  // Ensure the markdown file exists
  try {
    Deno.statSync(todoFilePath);
  } catch {
    Deno.writeTextFileSync(
      todoFilePath,
      serializeMarkdown({ nextId: 1, todos: [] }),
    );
  }

  // Concurrency guard: only one sync runs at a time.
  let syncInProgress = false;
  let syncAgain = false;

  const debouncedSync = debounce(sync, 100);

  function scheduleSync() {
    syncAgain = true;
    debouncedSync();
  }

  // Watch filesystem for changes
  const watcher = Deno.watchFs(todoFilePath);
  (async () => {
    for await (const _event of watcher) {
      scheduleSync();
    }
  })();

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
    const editIdMap = new Map<Edit, string>(); // Survives CAS retries
    let committed = false;

    while (!committed) {
      // Wait for any in-flight syncs to settle
      await runtime.storageManager.synced();

      // Create transaction and frame
      const tx = runtime.edit();
      pushFrameFromCause("fs-sync-example", {
        runtime,
        tx,
        space,
      });

      try {
        const edits = editsCell.get();

        // 1. Apply NEW edits to the filesystem (only past the watermark).
        //    On first iteration watermark is 0, so all edits are applied.
        //    On retry (tx failed because new edits arrived), only new
        //    edits beyond the watermark are applied — earlier ones are
        //    already on disk.
        const applied: Edit[] = [];
        const failed: FailedEdit[] = [];
        for (let i = editWatermark; i < edits.length; i++) {
          const edit = edits[i];
          try {
            const result = applyEdit(edit, todoFilePath);
            if (edit.type === "create" && result.canonicalId) {
              editIdMap.set(edit, result.canonicalId);
            }
            applied.push(edit);
          } catch (err) {
            if (isSystemError(err)) {
              // System error: keep edit in queue, crash loud.
              throw new Error(
                `System error applying edit: ${(err as Error).message}. ` +
                  `Edit remains in queue. Fix the issue and restart.`,
              );
            }
            // Conflict error: collect for commit alongside applied edits
            failed.push({
              edit,
              error: (err as Error).message,
            });
          }
        }
        editWatermark = edits.length;

        // 2. Read full filesystem state, build cell structure.
        //    Cell.of() is used inside buildStateFromFs for each todo.
        stateCell.set(
          buildStateFromFs(todoFilePath, CellConstructor.of),
        );

        // 3. Write redirect links for newly created items.
        //    tempRefs maps edit indices to the temp cells allocated by the
        //    pattern's optimistic create. Once we know the canonical ID,
        //    we redirect the temp cell to the canonical Cell.of() cell.
        if (tempRefs) {
          for (const [editIdx, tempCell] of tempRefs) {
            const edit = edits[editIdx];
            const canonicalId = edit && editIdMap.get(edit);
            if (canonicalId) {
              const canonicalCell = CellConstructor.of(canonicalId);
              const resolved = tempCell.resolveAsCell();
              resolved.setRaw(
                canonicalCell.getAsWriteRedirectLink({ base: resolved }),
              );
              tempRefs.delete(editIdx);
            }
          }
        }

        // 4. Clear edit queue, record applied and failed edits
        appliedEditsCell.push(...applied);
        failedEditsCell.push(...failed);
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

  // Return a dispose function
  return {
    dispose() {
      watcher.close();
      releaseLock(lockPath);
      globalThis.removeEventListener("unload", cleanup);
    },
  };
}
