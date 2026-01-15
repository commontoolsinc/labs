/// <cts-enable />
import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commontools";

export interface Habit {
  name: string;
  icon: Default<string, "✓">;
  color: Default<string, "#3b82f6">;
}

interface HabitLog {
  habitName: string;
  date: string; // YYYY-MM-DD
  completed: boolean;
}

// Pre-computed habit data for rendering (avoids closure issues in .map())
interface HabitDisplayData {
  habit: Habit;
  isCompletedToday: boolean;
  streak: number;
  last7Days: { date: string; dayLabel: string; completed: boolean }[];
}

interface Input {
  habits: Writable<Default<Habit[], []>>;
  logs: Writable<Default<HabitLog[], []>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  habits: Habit[];
  logs: HabitLog[];
  todayDate: string;
  toggleHabit: Stream<{ habitName: string }>;
  addHabit: Stream<{ name: string; icon: string }>;
  deleteHabit: Stream<{ habit: Habit }>;
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

// Pure helper functions (not lifted - used inside computed())
const checkCompletedPure = (
  logs: readonly HabitLog[],
  name: string,
  date: string,
): boolean => {
  if (!Array.isArray(logs)) return false;
  return logs.some(
    (log) => log.habitName === name && log.date === date && log.completed,
  );
};

const calcStreakPure = (logs: readonly HabitLog[], name: string): number => {
  if (!Array.isArray(logs)) return 0;

  let streak = 0;

  for (let i = 0; i < 365; i++) {
    const dateToCheck = getDateDaysAgo(i);
    const completed = logs.some(
      (log) =>
        log.habitName === name && log.date === dateToCheck && log.completed,
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
};

// ===== Handlers at module scope =====
// First type param is the args (Stream type), second is the bound context

const toggleHabit = handler<
  { habitName: string },
  { logs: Writable<HabitLog[]>; todayDate: string }
>(({ habitName }, { logs, todayDate }) => {
  const currentLogs = logs.get();
  const existingIdx = currentLogs.findIndex(
    (log) => log.habitName === habitName && log.date === todayDate,
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
});

const deleteHabit = handler<
  { habit: Habit },
  { habits: Writable<Habit[]> }
>(({ habit }, { habits }) => {
  const current = habits.get();
  // Find by name since full object equality may fail due to metadata differences
  const idx = current.findIndex((h) => h.name === habit.name);
  if (idx >= 0) {
    habits.set(current.toSpliced(idx, 1));
  }
});

const addHabit = handler<
  { name: string; icon: string },
  { habits: Writable<Habit[]>; newHabitName: Writable<string> }
>(({ name, icon }, { habits, newHabitName }) => {
  const trimmedName = name.trim();
  if (trimmedName) {
    habits.push({
      name: trimmedName,
      icon: icon || "✓",
      color: "#3b82f6",
    });
    newHabitName.set("");
  }
});

export default pattern<Input, Output>(({ habits, logs }) => {
  const todayDate = getTodayDate();
  const newHabitName = Writable.of("");
  const newHabitIcon = Writable.of("✓");

  const habitCount = computed(() => habits.get().length);
  const hasNoHabits = computed(() => habits.get().length === 0);

  // Bind handlers at pattern level (before JSX) to avoid closure issues in .map()
  const boundToggleHabit = toggleHabit({ logs, todayDate });
  const boundDeleteHabit = deleteHabit({ habits });
  const boundAddHabit = addHabit({ habits, newHabitName });

  // WORKAROUND: Pre-compute habit display data outside the map callback
  // This avoids the "Cannot create cell link - space required" error
  // that occurs when closing over cells inside .map() callbacks
  const habitDisplayData = computed((): HabitDisplayData[] => {
    const habitList = habits.get();
    const logList = logs.get();

    return habitList.map((habit) => ({
      habit,
      isCompletedToday: checkCompletedPure(logList, habit.name, todayDate),
      streak: calcStreakPure(logList, habit.name),
      last7Days: [6, 5, 4, 3, 2, 1, 0].map((daysAgo) => {
        const date = getDateDaysAgo(daysAgo);
        return {
          date,
          dayLabel: date.slice(-2),
          completed: checkCompletedPure(logList, habit.name, date),
        };
      }),
    }));
  });

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
            {habitDisplayData.map((data) => (
              <ct-card>
                <ct-hstack gap="2" align="center">
                  <span style="font-size: 1.5rem;">{data.habit.icon}</span>
                  <ct-vstack gap="0" style="flex: 1;">
                    <span style="font-weight: 500;">
                      {data.habit.name || "(unnamed)"}
                    </span>
                    <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                      Streak: {data.streak} days
                    </span>
                  </ct-vstack>
                  <ct-button
                    variant={data.isCompletedToday ? "primary" : "secondary"}
                    onClick={() =>
                      boundToggleHabit.send({ habitName: data.habit.name })}
                  >
                    {data.isCompletedToday ? "✓" : "○"}
                  </ct-button>
                  <ct-button
                    variant="ghost"
                    onClick={() => boundDeleteHabit.send({ habit: data.habit })}
                  >
                    ×
                  </ct-button>
                </ct-hstack>

                {/* Last 7 days indicator */}
                <ct-hstack gap="1" style="margin-top: 0.5rem;">
                  {data.last7Days.map((day) => (
                    <div
                      style={{
                        width: "24px",
                        height: "24px",
                        borderRadius: "4px",
                        backgroundColor: day.completed
                          ? data.habit.color
                          : "var(--ct-color-gray-200)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "0.625rem",
                        color: day.completed
                          ? "white"
                          : "var(--ct-color-gray-400)",
                      }}
                    >
                      {day.dayLabel}
                    </div>
                  ))}
                </ct-hstack>
              </ct-card>
            ))}

            {hasNoHabits
              ? (
                <div style="text-align: center; color: var(--ct-color-gray-500); padding: 2rem;">
                  No habits yet. Add one below!
                </div>
              )
              : null}
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
            onClick={() =>
              boundAddHabit.send({
                name: newHabitName.get(),
                icon: newHabitIcon.get(),
              })}
          >
            Add Habit
          </ct-button>
        </ct-hstack>
      </ct-screen>
    ),
    habits,
    logs,
    todayDate,
    toggleHabit: boundToggleHabit,
    addHabit: boundAddHabit,
    deleteHabit: boundDeleteHabit,
  };
});
