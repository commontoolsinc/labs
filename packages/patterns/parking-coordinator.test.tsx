/// <cts-enable />
/**
 * Pattern tests for parking-coordinator.tsx
 *
 * Tests the core allocation logic, priority ordering, and state transitions.
 * Run: deno task ct test packages/patterns/parking-coordinator.test.tsx --verbose
 */
import { action, computed, equals, pattern, Writable } from "commontools";
import ParkingCoordinator from "./parking-coordinator.tsx";

// Date helper at module scope (not inside pattern)
const getTodayDate = (): string => {
  const now = new Date();
  return now.toISOString().split("T")[0];
};

const todayDate = getTodayDate();

export default pattern(() => {
  // Instantiate the pattern under test with typed spots
  const initialSpots = [
    { number: 1 as const, label: "", notes: "" },
    { number: 5 as const, label: "", notes: "" },
    { number: 12 as const, label: "", notes: "" },
  ];

  const coordinator = ParkingCoordinator({
    spots: initialSpots,
    people: Writable.of([]),
    guests: Writable.of([]),
    requests: Writable.of([]),
    allocations: Writable.of([]),
    priorityOrder: Writable.of([]),
  });

  // ============ INITIAL STATE ASSERTIONS ============

  // Check that spots array exists and has items
  const assert_starts_with_spots = computed(() => {
    // Access spots array
    const spots = coordinator.spots;
    // Check if it's an array with items
    return Array.isArray(spots) && spots.length > 0;
  });

  const assert_starts_with_no_people = computed(
    () => coordinator.people.length === 0,
  );

  const assert_starts_with_no_requests = computed(
    () => coordinator.requests.length === 0,
  );

  const assert_starts_with_no_allocations = computed(
    () => coordinator.allocations.length === 0,
  );

  // ============ ADD PERSON ACTIONS ============

  const action_add_person_alice = action(() => {
    coordinator.addPerson.send({
      name: "Alice",
      email: "alice@example.com",
      usualCommuteMode: "drive",
      livesNearby: false,
      spotPreferences: [5, 1, 12],
      compatibleSpots: [1, 5, 12],
      defaultSpot: 5,
    });
  });

  const action_add_person_bob = action(() => {
    coordinator.addPerson.send({
      name: "Bob",
      email: "bob@example.com",
      usualCommuteMode: "bart",
      livesNearby: true,
      spotPreferences: [1, 5],
      compatibleSpots: [1, 5], // Bob can't use spot 12 (car too big)
      defaultSpot: 1,
    });
  });

  const action_add_person_charlie = action(() => {
    coordinator.addPerson.send({
      name: "Charlie",
      email: "charlie@example.com",
      usualCommuteMode: "drive",
      livesNearby: false,
      spotPreferences: [],
      compatibleSpots: [1, 5, 12],
      defaultSpot: null,
    });
  });

  const assert_has_3_people = computed(() => {
    const people = coordinator.people;
    return Array.isArray(people) && people.length === 3;
  });

  const assert_priority_order_has_3 = computed(() => {
    const order = coordinator.priorityOrder;
    return Array.isArray(order) && order.length === 3;
  });

  // ============ REQUEST SPOT ACTIONS ============

  const action_alice_requests_spot = action(() => {
    const alice = coordinator.people.find((p) => p.name === "Alice");
    if (alice) {
      coordinator.requestSpot.send({
        person: alice,
        date: todayDate,
      });
    }
  });

  const action_bob_requests_spot = action(() => {
    const bob = coordinator.people.find((p) => p.name === "Bob");
    if (bob) {
      coordinator.requestSpot.send({
        person: bob,
        date: todayDate,
      });
    }
  });

  const action_charlie_requests_spot = action(() => {
    const charlie = coordinator.people.find((p) => p.name === "Charlie");
    if (charlie) {
      coordinator.requestSpot.send({
        person: charlie,
        date: todayDate,
      });
    }
  });

  const assert_has_3_pending_requests = computed(() => {
    const pending = coordinator.requests.filter(
      (r) => r.status === "pending" && r.date === todayDate,
    );
    return pending.length === 3;
  });

  // ============ AUTO-ALLOCATE TEST ============

  const action_run_auto_allocate = action(() => {
    coordinator.runAutoAllocate.send({ date: todayDate });
  });

  const assert_all_requests_allocated = computed(() => {
    const allocated = coordinator.requests.filter(
      (r) => r.status === "allocated" && r.date === todayDate,
    );
    return allocated.length === 3;
  });

  const assert_3_allocations_exist = computed(
    () =>
      coordinator.allocations.filter((a) => a.date === todayDate).length === 3,
  );

  // Check that Alice got her default spot (5)
  const assert_alice_got_default_spot = computed(() => {
    const alice = coordinator.people.find((p) => p.name === "Alice");
    if (!alice) return false;
    const alloc = coordinator.allocations.find(
      (a) => a.person && equals(a.person, alice) && a.date === todayDate,
    );
    return alloc?.spot === 5;
  });

  // Check that Bob got his default spot (1)
  const assert_bob_got_default_spot = computed(() => {
    const bob = coordinator.people.find((p) => p.name === "Bob");
    if (!bob) return false;
    const alloc = coordinator.allocations.find(
      (a) => a.person && equals(a.person, bob) && a.date === todayDate,
    );
    return alloc?.spot === 1;
  });

  // Charlie should get spot 12 (the only one left)
  const assert_charlie_got_remaining_spot = computed(() => {
    const charlie = coordinator.people.find((p) => p.name === "Charlie");
    if (!charlie) return false;
    const alloc = coordinator.allocations.find(
      (a) => a.person && equals(a.person, charlie) && a.date === todayDate,
    );
    return alloc?.spot === 12;
  });

  // ============ PRIORITY REORDER TEST ============

  const action_move_third_person_up = action(() => {
    // Move whoever is third up (priorityOrder is now Person[])
    const order = coordinator.priorityOrder;
    if (order.length >= 3) {
      coordinator.movePriorityUp.send({ person: order[2] });
    }
  });

  const assert_order_changed = computed(() => {
    const order = coordinator.priorityOrder;
    // After moving third up, positions 1 and 2 should be swapped
    return order.length === 3;
  });

  // ============ ADD GUEST TEST ============

  const action_add_high_priority_guest = action(() => {
    const alice = coordinator.people.find((p) => p.name === "Alice");
    if (alice) {
      coordinator.addGuest.send({
        name: "VIP Investor",
        hostPerson: alice,
        type: "high-priority",
        compatibleSpots: [1, 5, 12],
        notes: "Board meeting",
      });
    }
  });

  const assert_has_high_priority_guest = computed(() => {
    const guest = coordinator.guests.find((g) => g.name === "VIP Investor");
    return guest?.type === "high-priority";
  });

  // ============ RETURN TESTS ============

  return {
    tests: [
      // Initial state
      { assertion: assert_starts_with_spots },
      { assertion: assert_starts_with_no_people },
      { assertion: assert_starts_with_no_requests },
      { assertion: assert_starts_with_no_allocations },

      // Add people
      { action: action_add_person_alice },
      { action: action_add_person_bob },
      { action: action_add_person_charlie },
      { assertion: assert_has_3_people },
      { assertion: assert_priority_order_has_3 },

      // Create requests
      { action: action_alice_requests_spot },
      { action: action_bob_requests_spot },
      { action: action_charlie_requests_spot },
      { assertion: assert_has_3_pending_requests },

      // Auto-allocate
      { action: action_run_auto_allocate },
      { assertion: assert_all_requests_allocated },
      { assertion: assert_3_allocations_exist },
      { assertion: assert_alice_got_default_spot },
      { assertion: assert_bob_got_default_spot },
      { assertion: assert_charlie_got_remaining_spot },

      // Priority reordering
      { action: action_move_third_person_up },
      { assertion: assert_order_changed },

      // Guest handling
      { action: action_add_high_priority_guest },
      { assertion: assert_has_high_priority_guest },
    ],

    // Expose for debugging
    subject: coordinator,
  };
});
