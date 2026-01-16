/// <cts-enable />
/**
 * Habit Tracker Pattern Tests
 *
 * Tests core functionality:
 * - Initial state
 * - Adding habits (with validation)
 * - Toggling habit completion
 * - Deleting habits
 * - Default values
 *
 * Run: deno task ct test packages/patterns/habit-tracker/habit-tracker.test.tsx --verbose
 *
 * NOTE: Uses .filter(() => true).length instead of .length directly due to
 * a reactivity tracking bug where direct .length access doesn't register
 * dependencies. See packages/patterns/gideon-tests/array-length-repro.test.tsx
 */
import { action, computed, pattern } from "commontools";
import HabitTracker from "./habit-tracker.tsx";
import type { Habit, HabitLog } from "./schemas.tsx";

// Helper to get array length with proper reactivity tracking
const len = <T,>(arr: T[]): number => arr.filter(() => true).length;

export default pattern(() => {
  const subject = HabitTracker({ habits: [], logs: [] });

  // === Actions ===

  const action_add_exercise = action(() => {
    subject.addHabit.send({ name: "Exercise", icon: "🏃" });
  });

  const action_add_read = action(() => {
    subject.addHabit.send({ name: "Read", icon: "📚" });
  });

  const action_add_empty_name = action(() => {
    subject.addHabit.send({ name: "   ", icon: "❌" });
  });

  const action_add_with_default_icon = action(() => {
    subject.addHabit.send({ name: "Meditate", icon: "" });
  });

  const action_toggle_exercise = action(() => {
    subject.toggleHabit.send({ habitName: "Exercise" });
  });

  const action_toggle_nonexistent = action(() => {
    subject.toggleHabit.send({ habitName: "NonExistent" });
  });

  const action_delete_read = action(() => {
    subject.deleteHabit.send({
      habit: { name: "Read", icon: "📚", color: "#3b82f6" },
    });
  });

  const action_delete_nonexistent = action(() => {
    subject.deleteHabit.send({
      habit: { name: "NonExistent", icon: "?", color: "#000" },
    });
  });

  // === Assertions ===

  // Initial state
  const assert_initial_no_habits = computed(
    () => len(subject.habits) === 0,
  );

  const assert_initial_no_logs = computed(
    () => len(subject.logs) === 0,
  );

  const assert_today_date_format = computed(() => {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    return dateRegex.test(subject.todayDate);
  });

  // After adding first habit
  const assert_one_habit = computed(
    () => len(subject.habits) === 1,
  );

  const assert_exercise_name = computed(
    () => subject.habits[0]?.name === "Exercise",
  );

  const assert_exercise_icon = computed(
    () => subject.habits[0]?.icon === "🏃",
  );

  const assert_exercise_default_color = computed(
    () => subject.habits[0]?.color === "#3b82f6",
  );

  // Empty name should not add habit
  const assert_still_one_habit_after_empty = computed(
    () => len(subject.habits) === 1,
  );

  // Default icon when empty string provided
  const assert_two_habits = computed(
    () => len(subject.habits) === 2,
  );

  const assert_meditate_default_icon = computed(() => {
    const meditate = subject.habits.find((h: Habit) => h.name === "Meditate");
    return meditate?.icon === "✓";
  });

  // After toggling habit (creates log)
  const assert_one_log = computed(
    () => len(subject.logs) === 1,
  );

  const assert_log_completed = computed(() => {
    const log = subject.logs.find((l: HabitLog) => l.habitName === "Exercise");
    return log?.completed === true;
  });

  const assert_log_habitName = computed(
    () => subject.logs[0]?.habitName === "Exercise",
  );

  const assert_log_date_is_today = computed(
    () => subject.logs[0]?.date === subject.todayDate,
  );

  // Toggling nonexistent habit should not create log
  const assert_still_one_log_after_nonexistent = computed(
    () => len(subject.logs) === 1,
  );

  // After toggling again (uncompletes)
  const assert_log_uncompleted = computed(() => {
    const log = subject.logs.find((l: HabitLog) => l.habitName === "Exercise");
    return log?.completed === false;
  });

  const assert_still_one_log_after_toggle = computed(
    () => len(subject.logs) === 1,
  );

  // After adding second habit
  const assert_three_habits = computed(
    () => len(subject.habits) === 3,
  );

  const assert_read_exists = computed(
    () => subject.habits.some((h: Habit) => h.name === "Read"),
  );

  // After deleting habit
  const assert_two_habits_after_delete = computed(
    () => len(subject.habits) === 2,
  );

  const assert_read_deleted = computed(
    () => !subject.habits.some((h: Habit) => h.name === "Read"),
  );

  const assert_exercise_remains = computed(
    () => subject.habits.some((h: Habit) => h.name === "Exercise"),
  );

  // Deleting nonexistent should not change count
  const assert_still_two_habits = computed(
    () => len(subject.habits) === 2,
  );

  return {
    tests: [
      // Initial state
      { assertion: assert_initial_no_habits },
      { assertion: assert_initial_no_logs },
      { assertion: assert_today_date_format },

      // Add first habit
      { action: action_add_exercise },
      { assertion: assert_one_habit },
      { assertion: assert_exercise_name },
      { assertion: assert_exercise_icon },
      { assertion: assert_exercise_default_color },

      // Empty name rejected
      { action: action_add_empty_name },
      { assertion: assert_still_one_habit_after_empty },

      // Default icon applied
      { action: action_add_with_default_icon },
      { assertion: assert_two_habits },
      { assertion: assert_meditate_default_icon },

      // Toggle creates log
      { action: action_toggle_exercise },
      { assertion: assert_one_log },
      { assertion: assert_log_completed },
      { assertion: assert_log_habitName },
      { assertion: assert_log_date_is_today },

      // Toggle nonexistent habit
      { action: action_toggle_nonexistent },
      { assertion: assert_still_one_log_after_nonexistent },

      // Toggle again uncompletes
      { action: action_toggle_exercise },
      { assertion: assert_still_one_log_after_toggle },
      { assertion: assert_log_uncompleted },

      // Add and delete habit
      { action: action_add_read },
      { assertion: assert_three_habits },
      { assertion: assert_read_exists },
      { action: action_delete_read },
      { assertion: assert_two_habits_after_delete },
      { assertion: assert_read_deleted },
      { assertion: assert_exercise_remains },

      // Delete nonexistent habit
      { action: action_delete_nonexistent },
      { assertion: assert_still_two_habits },
    ],
    subject,
  };
});
