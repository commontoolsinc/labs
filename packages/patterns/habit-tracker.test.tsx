/// <cts-enable />
/**
 * Test Pattern: Habit Tracker
 *
 * Tests the core functionality of the habit-tracker pattern:
 * - Initial state (no habits, no logs)
 * - Adding habits
 * - Toggling habit completion (creates log)
 * - Toggling habit again (uncompletes)
 * - Deleting habits
 *
 * Run: deno task ct test packages/patterns/habit-tracker.test.tsx --verbose
 */
import { action, computed, pattern } from "commontools";
import HabitTracker, { type Habit } from "./habit-tracker.tsx";

// Module-level type for habit log
interface HabitLog {
  habitName: string;
  date: string;
  completed: boolean;
}

export default pattern(() => {
  // Instantiate the habit tracker pattern with empty initial state
  // Pass plain values - runtime creates writable cells automatically
  const subject = HabitTracker({ habits: [], logs: [] });

  // ==========================================================================
  // Actions - using action() to trigger stream sends
  // ==========================================================================

  // Add a habit
  const action_add_habit = action(() => {
    subject.addHabit.send({ name: "Exercise", icon: "🏃" });
  });

  // Add a second habit for deletion test
  const action_add_second_habit = action(() => {
    subject.addHabit.send({ name: "Read", icon: "📚" });
  });

  // Toggle habit completion (marks as complete)
  const action_toggle_habit_complete = action(() => {
    subject.toggleHabit.send({ habitName: "Exercise" });
  });

  // Toggle habit again (should uncomplete)
  const action_toggle_habit_uncomplete = action(() => {
    subject.toggleHabit.send({ habitName: "Exercise" });
  });

  // Delete the second habit by name
  const action_delete_habit = action(() => {
    subject.deleteHabit.send({
      habit: { name: "Read", icon: "📚", color: "#3b82f6" },
    });
  });

  // ==========================================================================
  // Assertions - computed booleans
  // ==========================================================================

  // Test 1: Initial state - no habits
  // Note: Using filter().length for proper reactivity tracking
  const assert_initial_no_habits = computed(() => {
    return subject.habits.filter(() => true).length === 0;
  });

  // Test 1: Initial state - no logs
  const assert_initial_no_logs = computed(() => {
    return subject.logs.filter(() => true).length === 0;
  });

  // Test 2: After adding first habit
  // Note: Using filter().length instead of direct .length for better reactivity
  const assert_has_one_habit = computed(() => {
    const habits = subject.habits.filter(() => true);
    return habits.length === 1;
  });

  const assert_habit_name_correct = computed(
    () => subject.habits[0]?.name === "Exercise",
  );

  const assert_habit_icon_correct = computed(
    () => subject.habits[0]?.icon === "🏃",
  );

  // Test 3: After toggling habit (completion creates log)
  const assert_log_created = computed(() => {
    return subject.logs.filter(() => true).length === 1;
  });

  const assert_log_completed_true = computed(() => {
    const log = subject.logs.find(
      (l: HabitLog) => l.habitName === "Exercise",
    );
    return log?.completed === true;
  });

  const assert_log_habitName_correct = computed(() => {
    const log = subject.logs[0];
    return log?.habitName === "Exercise";
  });

  const assert_log_date_is_today = computed(() => {
    const log = subject.logs[0];
    return log?.date === subject.todayDate;
  });

  // Test 4: After toggling again (should uncomplete - toggle existing log)
  const assert_log_completed_false = computed(() => {
    const log = subject.logs.find(
      (l: HabitLog) => l.habitName === "Exercise",
    );
    return log?.completed === false;
  });

  // Still only one log (toggling updates existing, doesn't create new)
  const assert_still_one_log = computed(() => {
    return subject.logs.filter(() => true).length === 1;
  });

  // Test 5: After adding second habit
  const assert_has_two_habits = computed(() => {
    return subject.habits.filter(() => true).length === 2;
  });

  const assert_second_habit_exists = computed(() => {
    return subject.habits.some((h: Habit) => h.name === "Read");
  });

  // Test 5: After deleting second habit
  const assert_back_to_one_habit = computed(() => {
    return subject.habits.filter(() => true).length === 1;
  });

  const assert_read_habit_deleted = computed(() => {
    return !subject.habits.some((h: Habit) => h.name === "Read");
  });

  const assert_exercise_habit_remains = computed(() => {
    return subject.habits.some((h: Habit) => h.name === "Exercise");
  });

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // === Test 1: Initial state - no habits, no logs ===
      { assertion: assert_initial_no_habits },
      { assertion: assert_initial_no_logs },

      // === Test 2: Add habit - verify habit count increases ===
      { action: action_add_habit },
      { assertion: assert_has_one_habit },
      { assertion: assert_habit_name_correct },
      { assertion: assert_habit_icon_correct },

      // === Test 3: Toggle habit completion - verify log is created ===
      { action: action_toggle_habit_complete },
      { assertion: assert_log_created },
      { assertion: assert_log_completed_true },
      { assertion: assert_log_habitName_correct },
      { assertion: assert_log_date_is_today },

      // === Test 4: Toggle habit uncomplete - verify completion toggles off ===
      { action: action_toggle_habit_uncomplete },
      { assertion: assert_still_one_log },
      { assertion: assert_log_completed_false },

      // === Test 5: Delete habit - verify habit count decreases ===
      { action: action_add_second_habit },
      { assertion: assert_has_two_habits },
      { assertion: assert_second_habit_exists },
      { action: action_delete_habit },
      { assertion: assert_back_to_one_habit },
      { assertion: assert_read_habit_deleted },
      { assertion: assert_exercise_habit_remains },
    ],
    // Expose subject for debugging
    subject,
  };
});
