/// <cts-enable />
/**
 * Parking Coordinator Pattern Tests
 *
 * Tests core functionality:
 * - Initial state
 * - User selection
 * - Adding spots and people (admin)
 * - Requesting a spot (auto-allocation)
 * - Default spot preference
 * - Spot preference ordering
 * - Denied request when full
 * - Cancelling an allocated request
 * - Duplicate request replaces previous
 * - Manual admin assignment
 * - Removing a spot (cancels future allocations)
 * - Removing a person (cancels future allocations, recomputes ranks)
 * - Priority reordering
 * - Editing spots and people
 *
 * Run: deno task ct test workspace/2026-03-02-parking-coordinator-k9m4/pattern/main.test.tsx --verbose
 *
 * NOTE: Uses .filter(() => true).length for array length due to
 * a reactivity tracking bug where direct .length doesn't register
 * dependencies.
 */
import { action, computed, pattern } from "commontools";
import ParkingCoordinator from "./main.tsx";
import type { Allocation, ParkingSpot, Person, SpotRequest } from "./main.tsx";

// Helper to get array length with proper reactivity tracking
const len = <T,>(arr: T[]): number => arr.filter(() => true).length;

// Get today's date as YYYY-MM-DD (must match pattern's internal date)
const getTodayDate = (): string => new Date().toISOString().split("T")[0];

export default pattern(() => {
  const today = getTodayDate();

  // Instantiate with empty data
  const subject = ParkingCoordinator({
    spots: [],
    people: [],
    requests: [],
    allocations: [],
  });

  // ============================================================
  // ACTIONS
  // ============================================================

  // --- Setup: Add spots ---
  const action_add_spot_1 = action(() => {
    subject.addSpot.send({
      spotNumber: "1",
      label: "Closest to door",
      notes: "",
    });
  });

  const action_add_spot_5 = action(() => {
    subject.addSpot.send({
      spotNumber: "5",
      label: "",
      notes: "Tight turning radius",
    });
  });

  const action_add_spot_12 = action(() => {
    subject.addSpot.send({ spotNumber: "12", label: "Back lot", notes: "" });
  });

  // --- Setup: Add people ---
  const action_add_alice = action(() => {
    subject.addPerson.send({
      name: "Alice",
      email: "alice@example.com",
      commuteMode: "drive",
      defaultSpot: "5",
    });
  });

  const action_add_bob = action(() => {
    subject.addPerson.send({
      name: "Bob",
      email: "bob@example.com",
      commuteMode: "transit",
      defaultSpot: "",
    });
  });

  const action_add_carol = action(() => {
    subject.addPerson.send({
      name: "Carol",
      email: "carol@example.com",
      commuteMode: "bike",
      defaultSpot: "1",
    });
  });

  const action_add_dave = action(() => {
    subject.addPerson.send({
      name: "Dave",
      email: "dave@example.com",
      commuteMode: "drive",
      defaultSpot: "",
    });
  });

  // --- User selection ---
  const action_select_alice = action(() => {
    subject.selectUser.send({ name: "Alice" });
  });

  const _action_select_bob = action(() => {
    subject.selectUser.send({ name: "Bob" });
  });

  const _action_select_carol = action(() => {
    subject.selectUser.send({ name: "Carol" });
  });

  const _action_select_dave = action(() => {
    subject.selectUser.send({ name: "Dave" });
  });

  // --- Spot requests ---
  const action_alice_request_today = action(() => {
    subject.requestSpot.send({ personName: "Alice", date: today });
  });

  const action_bob_request_today = action(() => {
    subject.requestSpot.send({ personName: "Bob", date: today });
  });

  const action_carol_request_today = action(() => {
    subject.requestSpot.send({ personName: "Carol", date: today });
  });

  const action_dave_request_today = action(() => {
    subject.requestSpot.send({ personName: "Dave", date: today });
  });

  // --- Cancel requests ---
  const action_alice_cancel_today = action(() => {
    subject.cancelRequest.send({ personName: "Alice", date: today });
  });

  const _action_bob_cancel_today = action(() => {
    subject.cancelRequest.send({ personName: "Bob", date: today });
  });

  // --- Admin actions ---
  const action_manual_assign_dave = action(() => {
    subject.manualAssign.send({
      spotNumber: "1",
      personName: "Dave",
      date: today,
    });
  });

  const action_admin_cancel_spot_1 = action(() => {
    subject.adminCancelAllocation.send({ spotNumber: "1", date: today });
  });

  const action_edit_spot_1 = action(() => {
    subject.editSpot.send({
      spotNumber: "1",
      label: "Updated label",
      notes: "Updated notes",
    });
  });

  const action_remove_spot_12 = action(() => {
    subject.removeSpot.send({ spotNumber: "12" });
  });

  const action_edit_alice = action(() => {
    subject.editPerson.send({
      name: "Alice",
      email: "alice-new@example.com",
      commuteMode: "transit",
      defaultSpot: "1",
      isAdmin: true,
    });
  });

  const action_remove_dave = action(() => {
    subject.removePerson.send({ name: "Dave" });
  });

  const action_reorder_bob_to_1 = action(() => {
    subject.reorderPriority.send({ name: "Bob", newRank: 1 });
  });

  // --- Edge case: add duplicate spot ---
  const action_add_duplicate_spot = action(() => {
    subject.addSpot.send({ spotNumber: "1", label: "Dup", notes: "" });
  });

  // --- Edge case: add empty name person ---
  const action_add_empty_person = action(() => {
    subject.addPerson.send({
      name: "   ",
      email: "x@x.com",
      commuteMode: "drive",
      defaultSpot: "",
    });
  });

  // --- Edge case: add empty spot number ---
  const action_add_empty_spot = action(() => {
    subject.addSpot.send({ spotNumber: "  ", label: "", notes: "" });
  });

  // --- Edge case: Alice requests again (duplicate request same day) ---
  const action_alice_request_today_again = action(() => {
    subject.requestSpot.send({ personName: "Alice", date: today });
  });

  // ============================================================
  // ASSERTIONS
  // ============================================================

  // --- Initial state ---
  const assert_initial_no_spots = computed(() => len(subject.spots) === 0);
  const assert_initial_no_people = computed(() => len(subject.people) === 0);
  const assert_initial_no_requests = computed(() =>
    len(subject.requests) === 0
  );
  const assert_initial_no_allocations = computed(
    () => len(subject.allocations) === 0,
  );

  // --- After adding spots ---
  const assert_3_spots = computed(() => len(subject.spots) === 3);
  const assert_spot_1_exists = computed(
    () => subject.spots.some((s: ParkingSpot) => s.spotNumber === "1"),
  );
  const assert_spot_5_exists = computed(
    () => subject.spots.some((s: ParkingSpot) => s.spotNumber === "5"),
  );
  const assert_spot_12_exists = computed(
    () => subject.spots.some((s: ParkingSpot) => s.spotNumber === "12"),
  );
  const assert_spot_1_label = computed(() => {
    const s = subject.spots.find((s: ParkingSpot) => s.spotNumber === "1");
    return s?.label === "Closest to door";
  });

  // --- After duplicate spot attempt ---
  const assert_still_3_spots = computed(() => len(subject.spots) === 3);

  // --- After empty spot number attempt ---
  const assert_still_3_spots_after_empty = computed(
    () => len(subject.spots) === 3,
  );

  // --- After adding people ---
  const assert_1_person = computed(() => len(subject.people) === 1);
  const assert_alice_rank_1 = computed(() => {
    const alice = subject.people.find((p: Person) => p.name === "Alice");
    return alice?.priorityRank === 1;
  });
  const assert_alice_default_spot = computed(() => {
    const alice = subject.people.find((p: Person) => p.name === "Alice");
    return alice?.defaultSpot === "5";
  });

  const assert_2_people = computed(() => len(subject.people) === 2);
  const assert_bob_rank_2 = computed(() => {
    const bob = subject.people.find((p: Person) => p.name === "Bob");
    return bob?.priorityRank === 2;
  });

  const assert_3_people = computed(() => len(subject.people) === 3);
  const assert_4_people = computed(() => len(subject.people) === 4);

  // --- After empty name person attempt ---
  const assert_still_4_people = computed(() => len(subject.people) === 4);

  // --- User selection ---
  const assert_current_user_alice = computed(
    () => subject.currentUser === "Alice",
  );

  // --- Alice requests today (should get default spot #5) ---
  const assert_1_request = computed(() => len(subject.requests) === 1);
  const assert_1_allocation = computed(() => len(subject.allocations) === 1);
  const assert_alice_allocated = computed(() => {
    const req = subject.requests.find(
      (r: SpotRequest) => r.personName === "Alice" && r.date === today,
    );
    return req?.status === "allocated";
  });
  const assert_alice_got_spot_5 = computed(() => {
    const req = subject.requests.find(
      (r: SpotRequest) => r.personName === "Alice" && r.date === today,
    );
    return req?.assignedSpot === "5";
  });
  const assert_alloc_spot_5_alice = computed(() => {
    const alloc = subject.allocations.find(
      (a: Allocation) => a.spotNumber === "5" && a.date === today,
    );
    return alloc?.personName === "Alice";
  });

  // --- Bob requests today (no default, should get first available: #1) ---
  const assert_2_allocations = computed(() => len(subject.allocations) === 2);
  const assert_bob_got_spot_1 = computed(() => {
    const req = subject.requests.find(
      (r: SpotRequest) =>
        r.personName === "Bob" && r.date === today && r.status === "allocated",
    );
    return req?.assignedSpot === "1";
  });

  // --- Carol requests today (default spot #1 taken, should get #12) ---
  const assert_3_allocations = computed(() => len(subject.allocations) === 3);
  const assert_carol_allocated = computed(() => {
    const req = subject.requests.find(
      (r: SpotRequest) =>
        r.personName === "Carol" &&
        r.date === today &&
        r.status === "allocated",
    );
    return req?.assignedSpot === "12";
  });

  // --- Dave requests today (all spots full -- denied) ---
  const assert_dave_denied = computed(() => {
    const req = subject.requests.find(
      (r: SpotRequest) =>
        r.personName === "Dave" && r.date === today && r.status === "denied",
    );
    return !!req;
  });
  const assert_still_3_allocations = computed(
    () => len(subject.allocations) === 3,
  );

  // --- Alice cancels her request ---
  const assert_alice_cancelled = computed(() => {
    const reqs = subject.requests.filter(
      (r: SpotRequest) => r.personName === "Alice" && r.date === today,
    );
    // The last request for Alice today should be cancelled
    const allocatedReqs = reqs.filter(
      (r: SpotRequest) => r.status === "allocated",
    );
    return len(allocatedReqs) === 0;
  });
  const assert_2_allocations_after_cancel = computed(
    () => len(subject.allocations) === 2,
  );
  const assert_spot_5_free = computed(
    () =>
      !subject.allocations.some(
        (a: Allocation) => a.spotNumber === "5" && a.date === today,
      ),
  );

  // --- Alice requests again (duplicate for same date) ---
  const assert_alice_reallocated = computed(() => {
    const reqs = subject.requests.filter(
      (r: SpotRequest) =>
        r.personName === "Alice" && r.date === today &&
        r.status === "allocated",
    );
    return len(reqs) === 1;
  });
  const assert_alice_got_spot_5_again = computed(() => {
    const req = subject.requests.find(
      (r: SpotRequest) =>
        r.personName === "Alice" &&
        r.date === today &&
        r.status === "allocated",
    );
    return req?.assignedSpot === "5";
  });

  // --- Manual admin assignment: Dave gets spot #1 ---
  const assert_dave_has_spot_1 = computed(() => {
    const alloc = subject.allocations.find(
      (a: Allocation) =>
        a.spotNumber === "1" && a.date === today && a.personName === "Dave",
    );
    return !!alloc;
  });
  const assert_dave_manual = computed(() => {
    const alloc = subject.allocations.find(
      (a: Allocation) =>
        a.spotNumber === "1" && a.date === today && a.personName === "Dave",
    );
    return alloc ? !alloc.autoAllocated : false;
  });
  // Bob's old allocation for spot #1 should be gone
  const assert_bob_lost_spot_1 = computed(
    () =>
      !subject.allocations.some(
        (a: Allocation) =>
          a.spotNumber === "1" && a.date === today && a.personName === "Bob",
      ),
  );
  // After manual assign of Dave to spot #1:
  // Bob's request should no longer be "allocated" (he was displaced).
  // The total allocated requests for today should be 3: Alice(#5) + Carol(#12) + Dave(#1).
  // Before this fix, Bob's request stayed "allocated" making it 4.
  const assert_bob_request_cancelled_after_manual = computed(() => {
    const allocatedToday = subject.requests.filter(
      (r: SpotRequest) => r.date === today && r.status === "allocated",
    );
    return allocatedToday.filter(() => true).length === 3;
  });

  // --- Admin cancel allocation: spot #1 ---
  const assert_spot_1_free_after_admin_cancel = computed(
    () =>
      !subject.allocations.some(
        (a: Allocation) => a.spotNumber === "1" && a.date === today,
      ),
  );

  // --- Edit spot #1 ---
  const assert_spot_1_updated_label = computed(() => {
    const s = subject.spots.find(
      (s: ParkingSpot) => s.spotNumber === "1",
    );
    return s?.label === "Updated label";
  });
  const assert_spot_1_updated_notes = computed(() => {
    const s = subject.spots.find(
      (s: ParkingSpot) => s.spotNumber === "1",
    );
    return s?.notes === "Updated notes";
  });

  // --- Remove spot #12 ---
  const assert_2_spots_after_remove = computed(() => len(subject.spots) === 2);
  const assert_spot_12_gone = computed(
    () => !subject.spots.some((s: ParkingSpot) => s.spotNumber === "12"),
  );

  // --- Edit Alice ---
  const assert_alice_edited_email = computed(() => {
    const alice = subject.people.find((p: Person) => p.name === "Alice");
    return alice?.email === "alice-new@example.com";
  });
  const assert_alice_edited_commute = computed(() => {
    const alice = subject.people.find((p: Person) => p.name === "Alice");
    return alice?.commuteMode === "transit";
  });
  const assert_alice_is_admin = computed(() => {
    const alice = subject.people.find((p: Person) => p.name === "Alice");
    return alice?.isAdmin === true;
  });

  // --- Remove Dave ---
  const assert_3_people_after_remove = computed(
    () => len(subject.people) === 3,
  );
  const assert_dave_gone = computed(
    () => !subject.people.some((p: Person) => p.name === "Dave"),
  );
  // Ranks should be recomputed: contiguous 1, 2, 3
  const assert_ranks_contiguous = computed(() => {
    const ranks = subject.people
      .map((p: Person) => p.priorityRank)
      .sort((a: number, b: number) => a - b);
    return (
      len(ranks) === 3 && ranks[0] === 1 && ranks[1] === 2 && ranks[2] === 3
    );
  });

  // --- Reorder Bob to rank 1 ---
  const assert_bob_rank_1 = computed(() => {
    const bob = subject.people.find((p: Person) => p.name === "Bob");
    return bob?.priorityRank === 1;
  });
  const assert_alice_rank_2_after_reorder = computed(() => {
    const alice = subject.people.find((p: Person) => p.name === "Alice");
    return alice?.priorityRank === 2;
  });

  // ============================================================
  // TEST SEQUENCE
  // ============================================================

  return {
    tests: [
      // Initial state
      { assertion: assert_initial_no_spots },
      { assertion: assert_initial_no_people },
      { assertion: assert_initial_no_requests },
      { assertion: assert_initial_no_allocations },

      // Add 3 spots
      { action: action_add_spot_1 },
      { action: action_add_spot_5 },
      { action: action_add_spot_12 },
      { assertion: assert_3_spots },
      { assertion: assert_spot_1_exists },
      { assertion: assert_spot_5_exists },
      { assertion: assert_spot_12_exists },
      { assertion: assert_spot_1_label },

      // Duplicate spot rejected
      { action: action_add_duplicate_spot },
      { assertion: assert_still_3_spots },

      // Empty spot number rejected
      { action: action_add_empty_spot },
      { assertion: assert_still_3_spots_after_empty },

      // Add Alice (rank 1, default spot #5)
      { action: action_add_alice },
      { assertion: assert_1_person },
      { assertion: assert_alice_rank_1 },
      { assertion: assert_alice_default_spot },

      // Add Bob (rank 2, no default)
      { action: action_add_bob },
      { assertion: assert_2_people },
      { assertion: assert_bob_rank_2 },

      // Add Carol and Dave
      { action: action_add_carol },
      { assertion: assert_3_people },
      { action: action_add_dave },
      { assertion: assert_4_people },

      // Empty name rejected
      { action: action_add_empty_person },
      { assertion: assert_still_4_people },

      // Select Alice as current user
      { action: action_select_alice },
      { assertion: assert_current_user_alice },

      // Alice requests today -> gets default spot #5
      { action: action_alice_request_today },
      { assertion: assert_1_request },
      { assertion: assert_1_allocation },
      { assertion: assert_alice_allocated },
      { assertion: assert_alice_got_spot_5 },
      { assertion: assert_alloc_spot_5_alice },

      // Bob requests today -> gets #1 (first available)
      { action: action_bob_request_today },
      { assertion: assert_2_allocations },
      { assertion: assert_bob_got_spot_1 },

      // Carol requests today -> default #1 taken, gets #12
      { action: action_carol_request_today },
      { assertion: assert_3_allocations },
      { assertion: assert_carol_allocated },

      // Dave requests today -> all full, denied
      { action: action_dave_request_today },
      { assertion: assert_dave_denied },
      { assertion: assert_still_3_allocations },

      // Alice cancels her request -> spot #5 freed
      { action: action_alice_cancel_today },
      { assertion: assert_alice_cancelled },
      { assertion: assert_2_allocations_after_cancel },
      { assertion: assert_spot_5_free },

      // Alice requests again (duplicate for same date) -> gets #5 again
      { action: action_alice_request_today_again },
      { assertion: assert_alice_reallocated },
      { assertion: assert_alice_got_spot_5_again },

      // Manual admin assignment: Dave gets spot #1 (overrides Bob)
      { action: action_manual_assign_dave },
      { assertion: assert_dave_has_spot_1 },
      { assertion: assert_dave_manual },
      { assertion: assert_bob_lost_spot_1 },
      { assertion: assert_bob_request_cancelled_after_manual },

      // Admin cancel allocation: spot #1
      { action: action_admin_cancel_spot_1 },
      { assertion: assert_spot_1_free_after_admin_cancel },

      // Edit spot #1
      { action: action_edit_spot_1 },
      { assertion: assert_spot_1_updated_label },
      { assertion: assert_spot_1_updated_notes },

      // Remove spot #12
      { action: action_remove_spot_12 },
      { assertion: assert_2_spots_after_remove },
      { assertion: assert_spot_12_gone },

      // Edit Alice
      { action: action_edit_alice },
      { assertion: assert_alice_edited_email },
      { assertion: assert_alice_edited_commute },
      { assertion: assert_alice_is_admin },

      // Remove Dave
      { action: action_remove_dave },
      { assertion: assert_3_people_after_remove },
      { assertion: assert_dave_gone },
      { assertion: assert_ranks_contiguous },

      // Reorder Bob to rank 1
      { action: action_reorder_bob_to_1 },
      { assertion: assert_bob_rank_1 },
      { assertion: assert_alice_rank_2_after_reorder },
    ],
    subject,
  };
});
