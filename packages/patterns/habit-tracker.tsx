/// <cts-enable />
import {
  Cell,
  computed,
  Default,
  ifElse,
  lift,
  NAME,
  pattern,
  UI,
} from "commontools";

interface Habit {
  name: string;
  icon: Default<string, "✓">;
  color: Default<string, "#3b82f6">;
}

interface HabitLog {
  habitName: string;
  date: string;  // YYYY-MM-DD
  completed: boolean;
}

interface Input {
  habits: Cell<Default<Habit[], []>>;
  logs: Cell<Default<HabitLog[], []>>;
}

interface Output {
  habits: Habit[];
  logs: HabitLog[];
  todayDate: string;
}

// Get today's date as YYYY-MM-DD
const getTodayDate = (): string => {
  const now = new Date();
  return now.toISOString().split("T")[0];
};

// Get date N days ago as YYYY-MM-DD
const getDateDaysAgo = (daysAgo: number): string => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().split("T")[0];
};

// Pure functions wrapped with lift() - use object arg for multiple params
const checkCompleted = lift((args: { logs: HabitLog[]; name: string; date: string }): boolean => {
  const { logs, name, date } = args;
  if (!Array.isArray(logs)) return false;
  return logs.some(
    (log) => log.habitName === name && log.date === date && log.completed
  );
});

const calcStreak = lift((args: { logs: HabitLog[]; name: string }): number => {
  const { logs, name } = args;
  if (!Array.isArray(logs)) return 0;

  let streak = 0;

  for (let i = 0; i < 365; i++) {
    const dateToCheck = getDateDaysAgo(i);
    const completed = logs.some(
      (log) => log.habitName === name && log.date === dateToCheck && log.completed
    );

    if (completed) {
      streak++;
    } else if (i === 0) {
      // Today not completed is ok, continue checking
      continue;
    } else {
      // Gap found, stop
      break;
    }
  }

  return streak;
});

export default pattern<Input, Output>(({ habits, logs }) => {
  const todayDate = getTodayDate();
  const newHabitName = Cell.of("");
  const newHabitIcon = Cell.of("✓");

  const habitCount = computed(() => habits.get().length);

  return {
    [NAME]: "Habit Tracker",
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header" gap="2">
          <ct-hstack justify="between" align="center">
            <ct-heading level={4}>Habits ({habitCount})</ct-heading>
            <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
              {todayDate}
            </span>
          </ct-hstack>
        </ct-vstack>

        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="2" style="padding: 1rem;">
            {habits.map((habit) => {
              // Use lift() - just call with reactive args in an object
              const isCompletedToday = checkCompleted({ logs, name: habit.name, date: todayDate });
              const streak = calcStreak({ logs, name: habit.name });

              return (
                <ct-card>
                  <ct-hstack gap="2" align="center">
                    <span style="font-size: 1.5rem;">{habit.icon}</span>
                    <ct-vstack gap="0" style="flex: 1;">
                      <span style="font-weight: 500;">{habit.name || "(unnamed)"}</span>
                      <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                        Streak: {streak} days
                      </span>
                    </ct-vstack>
                    <ct-button
                      variant={ifElse(isCompletedToday, "primary", "secondary")}
                      onClick={() => {
                        const habitName = habit.name;
                        const currentLogs = logs.get();
                        const existingIdx = currentLogs.findIndex(
                          (log) => log.habitName === habitName && log.date === todayDate
                        );

                        if (existingIdx >= 0) {
                          // Toggle existing
                          const updated = currentLogs.map((log, i) =>
                            i === existingIdx ? { ...log, completed: !log.completed } : log
                          );
                          logs.set(updated);
                        } else {
                          // Create new
                          logs.push({
                            habitName,
                            date: todayDate,
                            completed: true,
                          });
                        }
                      }}
                    >
                      {ifElse(isCompletedToday, "✓", "○")}
                    </ct-button>
                    <ct-button
                      variant="ghost"
                      onClick={() => {
                        const current = habits.get();
                        const idx = current.findIndex((h) => Cell.equals(habit, h));
                        if (idx >= 0) {
                          habits.set(current.toSpliced(idx, 1));
                        }
                      }}
                    >
                      ×
                    </ct-button>
                  </ct-hstack>

                  {/* Last 7 days indicator */}
                  <ct-hstack gap="1" style="margin-top: 0.5rem;">
                    {[6, 5, 4, 3, 2, 1, 0].map((daysAgo) => {
                      const dateStr = getDateDaysAgo(daysAgo);
                      const wasCompleted = checkCompleted({ logs, name: habit.name, date: dateStr });

                      return (
                        <div
                          style={{
                            width: "24px",
                            height: "24px",
                            borderRadius: "4px",
                            backgroundColor: ifElse(wasCompleted, habit.color, "var(--ct-color-gray-200)"),
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "0.625rem",
                            color: ifElse(wasCompleted, "white", "var(--ct-color-gray-400)"),
                          }}
                        >
                          {dateStr.slice(-2)}
                        </div>
                      );
                    })}
                  </ct-hstack>
                </ct-card>
              );
            })}

            {ifElse(
              computed(() => habits.get().length === 0),
              <div style="text-align: center; color: var(--ct-color-gray-500); padding: 2rem;">
                No habits yet. Add one below!
              </div>,
              null
            )}
          </ct-vstack>
        </ct-vscroll>

        <ct-hstack slot="footer" gap="2" style="padding: 1rem;" align="end">
          <ct-input
            $value={newHabitIcon}
            placeholder="Icon"
            style="width: 60px;"
          />
          <ct-input
            $value={newHabitName}
            placeholder="New habit name..."
            style="flex: 1;"
          />
          <ct-button
            variant="primary"
            onClick={() => {
              const name = newHabitName.get().trim();
              if (name) {
                habits.push({
                  name,
                  icon: newHabitIcon.get() || "✓",
                  color: "#3b82f6",
                });
                newHabitName.set("");
              }
            }}
          >
            Add Habit
          </ct-button>
        </ct-hstack>
      </ct-screen>
    ),
    habits,
    logs,
    todayDate,
  };
});
