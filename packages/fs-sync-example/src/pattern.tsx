/**
 * UI pattern for the todo list.
 *
 * Renders synced state from the daemon and enqueues edits atomically
 * with optimistic local updates (via handler()).
 */
import {
  computed,
  Default,
  equals,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import type { Edit, FailedEdit, Todo } from "./types.ts";

// ---------------------------------------------------------------------------
// Handlers — each atomically enqueues an edit + applies optimistic update
// ---------------------------------------------------------------------------

const onCreate = handler<
  { detail: { message: string } },
  { todos: Writable<Todo[]>; edits: Writable<Edit[]> }
>(({ detail }, { todos, edits }) => {
  const description = detail?.message?.trim();
  if (!description) return;

  // Optimistic: add to local state immediately
  todos.push({
    id: `pending-${Date.now()}`,
    description,
    done: false,
  });

  // Enqueue edit for the daemon
  edits.push({ type: "create", description });
});

const onToggle = handler<
  unknown,
  { todo: Todo; todos: Writable<Todo[]>; edits: Writable<Edit[]> }
>((_event, { todo, todos, edits }) => {
  const newDone = !todo.done;

  // Optimistic update
  const current = todos.get();
  const idx = current.findIndex((t: Todo) => equals(todo, t));
  if (idx >= 0) {
    todos.set(
      current.map((t: Todo, i: number) =>
        i === idx ? { ...t, done: newDone } : t
      ),
    );
  }

  // Enqueue edit with target state
  edits.push({ type: "toggle", id: todo.id, done: newDone });
});

const onDelete = handler<
  unknown,
  { todo: Todo; todos: Writable<Todo[]>; edits: Writable<Edit[]> }
>((_event, { todo, todos, edits }) => {
  // Optimistic: remove from local state
  const current = todos.get();
  const idx = current.findIndex((t: Todo) => equals(todo, t));
  if (idx >= 0) {
    todos.set(current.toSpliced(idx, 1));
  }

  // Enqueue edit
  edits.push({ type: "delete", id: todo.id });
});

// ---------------------------------------------------------------------------
// Pattern
// ---------------------------------------------------------------------------

interface Input {
  todos: Writable<Default<Todo[], []>>;
  edits: Writable<Default<Edit[], []>>;
  appliedEdits: Default<Edit[], []>;
  failedEdits: Default<FailedEdit[], []>;
}

interface Output {
  todos: Todo[];
  edits: Edit[];
  appliedEdits: Edit[];
  failedEdits: FailedEdit[];
}

/** Filesystem-synced todo list. #fsSyncTodo */
export default pattern<Input, Output>(
  ({ todos, edits, appliedEdits, failedEdits }) => {
    const isSyncing = computed(() => edits.get().length > 0);

    return {
      [NAME]: "Todo List (fs-sync)",
      [UI]: (
        <ct-screen>
          <ct-vstack slot="header" gap="2">
            <ct-hstack justify="between" align="center">
              <ct-heading level={4}>Todo List</ct-heading>
              {ifElse(
                isSyncing,
                <span
                  style={{
                    fontSize: "12px",
                    padding: "2px 8px",
                    borderRadius: "4px",
                    background: "#fef3c7",
                    color: "#92400e",
                  }}
                >
                  Syncing...
                </span>,
                null,
              )}
            </ct-hstack>
          </ct-vstack>

          <ct-vscroll flex showScrollbar fadeEdges>
            <ct-vstack gap="2" style="padding: 1rem; max-width: 600px;">
              {/* Add todo input */}
              <ct-message-input
                placeholder="Add a todo..."
                appearance="rounded"
                onct-send={onCreate({ todos, edits })}
              />

              {/* Empty state */}
              {ifElse(
                computed(() => todos.get().length === 0),
                <div
                  style={{
                    textAlign: "center",
                    color: "var(--ct-color-gray-500)",
                    padding: "2rem",
                  }}
                >
                  No todos yet. Type above to add one!
                </div>,
                null,
              )}

              {/* Todo list */}
              {todos.map((todo) => (
                <ct-card>
                  <ct-hstack gap="2" align="center">
                    <ct-checkbox
                      $checked={todo.done}
                      onChange={onToggle({ todo, todos, edits })}
                    />
                    <span
                      style={{
                        flex: "1",
                        textDecoration: ifElse(
                          todo.done,
                          "line-through",
                          "none",
                        ),
                        opacity: ifElse(todo.done, 0.5, 1),
                      }}
                    >
                      {todo.description}
                    </span>
                    <span
                      style={{
                        fontSize: "11px",
                        color: "var(--ct-color-gray-400)",
                      }}
                    >
                      {todo.id}
                    </span>
                    <ct-button
                      variant="ghost"
                      onClick={onDelete({ todo, todos, edits })}
                    >
                      ×
                    </ct-button>
                  </ct-hstack>
                </ct-card>
              ))}

              {/* Failed edits */}
              {failedEdits.map((failed) => (
                <div
                  style={{
                    padding: "0.5rem",
                    background: "#fef2f2",
                    border: "1px solid #fca5a5",
                    borderRadius: "6px",
                    fontSize: "13px",
                    color: "#991b1b",
                  }}
                >
                  Edit failed: {failed.error}
                </div>
              ))}
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
      todos,
      edits,
      appliedEdits,
      failedEdits,
    };
  },
);
