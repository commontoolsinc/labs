/// <cts-enable />
/**
 * Test Pattern: Reading Item Detail
 *
 * Tests for the reading-item-detail pattern in isolation:
 * - Initial state with defaults
 * - Setting status via action
 * - Setting rating via action
 * - Setting notes via action
 * - Status transitions (want -> reading -> finished)
 * - Clearing rating (set to null)
 *
 * Run: deno task ct test packages/patterns/reading-list/reading-item-detail.test.tsx --verbose
 */
import { action, computed, pattern } from "commontools";
import ReadingItemDetail from "./reading-item-detail.tsx";

export default pattern(() => {
  // Create a reading item with specific initial values
  const item = ReadingItemDetail({
    title: "Test Book",
    author: "Test Author",
    type: "book",
  });

  // ==========================================================================
  // Actions
  // ==========================================================================

  // Status transitions
  const action_set_reading = action(() => {
    item.setStatus.send({ status: "reading" });
  });

  const action_set_finished = action(() => {
    item.setStatus.send({ status: "finished" });
  });

  const action_set_abandoned = action(() => {
    item.setStatus.send({ status: "abandoned" });
  });

  const action_set_want = action(() => {
    item.setStatus.send({ status: "want" });
  });

  // Rating actions
  const action_rate_5 = action(() => {
    item.setRating.send({ rating: 5 });
  });

  const action_rate_3 = action(() => {
    item.setRating.send({ rating: 3 });
  });

  const action_clear_rating = action(() => {
    item.setRating.send({ rating: null });
  });

  // Notes actions
  const action_add_notes = action(() => {
    item.setNotes.send({ notes: "Great read, highly recommend!" });
  });

  const action_update_notes = action(() => {
    item.setNotes.send({ notes: "Updated: Even better on second read." });
  });

  const action_clear_notes = action(() => {
    item.setNotes.send({ notes: "" });
  });

  // ==========================================================================
  // Assertions - Initial State
  // ==========================================================================

  const assert_initial_title = computed(() => item.title === "Test Book");
  const assert_initial_author = computed(() => item.author === "Test Author");
  const assert_initial_type = computed(() => item.type === "book");
  const assert_initial_status = computed(() => item.status === "want");
  const assert_initial_rating = computed(() => item.rating === null);
  const assert_initial_notes = computed(() => item.notes === "");

  // ==========================================================================
  // Assertions - Status Changes
  // ==========================================================================

  const assert_status_reading = computed(() => item.status === "reading");
  const assert_status_finished = computed(() => item.status === "finished");
  const assert_status_abandoned = computed(() => item.status === "abandoned");
  const assert_status_want = computed(() => item.status === "want");

  // ==========================================================================
  // Assertions - Rating Changes
  // ==========================================================================

  const assert_rating_5 = computed(() => item.rating === 5);
  const assert_rating_3 = computed(() => item.rating === 3);
  const assert_rating_null = computed(() => item.rating === null);

  // ==========================================================================
  // Assertions - Notes Changes
  // ==========================================================================

  const assert_notes_added = computed(
    () => item.notes === "Great read, highly recommend!",
  );
  const assert_notes_updated = computed(
    () => item.notes === "Updated: Even better on second read.",
  );
  const assert_notes_cleared = computed(() => item.notes === "");

  // ==========================================================================
  // Test Sequence
  // ==========================================================================
  return {
    tests: [
      // === Initial state ===
      { assertion: assert_initial_title },
      { assertion: assert_initial_author },
      { assertion: assert_initial_type },
      { assertion: assert_initial_status },
      { assertion: assert_initial_rating },
      { assertion: assert_initial_notes },

      // === Status workflow: want -> reading -> finished ===
      { action: action_set_reading },
      { assertion: assert_status_reading },

      { action: action_set_finished },
      { assertion: assert_status_finished },

      // === Rating ===
      { action: action_rate_5 },
      { assertion: assert_rating_5 },

      { action: action_rate_3 },
      { assertion: assert_rating_3 },

      { action: action_clear_rating },
      { assertion: assert_rating_null },

      // === Notes ===
      { action: action_add_notes },
      { assertion: assert_notes_added },

      { action: action_update_notes },
      { assertion: assert_notes_updated },

      { action: action_clear_notes },
      { assertion: assert_notes_cleared },

      // === Status: can go back to want ===
      { action: action_set_want },
      { assertion: assert_status_want },

      // === Status: can go to abandoned ===
      { action: action_set_abandoned },
      { assertion: assert_status_abandoned },
    ],
    // Expose for debugging
    item,
  };
});
