/// <cts-enable />
/**
 * Test Pattern: Event Detail
 *
 * Tests for the event-detail pattern in isolation:
 * - Initial state with provided values
 * - Edit title/date/time/notes via stream actions, verify updates
 *
 * Run: deno task ct test packages/patterns/calendar/event-detail.test.tsx --verbose
 */
import { action, computed, pattern } from "commontools";
import EventDetail from "./event-detail.tsx";

export default pattern(() => {
  const item = EventDetail({
    event: {
      title: "Team Meeting",
      date: "2025-03-15",
      time: "10:00",
      notes: "Weekly sync",
    },
  });

  // ==========================================================================
  // Actions
  // ==========================================================================

  const action_change_title = action(() => {
    item.setTitle.send({ title: "Renamed Meeting" });
  });

  const action_change_date = action(() => {
    item.setDate.send({ date: "2025-04-01" });
  });

  const action_change_time = action(() => {
    item.setTime.send({ time: "14:30" });
  });

  const action_change_notes = action(() => {
    item.setNotes.send({ notes: "Updated agenda items" });
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  const assert_initial_title = computed(
    () => item.event.title === "Team Meeting",
  );
  const assert_initial_date = computed(
    () => item.event.date === "2025-03-15",
  );
  const assert_initial_time = computed(() => item.event.time === "10:00");
  const assert_initial_notes = computed(
    () => item.event.notes === "Weekly sync",
  );

  // ==========================================================================
  // Assertions - After Edits
  // ==========================================================================

  const assert_title_changed = computed(
    () => item.event.title === "Renamed Meeting",
  );
  const assert_date_changed = computed(
    () => item.event.date === "2025-04-01",
  );
  const assert_time_changed = computed(() => item.event.time === "14:30");
  const assert_notes_changed = computed(
    () => item.event.notes === "Updated agenda items",
  );

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // === Initial state ===
      { assertion: assert_initial_title },
      { assertion: assert_initial_date },
      { assertion: assert_initial_time },
      { assertion: assert_initial_notes },

      // === Edit fields ===
      { action: action_change_title },
      { assertion: assert_title_changed },

      { action: action_change_date },
      { assertion: assert_date_changed },

      { action: action_change_time },
      { assertion: assert_time_changed },

      { action: action_change_notes },
      { assertion: assert_notes_changed },
    ],
    item,
  };
});
