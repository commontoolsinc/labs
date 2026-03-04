/// <cts-enable />
/**
 * UI pattern for the todo list.
 *
 * Renders synced state from the daemon and enqueues edits atomically
 * with optimistic local updates (via handler()).
 *
 * Per-item handler streams are wrapped in objects when exposed as output
 * values. This prevents the reactive system from spuriously invoking them
 * when the mapped list changes.
 */
import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  OpaqueRef,
  pattern,
  Stream,
  UI,
  Writable,
} from "commontools";
import type { Edit, FailedEdit, Todo } from "./types.ts";

// ---------------------------------------------------------------------------
// Handlers — each atomically enqueues an edit + applies optimistic update
// ---------------------------------------------------------------------------

const onCreate = handler<
  { description?: string },
  {
    todos: Writable<Todo[]>;
    edits: Writable<Edit[]>;
    draftTitle: Writable<string>;
  }
>((event, { todos, edits, draftTitle }) => {
  // Tests send { description }, UI reads from draftTitle cell
  const description = (event?.description || draftTitle.get()).trim();
  if (!description) return;
  draftTitle.set("");

  const pendingId = `pending-${Date.now()}-${
    Math.random().toString(36).slice(2)
  }`;

  // Optimistic: add to local state immediately
  todos.push({
    id: pendingId,
    description,
    done: false,
  });

  // Enqueue edit for the daemon (pendingId lets the daemon map it to canonical)
  edits.push({ type: "create", description, pendingId });
});

const onToggle = handler<
  unknown,
  { todo: Writable<Todo>; edits: Writable<Edit[]> }
>((_event, { todo, edits }) => {
  const newDone = !todo.get().done;
  todo.key("done").set(newDone);
  edits.push({ type: "toggle", id: todo.get().id, done: newDone });
});

const onDelete = handler<
  unknown,
  {
    todo: Todo;
    todos: Writable<Todo[]>;
    edits: Writable<Edit[]>;
  }
>((_event, { todo, todos, edits }) => {
  // Optimistic: remove from local state
  todos.remove(todo);

  // Enqueue edit
  edits.push({ type: "delete", id: todo.id });
});

const onUpdate = handler<
  unknown,
  { todo: Writable<Todo>; edits: Writable<Edit[]> }
>((_event, { todo, edits }) => {
  // $value binding already updated the cell — just enqueue the edit
  edits.push({
    type: "update",
    id: todo.get().id,
    description: todo.get().description,
  });
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
  create: OpaqueRef<Stream<{ description?: string }>>;
  // Per-item actions wrapped in objects (safe from spurious invocation)
  actions: Array<{
    toggle: OpaqueRef<Stream<unknown>>;
    delete: OpaqueRef<Stream<unknown>>;
    update: OpaqueRef<Stream<unknown>>;
  }>;
}

/** Filesystem-synced todo list. #fsSyncTodo */
export default pattern<Input, Output>(
  ({ todos, edits, appliedEdits, failedEdits }) => {
    const isSyncing = computed(() => edits.get().length > 0);
    const draftTitle = Writable.of("");

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
              {/* Add todo */}
              <ct-hstack gap="2" align="center">
                <ct-input
                  $value={draftTitle}
                  placeholder="Add a todo..."
                  onct-submit={onCreate({ todos, edits, draftTitle })}
                  style={{ flex: "1" }}
                />
                <ct-button
                  variant="primary"
                  onClick={onCreate({ todos, edits, draftTitle })}
                >
                  Add
                </ct-button>
              </ct-hstack>

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
                      checked={todo.done}
                      onct-change={onToggle({ todo, edits })}
                    />
                    <ct-input
                      $value={todo.description}
                      onct-submit={onUpdate({ todo, edits })}
                      style={{ flex: "1" }}
                    />
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
      create: onCreate({ todos, edits, draftTitle }),
      // Per-item actions wrapped in objects (safe from spurious invocation)
      actions: todos.map((todo) => ({
        toggle: onToggle({ todo, edits }),
        delete: onDelete({ todo, todos, edits }),
        update: onUpdate({ todo, edits }),
      })),
    };
  },
);
