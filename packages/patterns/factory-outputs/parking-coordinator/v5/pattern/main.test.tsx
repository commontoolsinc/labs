/// <cts-enable />
/**
 * Test Pattern: Parking Coordinator
 *
 * Tests core functionality:
 * - Initial state (default spots, no people, no requests)
 * - Adding/removing spots
 * - Adding/removing people
 * - Requesting spots (auto-allocation)
 * - Default spot and preference-based allocation
 * - Cancelling requests
 * - Denial when all spots taken
 * - Duplicate request prevention
 * - Person removal cascading to requests
 * - Spot removal cascading to requests/people
 * - Priority reordering
 * - Manual assignment
 *
 * Run: deno task ct test workspace/2026-02-27-parking-coordinator-q3m8/pattern/main.test.tsx --verbose
 */
import { action, computed, pattern } from "commontools";
import ParkingCoordinator from "./main.tsx";

// Helper for reactive array length
const len = <T,>(arr: T[]): number => arr.filter(() => true).length;

// Get today's date for request comparisons
const getTodayDate = (): string => new Date().toISOString().split("T")[0];

export default pattern(() => {
  const todayDate = getTodayDate();

  // Initialize with default 3 spots, no people, no requests
  const subject = ParkingCoordinator({
    spots: [
      { number: 1, label: "Near entrance", notes: "" },
      { number: 5, label: "", notes: "" },
      { number: 12, label: "Covered", notes: "" },
    ],
    people: [],
    requests: [],
  });

  // =====================================================================
  // ACTIONS
  // =====================================================================

  // -- Spots --
  const action_add_spot_20 = action(() => {
    subject.addSpot.send({ number: 20, label: "New spot", notes: "Compact" });
  });

  const action_add_duplicate_spot_1 = action(() => {
    subject.addSpot.send({ number: 1, label: "Dup", notes: "" });
  });

  const action_edit_spot_1 = action(() => {
    subject.editSpot.send({
      number: 1,
      label: "VIP entrance",
      notes: "Reserved",
    });
  });

  const action_remove_spot_20 = action(() => {
    subject.removeSpot.send({ number: 20 });
  });

  // -- People --
  const action_add_alice = action(() => {
    subject.addPerson.send({
      name: "Alice",
      email: "alice@co.com",
      commuteMode: "drive",
    });
  });

  const action_add_bob = action(() => {
    subject.addPerson.send({
      name: "Bob",
      email: "bob@co.com",
      commuteMode: "transit",
    });
  });

  const action_add_charlie = action(() => {
    subject.addPerson.send({
      name: "Charlie",
      email: "charlie@co.com",
      commuteMode: "bike",
    });
  });

  const action_add_diana = action(() => {
    subject.addPerson.send({
      name: "Diana",
      email: "diana@co.com",
      commuteMode: "drive",
    });
  });

  const action_add_empty_person = action(() => {
    subject.addPerson.send({
      name: "  ",
      email: "x@x.com",
      commuteMode: "drive",
    });
  });

  const action_add_duplicate_alice = action(() => {
    subject.addPerson.send({
      name: "Alice",
      email: "alice2@co.com",
      commuteMode: "drive",
    });
  });

  // -- Priority reordering --
  const action_move_bob_up = action(() => {
    subject.movePersonUp.send({ name: "Bob" });
  });

  const action_move_alice_down = action(() => {
    subject.movePersonDown.send({ name: "Alice" });
  });

  // -- Default spot / preferences --
  const action_set_alice_default_1 = action(() => {
    subject.setDefaultSpot.send({ personName: "Alice", spotNumber: 1 });
  });

  const action_set_bob_default_5 = action(() => {
    subject.setDefaultSpot.send({ personName: "Bob", spotNumber: 5 });
  });

  const action_set_alice_prefs = action(() => {
    subject.setSpotPreferences.send({
      personName: "Alice",
      preferences: [5, 12],
    });
  });

  // -- Requesting spots --
  const action_alice_request_today = action(() => {
    subject.requestSpot.send({ personName: "Alice", date: todayDate });
  });

  const action_bob_request_today = action(() => {
    subject.requestSpot.send({ personName: "Bob", date: todayDate });
  });

  const action_charlie_request_today = action(() => {
    subject.requestSpot.send({ personName: "Charlie", date: todayDate });
  });

  const action_diana_request_today = action(() => {
    subject.requestSpot.send({ personName: "Diana", date: todayDate });
  });

  const action_alice_duplicate_request = action(() => {
    subject.requestSpot.send({ personName: "Alice", date: todayDate });
  });

  // -- Cancelling --
  const action_cancel_bob_today = action(() => {
    subject.cancelRequest.send({ personName: "Bob", date: todayDate });
  });

  // -- Manual assign --
  // Manual assign Alice to spot #5 (after her spot #1 is removed and she's pending)
  const action_manual_assign_alice_spot_5 = action(() => {
    subject.manualAssign.send({
      personName: "Alice",
      date: todayDate,
      spotNumber: 5,
    });
  });

  // -- Remove person --
  const action_remove_charlie = action(() => {
    subject.removePerson.send({ name: "Charlie" });
  });

  // -- Remove spot with active allocations --
  const action_remove_spot_1 = action(() => {
    subject.removeSpot.send({ number: 1 });
  });

  // =====================================================================
  // ASSERTIONS
  // =====================================================================

  // -- Initial state --
  const assert_initial_3_spots = computed(() => len(subject.spots) === 3);
  const assert_initial_spot_numbers = computed(() => {
    return (
      subject.spots[0]?.number === 1 &&
      subject.spots[1]?.number === 5 &&
      subject.spots[2]?.number === 12
    );
  });
  const assert_initial_no_people = computed(() => len(subject.people) === 0);
  const assert_initial_no_requests = computed(() =>
    len(subject.requests) === 0
  );

  // -- After adding spot 20 --
  const assert_4_spots = computed(() => len(subject.spots) === 4);
  const assert_spot_20_exists = computed(() =>
    subject.spots.some((s) => s.number === 20 && s.label === "New spot")
  );

  // -- Duplicate spot rejected --
  const assert_still_4_spots = computed(() => len(subject.spots) === 4);

  // -- Edit spot --
  const assert_spot_1_edited = computed(() => {
    const s = subject.spots.find((s) => s.number === 1);
    return s?.label === "VIP entrance" && s?.notes === "Reserved";
  });

  // -- Remove spot 20 --
  const assert_3_spots_again = computed(() => len(subject.spots) === 3);
  const assert_spot_20_gone = computed(() =>
    !subject.spots.some((s) => s.number === 20)
  );

  // -- Add people --
  const assert_alice_added = computed(() => len(subject.people) === 1);
  const assert_alice_name = computed(() => subject.people[0]?.name === "Alice");

  const assert_bob_added = computed(() => len(subject.people) === 2);
  const assert_charlie_added = computed(() => len(subject.people) === 3);

  // -- Empty name rejected --
  const assert_still_3_people = computed(() => len(subject.people) === 3);

  // -- Duplicate name rejected --
  const assert_still_3_people_dup = computed(() => len(subject.people) === 3);

  // -- Priority reorder: move Bob up --
  const assert_bob_first = computed(() => subject.people[0]?.name === "Bob");
  const assert_alice_second = computed(() =>
    subject.people[1]?.name === "Alice"
  );

  // -- Move Alice down --
  const assert_alice_third_after_down = computed(
    () => subject.people[2]?.name === "Alice",
  );

  // -- Set default spots --
  const assert_alice_default_1 = computed(() => {
    const alice = subject.people.find((p) => p.name === "Alice");
    return alice?.defaultSpot === 1;
  });

  const assert_bob_default_5 = computed(() => {
    const bob = subject.people.find((p) => p.name === "Bob");
    return bob?.defaultSpot === 5;
  });

  // -- Set preferences --
  const assert_alice_prefs = computed(() => {
    const alice = subject.people.find((p) => p.name === "Alice");
    const prefs = alice?.spotPreferences || [];
    return len(prefs) === 2 && prefs[0] === 5 && prefs[1] === 12;
  });

  // -- Alice requests today: should get default spot #1 --
  const assert_1_request = computed(() => len(subject.requests) === 1);
  const assert_alice_got_spot_1 = computed(() => {
    const req = subject.requests.find(
      (r) => r.personName === "Alice" && r.requestedDate === todayDate,
    );
    return req?.status === "allocated" && req?.assignedSpot === 1;
  });
  const assert_alice_auto_allocated = computed(() => {
    const req = subject.requests.find(
      (r) => r.personName === "Alice" && r.requestedDate === todayDate,
    );
    return req?.autoAllocated === true;
  });

  // -- Bob requests today: should get default spot #5 --
  const assert_2_requests = computed(() => len(subject.requests) === 2);
  const assert_bob_got_spot_5 = computed(() => {
    const req = subject.requests.find(
      (r) => r.personName === "Bob" && r.requestedDate === todayDate,
    );
    return req?.status === "allocated" && req?.assignedSpot === 5;
  });

  // -- Charlie requests today: no default, should get remaining #12 --
  const assert_3_requests = computed(() => len(subject.requests) === 3);
  const assert_charlie_got_spot_12 = computed(() => {
    const req = subject.requests.find(
      (r) => r.personName === "Charlie" && r.requestedDate === todayDate,
    );
    return req?.status === "allocated" && req?.assignedSpot === 12;
  });

  // -- Duplicate request rejected --
  const assert_still_3_requests = computed(() => len(subject.requests) === 3);

  // -- Add Diana, request today: all full, should be denied --
  const assert_diana_added = computed(() => len(subject.people) === 4);
  const assert_4_requests = computed(() => len(subject.requests) === 4);
  const assert_diana_denied = computed(() => {
    const req = subject.requests.find(
      (r) => r.personName === "Diana" && r.requestedDate === todayDate,
    );
    return req?.status === "denied";
  });

  // -- Cancel Bob's request --
  const assert_bob_cancelled = computed(() => {
    const req = subject.requests.find(
      (r) =>
        r.personName === "Bob" &&
        r.requestedDate === todayDate &&
        r.status === "cancelled",
    );
    return !!req;
  });

  // -- Diana still denied (she got denied earlier, not pending) --
  // After Bob cancels, Diana already has a denied request. No auto re-allocation.

  // -- Remove Charlie: their requests should be cancelled --
  const assert_charlie_removed = computed(() =>
    !subject.people.some((p) => p.name === "Charlie")
  );
  const assert_3_people_after_remove = computed(() =>
    len(subject.people) === 3
  );
  const assert_charlie_requests_cancelled = computed(() => {
    const charlieReqs = subject.requests.filter(
      (r) => r.personName === "Charlie",
    );
    return charlieReqs.every((r) => r.status === "cancelled");
  });

  // -- Remove spot #1: Alice's allocation should revert to pending --
  const assert_alice_pending_after_spot_removal = computed(() => {
    const req = subject.requests.find(
      (r) =>
        r.personName === "Alice" &&
        r.requestedDate === todayDate &&
        r.status === "pending",
    );
    return !!req;
  });
  const assert_2_spots_after_removal = computed(() => len(subject.spots) === 2);
  const assert_alice_default_cleared = computed(() => {
    const alice = subject.people.find((p) => p.name === "Alice");
    return alice?.defaultSpot === 0;
  });

  // -- After manual assign of Alice to spot 5 --
  const assert_alice_manually_assigned_spot_5 = computed(() => {
    const req = subject.requests.find(
      (r) =>
        r.personName === "Alice" &&
        r.requestedDate === todayDate &&
        r.status === "allocated" &&
        r.assignedSpot === 5,
    );
    return !!req;
  });
  const assert_alice_not_auto_allocated = computed(() => {
    const req = subject.requests.find(
      (r) =>
        r.personName === "Alice" &&
        r.requestedDate === todayDate &&
        r.status === "allocated",
    );
    return req?.autoAllocated === false;
  });

  // -- Preference fallthrough test --
  // Alice has preferences [5, 12], default cleared to 0.
  // Bob has default spot 5. If Bob requests tomorrow first (gets #5),
  // then Alice requests, she should get preference #12 (first pref #5 is taken).
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDate = tomorrow.toISOString().split("T")[0];

  const action_bob_request_tomorrow = action(() => {
    subject.requestSpot.send({ personName: "Bob", date: tomorrowDate });
  });

  const action_alice_request_tomorrow = action(() => {
    subject.requestSpot.send({ personName: "Alice", date: tomorrowDate });
  });

  const assert_bob_got_spot_5_tomorrow = computed(() => {
    const req = subject.requests.find(
      (r) =>
        r.personName === "Bob" &&
        r.requestedDate === tomorrowDate &&
        r.status === "allocated",
    );
    return req?.assignedSpot === 5;
  });

  const assert_alice_got_pref_12_tomorrow = computed(() => {
    const req = subject.requests.find(
      (r) =>
        r.personName === "Alice" &&
        r.requestedDate === tomorrowDate &&
        r.status === "allocated",
    );
    return req?.assignedSpot === 12;
  });

  // =====================================================================
  // TEST SEQUENCE
  // =====================================================================

  return {
    tests: [
      // === Initial state ===
      { assertion: assert_initial_3_spots },
      { assertion: assert_initial_spot_numbers },
      { assertion: assert_initial_no_people },
      { assertion: assert_initial_no_requests },

      // === Spot CRUD ===
      { action: action_add_spot_20 },
      { assertion: assert_4_spots },
      { assertion: assert_spot_20_exists },

      { action: action_add_duplicate_spot_1 },
      { assertion: assert_still_4_spots },

      { action: action_edit_spot_1 },
      { assertion: assert_spot_1_edited },

      { action: action_remove_spot_20 },
      { assertion: assert_3_spots_again },
      { assertion: assert_spot_20_gone },

      // === People CRUD ===
      { action: action_add_alice },
      { assertion: assert_alice_added },
      { assertion: assert_alice_name },

      { action: action_add_bob },
      { assertion: assert_bob_added },

      { action: action_add_charlie },
      { assertion: assert_charlie_added },

      { action: action_add_empty_person },
      { assertion: assert_still_3_people },

      { action: action_add_duplicate_alice },
      { assertion: assert_still_3_people_dup },

      // === Priority reordering ===
      { action: action_move_bob_up },
      { assertion: assert_bob_first },
      { assertion: assert_alice_second },

      { action: action_move_alice_down },
      { assertion: assert_alice_third_after_down },

      // === Default spots and preferences ===
      { action: action_set_alice_default_1 },
      { assertion: assert_alice_default_1 },

      { action: action_set_bob_default_5 },
      { assertion: assert_bob_default_5 },

      { action: action_set_alice_prefs },
      { assertion: assert_alice_prefs },

      // === Auto-allocation ===
      // Alice requests: should get default spot #1
      { action: action_alice_request_today },
      { assertion: assert_1_request },
      { assertion: assert_alice_got_spot_1 },
      { assertion: assert_alice_auto_allocated },

      // Bob requests: should get default spot #5
      { action: action_bob_request_today },
      { assertion: assert_2_requests },
      { assertion: assert_bob_got_spot_5 },

      // Charlie requests: no default, gets remaining #12
      { action: action_charlie_request_today },
      { assertion: assert_3_requests },
      { assertion: assert_charlie_got_spot_12 },

      // === Duplicate request prevention ===
      { action: action_alice_duplicate_request },
      { assertion: assert_still_3_requests },

      // === Denial when all full ===
      { action: action_add_diana },
      { assertion: assert_diana_added },
      { action: action_diana_request_today },
      { assertion: assert_4_requests },
      { assertion: assert_diana_denied },

      // === Cancel request ===
      { action: action_cancel_bob_today },
      { assertion: assert_bob_cancelled },

      // === Remove person cascading ===
      { action: action_remove_charlie },
      { assertion: assert_charlie_removed },
      { assertion: assert_3_people_after_remove },
      { assertion: assert_charlie_requests_cancelled },

      // === Remove spot cascading ===
      { action: action_remove_spot_1 },
      { assertion: assert_alice_pending_after_spot_removal },
      { assertion: assert_2_spots_after_removal },
      { assertion: assert_alice_default_cleared },

      // === Manual assign: Alice is pending after spot removal, assign to #5 ===
      { action: action_manual_assign_alice_spot_5 },
      { assertion: assert_alice_manually_assigned_spot_5 },
      { assertion: assert_alice_not_auto_allocated },

      // === Preference fallthrough: Bob takes #5 tomorrow, Alice falls to pref #12 ===
      { action: action_bob_request_tomorrow },
      { assertion: assert_bob_got_spot_5_tomorrow },
      { action: action_alice_request_tomorrow },
      { assertion: assert_alice_got_pref_12_tomorrow },
    ],
    subject,
  };
});
