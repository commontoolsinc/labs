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
  { todos: Cell<Record<string, string[]>>; date: Cell<string> }
>(
  (event, { todos, date }) => {
    const message = event.detail.message?.trim();
    const dateValue = date.get();
    if (!message || !dateValue) return;

    const currentTodos = todos.get() || {};
    const dateTodos = currentTodos[dateValue] || [];
    const newTodos = [...dateTodos, message];

    // Manually reconstruct the Record to avoid spread operator proxy issue
    const updatedTodos: Record<string, string[]> = {};
    for (const key of Object.keys(currentTodos)) {
      updatedTodos[key] = key === dateValue ? newTodos : currentTodos[key];
    }
    // Add the date if it didn't exist
    if (!currentTodos[dateValue]) {
      updatedTodos[dateValue] = newTodos;
    }

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
        <div>
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
                    <li key={index}>{todo}</li>
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
