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
} from "commonfabric";
import type { Edit, FailedEdit, Todo } from "./types.ts";

// ---------------------------------------------------------------------------
// Handlers — each atomically enqueues an edit + applies optimistic update
// ---------------------------------------------------------------------------

const onCreate = handler<
  { detail: { message: string } },
  {
    todos: Writable<Todo[]>;
    edits: Writable<Edit[]>;
  }
>(({ detail }, { todos, edits }) => {
  const description = detail?.message?.trim();
  if (!description) return;

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
  create: OpaqueRef<Stream<{ detail: { message: string } }>>;
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

    return {
      [NAME]: "Todo List (fs-sync)",
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="2">
            <cf-hstack justify="between" align="center">
              <cf-heading level={4}>Todo List</cf-heading>
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
            </cf-hstack>
          </cf-vstack>

          <cf-vscroll flex showScrollbar fadeEdges>
            <cf-vstack gap="2" style="padding: 1rem; max-width: 600px;">
              {/* Add todo */}
              <cf-message-input
                placeholder="Add a todo..."
                oncf-send={onCreate({ todos, edits })}
              />

              {/* Empty state */}
              {ifElse(
                computed(() => todos.get().length === 0),
                <div
                  style={{
                    textAlign: "center",
                    color: "var(--cf-color-gray-500)",
                    padding: "2rem",
                  }}
                >
                  No todos yet. Type above to add one!
                </div>,
                null,
              )}

              {/* Todo list */}
              {todos.map((todo) => (
                <cf-card>
                  <cf-hstack gap="2" align="center">
                    <cf-checkbox
                      checked={todo.done}
                      oncf-change={onToggle({ todo, edits })}
                    />
                    <cf-input
                      $value={todo.description}
                      oncf-submit={onUpdate({ todo, edits })}
                      oncf-blur={onUpdate({ todo, edits })}
                      style={{ flex: "1" }}
                    />
                    <span
                      style={{
                        fontSize: "11px",
                        color: "var(--cf-color-gray-400)",
                      }}
                    >
                      {todo.id}
                    </span>
                    <cf-button
                      variant="ghost"
                      onClick={onDelete({ todo, todos, edits })}
                    >
                      ×
                    </cf-button>
                  </cf-hstack>
                </cf-card>
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
            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),
      todos,
      edits,
      appliedEdits,
      failedEdits,
      create: onCreate({ todos, edits }),
      // Per-item actions wrapped in objects (safe from spurious invocation)
      actions: todos.map((todo) => ({
        toggle: onToggle({ todo, edits }),
        delete: onDelete({ todo, todos, edits }),
        update: onUpdate({ todo, edits }),
      })),
    };
  },
);
