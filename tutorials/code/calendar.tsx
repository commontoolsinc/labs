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
  dates: Default<
    string[],
    [
      "2025-10-01",
      "2025-10-05",
      "2025-10-08",
      "2025-10-12",
      "2025-10-15",
      "2025-10-18",
      "2025-10-22",
      "2025-10-25",
      "2025-10-28",
      "2025-10-31",
    ]
  >;
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

export default recipe<CalendarState>("calendar", ({ dates, clickedDate }) => {
  // Note: We use cell() instead of Default<> for the todos map because
  // Default<> doesn't work reliably with Record/map types
  const todos = cell<Record<string, string[]>>({
    "2025-10-05": [
      "2025-10-05: water plants",
      "2025-10-05: buy groceries",
    ],
    "2025-10-15": [
      "2025-10-15: team meeting",
      "2025-10-15: finish report",
    ],
    "2025-10-25": [
      "2025-10-25: make breakfast",
      "2025-10-25: call dentist",
    ],
  });

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
