/// <cts-enable />
/**
 * Parking Coordinator Pattern Tests
 *
 * Tests core functionality:
 * - Initial state (pre-seeded spots, no people, no requests)
 * - Adding / removing people (admin actions)
 * - Priority reordering (movePersonUp / movePersonDown)
 * - Adding / removing spots (admin actions)
 * - Spot request submission with auto-allocation (default spot, preferences, any remaining)
 * - Denied allocation when all spots are taken
 * - Duplicate request prevention
 * - Request cancellation
 * - Admin override (manual assignment, autoAllocated: false)
 *
 * NOTE: Uses .filter(() => true).length for array lengths per reactivity tracking note.
 */
import { action, computed, pattern } from "commonfabric";
import ParkingCoordinator, { DEFAULT_SPOTS } from "./main.tsx";
import type { ParkingSpot, Person, SpotRequest } from "./main.tsx";

const len = <T,>(arr: T[]): number => arr.filter(() => true).length;

const toLocalDateStr = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
    String(d.getDate()).padStart(2, "0")
  }`;

const TODAY = toLocalDateStr(new Date());
const TOMORROW = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return toLocalDateStr(d);
})();

export default pattern(() => {
  // ============================================================
  // Subject 1: People Management
  // ============================================================
  const s1 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [],
    requests: [],
  });

  const action_add_alice = action(() => {
    s1.addPerson.send({
      name: "Alice",
      email: "alice@co.com",
      commuteMode: "drive",
      priorityRank: 1,
      defaultSpot: "5",
      preferences: "5, 1",
    });
  });

  const action_add_bob = action(() => {
    s1.addPerson.send({
      name: "Bob",
      email: "bob@co.com",
      commuteMode: "transit",
      priorityRank: 2,
      defaultSpot: "",
      preferences: "12",
    });
  });

  const action_add_alice_duplicate = action(() => {
    s1.addPerson.send({
      name: "Alice",
      email: "alice2@co.com",
      commuteMode: "wfh",
      priorityRank: 5,
      defaultSpot: "",
      preferences: "",
    });
  });

  const action_remove_bob = action(() => {
    s1.removePerson.send({ name: "Bob" });
  });

  // Initial state
  const assert_s1_no_people = computed(() => len(s1.people) === 0);
  const assert_s1_three_spots = computed(() => len(s1.spots) === 3);

  // After adding Alice
  const assert_s1_alice_exists = computed(() =>
    s1.people.some((p: Person) => p.name === "Alice")
  );
  const assert_s1_alice_default_spot = computed(() => {
    const alice = s1.people.find((p: Person) => p.name === "Alice");
    return alice?.defaultSpot === "5";
  });
  const assert_s1_alice_preferences = computed(() => {
    const alice = s1.people.find((p: Person) => p.name === "Alice");
    return alice?.spotPreferences.some((s) => s === "5") &&
      alice?.spotPreferences.some((s) => s === "1");
  });
  const assert_s1_one_person = computed(() => len(s1.people) === 1);

  // After adding Bob
  const assert_s1_two_people = computed(() => len(s1.people) === 2);
  const assert_s1_bob_preferences = computed(() => {
    const bob = s1.people.find((p: Person) => p.name === "Bob");
    return bob?.spotPreferences.some((s) => s === "12") === true;
  });

  // Duplicate rejected
  const assert_s1_still_two = computed(() => len(s1.people) === 2);

  // After removing Bob
  const assert_s1_one_after_remove = computed(() => len(s1.people) === 1);
  const assert_s1_bob_gone = computed(() =>
    !s1.people.some((p: Person) => p.name === "Bob")
  );

  // ============================================================
  // Subject 2: Priority Reordering
  // ============================================================
  const s2 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [
      {
        name: "Alice",
        email: "a@co.com",
        commuteMode: "drive",
        spotPreferences: [],
        defaultSpot: "",
        priorityRank: 1,
      },
      {
        name: "Bob",
        email: "b@co.com",
        commuteMode: "transit",
        spotPreferences: [],
        defaultSpot: "",
        priorityRank: 2,
      },
      {
        name: "Carol",
        email: "c@co.com",
        commuteMode: "bike",
        spotPreferences: [],
        defaultSpot: "",
        priorityRank: 3,
      },
    ],
    requests: [],
  });

  const action_move_carol_up = action(() =>
    s2.movePersonUp.send({ name: "Carol" })
  );
  const action_move_alice_down = action(() =>
    s2.movePersonDown.send({ name: "Alice" })
  );

  const assert_s2_alice_rank1 = computed(() => {
    return s2.people.find((p: Person) => p.name === "Alice")?.priorityRank ===
      1;
  });
  const assert_s2_carol_rank3 = computed(() => {
    return s2.people.find((p: Person) => p.name === "Carol")?.priorityRank ===
      3;
  });
  // After moving Carol up (should swap Carol rank 3 with Bob rank 2)
  const assert_s2_carol_rank2 = computed(() => {
    return s2.people.find((p: Person) => p.name === "Carol")?.priorityRank ===
      2;
  });
  const assert_s2_bob_rank3 = computed(() => {
    return s2.people.find((p: Person) => p.name === "Bob")?.priorityRank === 3;
  });
  // After moving Alice down (rank 1 should swap with rank 2 = Carol now)
  const assert_s2_alice_rank2 = computed(() => {
    return s2.people.find((p: Person) => p.name === "Alice")?.priorityRank ===
      2;
  });

  // ============================================================
  // Subject 3: Spot Management
  // ============================================================
  const s3 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [],
    requests: [],
  });

  const action_add_spot7 = action(() =>
    s3.addSpot.send({ spotNumber: "7", label: "Level 2", notes: "Covered" })
  );
  const action_add_spot1_dup = action(() =>
    s3.addSpot.send({ spotNumber: "1", label: "Dup", notes: "" })
  );
  const action_remove_spot5 = action(() =>
    s3.removeSpot.send({ spotNumber: "5" })
  );

  const assert_s3_three_spots = computed(() => len(s3.spots) === 3);
  const assert_s3_four_spots = computed(() => len(s3.spots) === 4);
  const assert_s3_spot7_label = computed(() => {
    const s = s3.spots.find((sp: ParkingSpot) => sp.spotNumber === "7");
    return s?.label === "Level 2" && s?.active === true;
  });
  const assert_s3_still_four = computed(() => len(s3.spots) === 4); // dup rejected
  const assert_s3_three_after_remove = computed(() => len(s3.spots) === 3);
  const assert_s3_spot5_gone = computed(() =>
    !s3.spots.some((sp: ParkingSpot) => sp.spotNumber === "5")
  );

  // ============================================================
  // Subject 4: Request Submission (Allocation)
  // ============================================================

  // Alice with defaultSpot "5" → should get spot 5
  const alice4: Person = {
    name: "Alice",
    email: "a@co.com",
    commuteMode: "drive",
    spotPreferences: ["1"],
    defaultSpot: "5",
    priorityRank: 1,
  };
  const bob4: Person = {
    name: "Bob",
    email: "b@co.com",
    commuteMode: "transit",
    spotPreferences: ["1", "12"],
    defaultSpot: "",
    priorityRank: 2,
  };
  const carol4: Person = {
    name: "Carol",
    email: "c@co.com",
    commuteMode: "bike",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 3,
  };

  const s4 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [alice4, bob4, carol4],
    requests: [],
  });

  // Alice requests today → gets default spot "5"
  const action_alice_request = action(() => {
    s4.submitRequest.send({ personName: "Alice", date: TODAY });
  });

  // Bob requests today → spot "5" taken by Alice, tries prefs "1", "12" → gets "1"
  const action_bob_request = action(() => {
    s4.submitRequest.send({ personName: "Bob", date: TODAY });
  });

  // Carol requests today → no prefs, no default → gets "12" (last remaining)
  const action_carol_request = action(() => {
    s4.submitRequest.send({ personName: "Carol", date: TODAY });
  });

  // Alice duplicate request for today → rejected
  const action_alice_dupe = action(() => {
    s4.submitRequest.send({ personName: "Alice", date: TODAY });
  });

  // Alice requests tomorrow (no conflicts)
  const action_alice_tomorrow = action(() => {
    s4.submitRequest.send({ personName: "Alice", date: TOMORROW });
  });

  const assert_s4_no_requests = computed(() => len(s4.requests) === 0);

  // After Alice requests today
  const assert_s4_alice_allocated = computed(() => {
    const req = s4.requests.find((r: SpotRequest) =>
      r.personName === "Alice" && r.date === TODAY
    );
    return req?.status === "allocated" && req?.assignedSpot === "5" &&
      req?.autoAllocated === true;
  });

  // After Bob requests today
  const assert_s4_bob_allocated_pref = computed(() => {
    const req = s4.requests.find((r: SpotRequest) =>
      r.personName === "Bob" && r.date === TODAY
    );
    return req?.status === "allocated" && req?.assignedSpot === "1";
  });

  // After Carol requests today (only "12" left)
  const assert_s4_carol_allocated = computed(() => {
    const req = s4.requests.find((r: SpotRequest) =>
      r.personName === "Carol" && r.date === TODAY
    );
    return req?.status === "allocated" && req?.assignedSpot === "12";
  });

  // Alice dupe: still only one Alice request for today (no new one added)
  const assert_s4_alice_still_one_today = computed(() => {
    const aliceToday = s4.requests.filter((r: SpotRequest) =>
      r.personName === "Alice" && r.date === TODAY
    );
    return len(aliceToday) === 1;
  });

  // Duplicate shows in result message
  const assert_s4_dupe_result = computed(() =>
    s4.requestResult.toLowerCase().includes("already")
  );

  // Alice tomorrow gets allocated (any spot)
  const assert_s4_alice_tomorrow_allocated = computed(() => {
    const req = s4.requests.find((r: SpotRequest) =>
      r.personName === "Alice" && r.date === TOMORROW
    );
    return req?.status === "allocated" && req?.assignedSpot !== "";
  });

  // ============================================================
  // Subject 5: Full booking → denied
  // ============================================================
  const dave5: Person = {
    name: "Dave",
    email: "d@co.com",
    commuteMode: "other",
    spotPreferences: [],
    defaultSpot: "",
    priorityRank: 4,
  };

  const s5 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [alice4, bob4, carol4, dave5],
    requests: [
      {
        id: "r1",
        personName: "Alice",
        date: TODAY,
        status: "allocated",
        assignedSpot: "1",
        autoAllocated: true,
      },
      {
        id: "r2",
        personName: "Bob",
        date: TODAY,
        status: "allocated",
        assignedSpot: "5",
        autoAllocated: true,
      },
      {
        id: "r3",
        personName: "Carol",
        date: TODAY,
        status: "allocated",
        assignedSpot: "12",
        autoAllocated: true,
      },
    ],
  });

  const action_dave_request_denied = action(() => {
    s5.submitRequest.send({ personName: "Dave", date: TODAY });
  });

  const assert_s5_dave_denied = computed(() => {
    const req = s5.requests.find((r: SpotRequest) =>
      r.personName === "Dave" && r.date === TODAY
    );
    return req?.status === "denied" && req?.assignedSpot === "";
  });

  // ============================================================
  // Subject 6: Cancellation
  // ============================================================
  const s6 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [alice4],
    requests: [
      {
        id: "rx1",
        personName: "Alice",
        date: TODAY,
        status: "allocated",
        assignedSpot: "5",
        autoAllocated: true,
      },
    ],
  });

  const action_cancel_alice = action(() =>
    s6.cancelRequest.send({ requestId: "rx1" })
  );

  const assert_s6_allocated = computed(() => {
    return s6.requests.find((r: SpotRequest) => r.id === "rx1")?.status ===
      "allocated";
  });
  const assert_s6_cancelled = computed(() => {
    return s6.requests.find((r: SpotRequest) => r.id === "rx1")?.status ===
      "cancelled";
  });

  // ============================================================
  // Subject 7: Admin Override
  // ============================================================
  const s7 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [alice4, bob4],
    requests: [],
  });

  const action_admin_override_bob_spot5 = action(() => {
    s7.adminOverride.send({ spotNumber: "5", date: TODAY, personName: "Bob" });
  });

  const assert_s7_bob_override = computed(() => {
    return s7.requests.some(
      (r: SpotRequest) =>
        r.personName === "Bob" && r.date === TODAY && r.assignedSpot === "5" &&
        r.autoAllocated === false && r.status === "allocated",
    );
  });

  // Override with conflict: assign spot 5 to Alice (Bob already has it)
  const action_admin_override_alice_spot5 = action(() => {
    s7.adminOverride.send({
      spotNumber: "5",
      date: TODAY,
      personName: "Alice",
    });
  });

  const assert_s7_alice_has_spot5 = computed(() => {
    return s7.requests.some(
      (r: SpotRequest) =>
        r.personName === "Alice" && r.assignedSpot === "5" &&
        r.status === "allocated",
    );
  });

  const assert_s7_bob_spot5_cancelled = computed(() => {
    // Bob's original spot 5 allocation should be cancelled
    return s7.requests.some(
      (r: SpotRequest) =>
        r.personName === "Bob" && r.assignedSpot === "5" &&
        r.status === "cancelled",
    );
  });

  // ============================================================
  // Subject 8: Admin mode toggle
  // ============================================================
  const s8 = ParkingCoordinator({
    spots: DEFAULT_SPOTS,
    people: [],
    requests: [],
  });

  const action_toggle_admin = action(() => s8.toggleAdminMode.send());

  const assert_s8_admin_off = computed(() => s8.adminMode === false);
  const assert_s8_admin_on = computed(() => s8.adminMode === true);

  // ============================================================
  // Test sequence
  // ============================================================

  return {
    tests: [
      // People management
      { assertion: assert_s1_no_people },
      { assertion: assert_s1_three_spots },
      { action: action_add_alice },
      { assertion: assert_s1_alice_exists },
      { assertion: assert_s1_alice_default_spot },
      { assertion: assert_s1_alice_preferences },
      { assertion: assert_s1_one_person },
      { action: action_add_bob },
      { assertion: assert_s1_two_people },
      { assertion: assert_s1_bob_preferences },
      { action: action_add_alice_duplicate },
      { assertion: assert_s1_still_two },
      { action: action_remove_bob },
      { assertion: assert_s1_one_after_remove },
      { assertion: assert_s1_bob_gone },

      // Priority reordering
      { assertion: assert_s2_alice_rank1 },
      { assertion: assert_s2_carol_rank3 },
      { action: action_move_carol_up },
      { assertion: assert_s2_carol_rank2 },
      { assertion: assert_s2_bob_rank3 },
      { action: action_move_alice_down },
      { assertion: assert_s2_alice_rank2 },

      // Spot management
      { assertion: assert_s3_three_spots },
      { action: action_add_spot7 },
      { assertion: assert_s3_four_spots },
      { assertion: assert_s3_spot7_label },
      { action: action_add_spot1_dup },
      { assertion: assert_s3_still_four },
      { action: action_remove_spot5 },
      { assertion: assert_s3_three_after_remove },
      { assertion: assert_s3_spot5_gone },

      // Request allocation
      { assertion: assert_s4_no_requests },
      { action: action_alice_request },
      { assertion: assert_s4_alice_allocated },
      { action: action_bob_request },
      { assertion: assert_s4_bob_allocated_pref },
      { action: action_carol_request },
      { assertion: assert_s4_carol_allocated },
      { action: action_alice_dupe },
      { assertion: assert_s4_alice_still_one_today },
      { assertion: assert_s4_dupe_result },
      { action: action_alice_tomorrow },
      { assertion: assert_s4_alice_tomorrow_allocated },

      // Denied when full
      { action: action_dave_request_denied },
      { assertion: assert_s5_dave_denied },

      // Cancellation
      { assertion: assert_s6_allocated },
      { action: action_cancel_alice },
      { assertion: assert_s6_cancelled },

      // Admin override
      { action: action_admin_override_bob_spot5 },
      { assertion: assert_s7_bob_override },
      { action: action_admin_override_alice_spot5 },
      { assertion: assert_s7_alice_has_spot5 },
      { assertion: assert_s7_bob_spot5_cancelled },

      // Admin mode toggle
      { assertion: assert_s8_admin_off },
      { action: action_toggle_admin },
      { assertion: assert_s8_admin_on },
      { action: action_toggle_admin },
      { assertion: assert_s8_admin_off },
    ],
    s1,
    s2,
    s3,
    s4,
    s5,
    s6,
    s7,
    s8,
  };
});
