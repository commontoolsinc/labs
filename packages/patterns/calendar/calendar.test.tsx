/// <cts-enable />
/**
 * Test Pattern: Calendar
 *
 * Comprehensive tests for the calendar pattern:
 * - Initial state (empty event list)
 * - Adding events via action
 * - Verifying event fields (title, date, time)
 * - Adding multiple events, verify count
 * - Empty/whitespace title rejection
 * - Update notes via piece action
 * - Removing events
 *
 * Run: deno task ct test packages/patterns/calendar/calendar.test.tsx --verbose
 */
import { action, computed, pattern } from "commontools";
import Calendar from "./calendar.tsx";

export default pattern(() => {
  const cal = Calendar({});

  // ==========================================================================
  // Actions - Adding Events
  // ==========================================================================

  const action_add_event = action(() => {
    cal.addEvent.send({
      title: "Team Meeting",
      date: "2025-03-15",
      time: "10:00",
    });
  });

  const action_add_second = action(() => {
    cal.addEvent.send({
      title: "Lunch",
      date: "2025-03-15",
      time: "12:00",
    });
  });

  const action_add_earlier_date = action(() => {
    cal.addEvent.send({
      title: "Kickoff",
      date: "2025-03-10",
      time: "09:00",
    });
  });

  // Empty title should be rejected
  const action_add_empty = action(() => {
    cal.addEvent.send({ title: "", date: "2025-03-15", time: "" });
  });

  const action_add_whitespace = action(() => {
    cal.addEvent.send({ title: "   ", date: "2025-03-15", time: "" });
  });

  // ==========================================================================
  // Actions - Modifying Event via Piece Action
  // ==========================================================================

  const action_update_notes = action(() => {
    const evts = cal.events;
    if (evts && evts[0]) {
      evts[0].setNotes.send({ notes: "Discuss Q2 roadmap" });
    }
  });

  // ==========================================================================
  // Actions - Removing Events
  // ==========================================================================

  const action_remove_first = action(() => {
    const evts = cal.events;
    if (evts && evts[0]) {
      cal.removeEvent.send({ event: evts[0] });
    }
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  const assert_initial_empty = computed(() => cal.events.length === 0);

  // ==========================================================================
  // Assertions - After Adding
  // ==========================================================================

  const assert_has_one = computed(() => cal.events.length === 1);
  const assert_first_title = computed(
    () => cal.events[0]?.title === "Team Meeting",
  );
  const assert_first_date = computed(
    () => cal.events[0]?.date === "2025-03-15",
  );
  const assert_first_time = computed(
    () => cal.events[0]?.time === "10:00",
  );

  const assert_has_two = computed(() => cal.events.length === 2);
  const assert_has_three = computed(() => cal.events.length === 3);

  // Still three after empty/whitespace attempts
  const assert_still_three = computed(() => cal.events.length === 3);

  // ==========================================================================
  // Assertions - Sorting
  // ==========================================================================

  // Events added: Team Meeting (03-15 10:00), Lunch (03-15 12:00), Kickoff (03-10 09:00)
  // Sorted order should be: Kickoff (03-10), Team Meeting (03-15 10:00), Lunch (03-15 12:00)
  const assert_sorted_first_is_kickoff = computed(
    () => cal.sortedEvents[0]?.title === "Kickoff",
  );
  const assert_sorted_second_is_meeting = computed(
    () => cal.sortedEvents[1]?.title === "Team Meeting",
  );
  const assert_sorted_third_is_lunch = computed(
    () => cal.sortedEvents[2]?.title === "Lunch",
  );

  // ==========================================================================
  // Assertions - After Notes Update
  // ==========================================================================

  const assert_notes_updated = computed(
    () => cal.events[0]?.notes === "Discuss Q2 roadmap",
  );

  // ==========================================================================
  // Assertions - After Removing
  // ==========================================================================

  const assert_has_two_after_remove = computed(() => cal.events.length === 2);
  const assert_has_one_after_remove = computed(() => cal.events.length === 1);
  const assert_back_to_empty = computed(() => cal.events.length === 0);

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // === Initial state ===
      { assertion: assert_initial_empty },

      // === Add events ===
      { action: action_add_event },
      { assertion: assert_has_one },
      { assertion: assert_first_title },
      { assertion: assert_first_date },
      { assertion: assert_first_time },

      { action: action_add_second },
      { assertion: assert_has_two },

      { action: action_add_earlier_date },
      { assertion: assert_has_three },

      // === Sorting: earliest date first, then by time ===
      { assertion: assert_sorted_first_is_kickoff },
      { assertion: assert_sorted_second_is_meeting },
      { assertion: assert_sorted_third_is_lunch },

      // === Empty/whitespace rejected ===
      { action: action_add_empty },
      { assertion: assert_still_three },
      { action: action_add_whitespace },
      { assertion: assert_still_three },

      // === Update notes via piece action ===
      { action: action_update_notes },
      { assertion: assert_notes_updated },

      // === Remove events ===
      { action: action_remove_first },
      { assertion: assert_has_two_after_remove },
      { action: action_remove_first },
      { assertion: assert_has_one_after_remove },
      { action: action_remove_first },
      { assertion: assert_back_to_empty },
    ],
    cal,
  };
});
