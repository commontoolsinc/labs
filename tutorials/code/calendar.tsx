/// <cts-enable />
import {
  type Cell,
  cell,
  Default,
  handler,
  ifElse,
  lift,
  recipe,
  UI,
} from "commontools";
import CalendarTodo from "./calendar_todo.tsx";

interface CalendarState {
  dates: Default< string[], [ ] >;
  clickedDate: Default<string, "">;
}

const clickDate = handler<
  unknown,
  { clickedDate: Cell<string>; date: string }
>(
  (_, { clickedDate, date }) => {
    clickedDate.set(date);
  },
);

const addRandomDate = handler<
  unknown,
  { dates: Cell<string[]> }
>(
  (_, { dates }) => {
    // Generate a random date in 2025
    const year = 2025;
    const month = Math.floor(Math.random() * 12) + 1;
    const day = Math.floor(Math.random() * 28) + 1; // Use 28 to avoid month length issues
    const randomDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    dates.push(randomDate);
  },
);

export default recipe<CalendarState>("calendar", ({ dates, clickedDate }) => {
  // Note: We use cell() instead of Default<> for the todos map because
  // Default<> doesn't work reliably with Record/map types
  const todos = cell<Record<string, string[]>>({ });

  // Create lifted function to get todos for a given date
  const getTodosForDate = lift(
    ({ todos, date }: { todos: Record<string, string[]>; date: string }) =>
      todos[date] || [],
  );

  // Get todos for the clicked date using the same lifted function
  const clickedDateTodos = getTodosForDate({ todos, date: clickedDate });

  // Create the CalendarTodo subrecipe with todos and date
  const todoView = CalendarTodo({
    todos,
    date: clickedDate,
  });

  return {
    [UI]: (
      <div>
        <h2>Selected Date View</h2>
        {todoView}
        <h2>The Calendar View</h2>
        <ct-button onclick={addRandomDate({ dates })}>
          Add Random Date
        </ct-button>
        {dates.map((date) => {
          const dateTodos = getTodosForDate({ todos, date });
          return (
            <div style="margin-bottom: 1rem;">
              <h3 onclick={clickDate({ clickedDate, date })}>{date}</h3>
              {dateTodos.length > 0
                ? (
                  <ul>
                    {/* Note: key is not needed for Common Tools but linters require it */}
                    {dateTodos.map((todo, index) => (
                      <li key={index}>{todo}</li>
                    ))}
                  </ul>
                )
                : <p style="color: #999; font-style: italic;">No todos</p>}
            </div>
          );
        })}
      </div>
    ),
  };
});
