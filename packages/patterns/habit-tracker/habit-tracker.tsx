/// <cts-enable />
import { action, computed, NAME, pattern, UI, Writable } from "commontools";
import type { Habit, Input, Output } from "./schemas.tsx";

// Re-export for consumers
export type { Habit, HabitLog } from "./schemas.tsx";

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

export default pattern<Input, Output>(({ habits, logs }) => {
  const todayDate = getTodayDate();
  const newHabitName = Writable.of("");
  const newHabitIcon = Writable.of("✓");

  const habitCount = computed(() => habits.get().length);
  const hasNoHabits = computed(() => habits.get().length === 0);

  // Actions close over pattern state directly
  const toggleHabit = action<{ habitName: string }>(({ habitName }) => {
    // Only toggle if habit exists
    const habitExists = habits.get().some((h) => h.name === habitName);
    if (!habitExists) return;

    const currentLogs = logs.get();
    const existingIdx = currentLogs.findIndex(
      (log) => log.habitName === habitName && log.date === todayDate,
    );
    if (existingIdx >= 0) {
      const updated = currentLogs.map((log, i) =>
        i === existingIdx ? { ...log, completed: !log.completed } : log
      );
      logs.set(updated);
    } else {
      logs.push({ habitName, date: todayDate, completed: true });
    }
  });

  const deleteHabit = action<{ habit: Habit }>(({ habit }) => {
    const current = habits.get();
    const idx = current.findIndex((h) => h.name === habit.name);
    if (idx >= 0) {
      habits.set(current.toSpliced(idx, 1));
    }
  });

  const addHabit = action<{ name: string; icon: string }>(({ name, icon }) => {
    const trimmedName = name.trim();
    if (trimmedName) {
      habits.push({ name: trimmedName, icon: icon || "✓", color: "#3b82f6" });
      newHabitName.set("");
    }
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
            {habits.map((habit) => {
              // Use computed() to derive values from closed-over cells
              const isCompletedToday = computed(() =>
                logs.get().some(
                  (log) =>
                    log.habitName === habit.name &&
                    log.date === todayDate &&
                    log.completed,
                )
              );

              const streak = computed(() => {
                const logList = logs.get();
                let count = 0;
                for (let i = 0; i < 365; i++) {
                  const dateToCheck = getDateDaysAgo(i);
                  const completed = logList.some(
                    (log) =>
                      log.habitName === habit.name &&
                      log.date === dateToCheck &&
                      log.completed,
                  );
                  if (completed) {
                    count++;
                  } else if (i === 0) {
                    continue; // Today not completed is ok
                  } else {
                    break; // Gap found
                  }
                }
                return count;
              });

              return (
                <ct-card>
                  <ct-hstack gap="2" align="center">
                    <span style="font-size: 1.5rem;">{habit.icon}</span>
                    <ct-vstack gap="0" style="flex: 1;">
                      <span style="font-weight: 500;">
                        {habit.name || "(unnamed)"}
                      </span>
                      <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                        Streak: {streak} days
                      </span>
                    </ct-vstack>
                    <ct-button
                      variant={isCompletedToday ? "primary" : "secondary"}
                      onClick={() =>
                        toggleHabit.send({ habitName: habit.name })}
                    >
                      {isCompletedToday ? "✓" : "○"}
                    </ct-button>
                    <ct-button
                      variant="ghost"
                      onClick={() => deleteHabit.send({ habit })}
                    >
                      ×
                    </ct-button>
                  </ct-hstack>

                  {/* Last 7 days indicator */}
                  <ct-hstack gap="1" style="margin-top: 0.5rem;">
                    {[6, 5, 4, 3, 2, 1, 0].map((daysAgo) => {
                      const date = getDateDaysAgo(daysAgo);
                      const dayCompleted = computed(() =>
                        logs.get().some(
                          (log) =>
                            log.habitName === habit.name &&
                            log.date === date &&
                            log.completed,
                        )
                      );

                      return (
                        <div
                          style={{
                            width: "24px",
                            height: "24px",
                            borderRadius: "4px",
                            backgroundColor: dayCompleted
                              ? habit.color
                              : "var(--ct-color-gray-200)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "0.625rem",
                            color: dayCompleted
                              ? "white"
                              : "var(--ct-color-gray-400)",
                          }}
                        >
                          {date.slice(-2)}
                        </div>
                      );
                    })}
                  </ct-hstack>
                </ct-card>
              );
            })}

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
              addHabit.send({
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
    toggleHabit,
    addHabit,
    deleteHabit,
  };
});
