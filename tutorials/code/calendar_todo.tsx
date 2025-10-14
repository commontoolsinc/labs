/// <cts-enable />
import {
  Default,
  lift,
  recipe,
  UI,
} from "commontools";

interface CalendarTodoState {
  todos: Default<Record<string, string[]>, {}>;
  date: Default<string, "">;
}

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
          {date && todosForDate.length > 0 && (
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
      ),
    };
  },
);
