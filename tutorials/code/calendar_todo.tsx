/// <cts-enable />
import {
  type Cell,
  Default,
  handler,
  lift,
  recipe,
  UI,
} from "commontools";

interface CalendarTodoState {
  todos: Default<Record<string, string[]>, {}>;
  date: Default<string, "">;
}

const addTodo = handler<
  { detail: { message: string } },
  { todos: Cell<Record<string, string[]>>; date: string }
>(
  (event, { todos, date }) => {
    const message = event.detail.message?.trim();
    if (!message || !date) return;
    const currentTodos = todos.get() || {};
    const dateTodos = currentTodos[date] || [];
    const newTodos = [...dateTodos, message];
    const updatedTodos = { ...currentTodos, [date]: newTodos };
    console.log(
      "New todos after addition:",
      { message, date, currentTodos, newTodos, updatedTodos },
    );
    todos.set(updatedTodos);
  },
);

const removeTodo = handler<
  { target: { dataset: Record<string, string> } },
  { todos: Cell<Record<string, string[]>>; date: string }
>(
  (event, { todos, date }) => {
    console.log("removeTodo event:", event);

    const index = parseInt(event.target?.dataset?.index || "-1", 10);
    if (index === -1 || !date) return;

    const currentTodos = todos.get() || {};
    const dateTodos = currentTodos[date] || [];

    const newTodos = dateTodos.toSpliced(index, 1);

    const updatedTodos = { ...currentTodos, [date]: newTodos };
    console.log("New todos after removal:", updatedTodos);

    todos.set(updatedTodos);
  },
);

export default recipe<CalendarTodoState>(
  "calendar_todo",
  ({ todos, date }) => {
    // Get todos for the specific date
    const todosForDate = lift(
      ({ todos, date }: { todos: Record<string, string[]>; date: string }) => {
        if (!todos) return [];
        return todos[date] || [];
      },
    )({ todos, date });

    return {
      [UI]: (
        <div onclick={removeTodo({ todos, date })}>
          <p>Date: {date}</p>
          <div>
            <common-send-message
              name="Add"
              placeholder="Enter new todo..."
              onmessagesend={addTodo({ todos, date })}
            />
            {date && todosForDate && todosForDate.length > 0 && (
              <div style="background: #f0f0f0; padding: 1rem; margin-top: 1rem; border-radius: 4px;">
                <h4 style="margin-top: 0;">Todos for {date}:</h4>
                <ul>
                  {todosForDate.map((todo, index) => (
                    <li key={index} style="display: flex; align-items: center; gap: 0.5rem;">
                      <span>{todo}</span>
                      <div
                        data-index={index}
                        style="background: #ff4444; color: white; border: none; padding: 0.25rem 0.5rem; border-radius: 3px; cursor: pointer; font-size: 0.8rem;"
                      >
                        Remove
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      ),
    };
  },
);
