/// <cts-enable />
import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commontools";

// ============================================================
// Domain Types
// ============================================================

export interface ParkingSpot {
  spotNumber: string;
  label: Default<string, "">;
  notes: Default<string, "">;
}

export type CommuteMode = "drive" | "transit" | "bike" | "wfh" | "other";

export interface Person {
  name: string;
  email: string;
  commuteMode: Default<CommuteMode, "drive">;
  spotPreferences: Default<string[], []>;
  defaultSpot: Default<string, "">;
  priorityRank: number;
  isAdmin: Default<boolean, false>;
}

export type RequestStatus = "pending" | "allocated" | "denied" | "cancelled";

export interface SpotRequest {
  personName: string;
  date: string; // YYYY-MM-DD
  status: RequestStatus;
  assignedSpot: Default<string, "">;
}

export interface Allocation {
  spotNumber: string;
  date: string; // YYYY-MM-DD
  personName: string;
  autoAllocated: Default<boolean, true>;
}

// ============================================================
// Pattern Types
// ============================================================

export interface ParkingCoordinatorInput {
  spots: Writable<Default<ParkingSpot[], []>>;
  people: Writable<Default<Person[], []>>;
  requests: Writable<Default<SpotRequest[], []>>;
  allocations: Writable<Default<Allocation[], []>>;
}

export interface ParkingCoordinatorOutput {
  [NAME]: string;
  [UI]: VNode;
  spots: ParkingSpot[];
  people: Person[];
  requests: SpotRequest[];
  allocations: Allocation[];
  currentUser: string;

  // Team member actions
  requestSpot: Stream<{ personName: string; date: string }>;
  cancelRequest: Stream<{ personName: string; date: string }>;
  selectUser: Stream<{ name: string }>;

  // Admin actions
  addSpot: Stream<{ spotNumber: string; label: string; notes: string }>;
  editSpot: Stream<{ spotNumber: string; label: string; notes: string }>;
  removeSpot: Stream<{ spotNumber: string }>;
  addPerson: Stream<{
    name: string;
    email: string;
    commuteMode: string;
    defaultSpot: string;
  }>;
  editPerson: Stream<{
    name: string;
    email: string;
    commuteMode: string;
    defaultSpot: string;
    isAdmin: boolean;
  }>;
  removePerson: Stream<{ name: string }>;
  reorderPriority: Stream<{ name: string; newRank: number }>;
  manualAssign: Stream<{
    spotNumber: string;
    personName: string;
    date: string;
  }>;
  adminCancelAllocation: Stream<{
    spotNumber: string;
    date: string;
  }>;
}

// ============================================================
// Helpers
// ============================================================

const getTodayDate = (): string => {
  const now = new Date();
  return now.toISOString().split("T")[0];
};

const getDateOffset = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().split("T")[0];
};

const formatDateLabel = (dateStr: string): string => {
  const d = new Date(dateStr + "T12:00:00");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}`;
};

// ============================================================
// Core allocation logic (pure function)
// ============================================================

const findAvailableSpot = (
  personName: string,
  date: string,
  spotsList: readonly ParkingSpot[],
  peopleList: readonly Person[],
  allocationsList: readonly Allocation[],
): string | null => {
  const takenSpots = allocationsList
    .filter((a) => a.date === date)
    .map((a) => a.spotNumber);

  const person = peopleList.find((p) => p.name === personName);
  if (!person) return null;

  // 1. Try default spot
  if (
    person.defaultSpot &&
    person.defaultSpot !== "" &&
    !takenSpots.includes(person.defaultSpot) &&
    spotsList.some((s) => s.spotNumber === person.defaultSpot)
  ) {
    return person.defaultSpot;
  }

  // 2. Try preferences in order
  const prefs = person.spotPreferences || [];
  for (const pref of prefs) {
    if (
      !takenSpots.includes(pref) &&
      spotsList.some((s) => s.spotNumber === pref)
    ) {
      return pref;
    }
  }

  // 3. Any available spot
  for (const spot of spotsList) {
    if (!takenSpots.includes(spot.spotNumber)) {
      return spot.spotNumber;
    }
  }

  return null;
};

// ============================================================
// Pattern
// ============================================================

export default pattern<ParkingCoordinatorInput, ParkingCoordinatorOutput>(
  ({ spots, people, requests, allocations }) => {
    const todayDate = getTodayDate();

    // --- UI state ---
    const currentUser = Writable.of("");
    const activeTab = Writable.of("today");
    const expandedDay = Writable.of("");
    const addSpotFormOpen = Writable.of(false);
    const addPersonFormOpen = Writable.of(false);
    const editingSpotId = Writable.of("");
    const editingPersonId = Writable.of("");
    const confirmCancelDate = Writable.of("");
    const confirmRemoveSpot = Writable.of("");
    const confirmRemovePerson = Writable.of("");

    // Form fields
    const newSpotNumber = Writable.of("");
    const newSpotLabel = Writable.of("");
    const newSpotNotes = Writable.of("");
    const newPersonName = Writable.of("");
    const newPersonEmail = Writable.of("");
    const newPersonCommute = Writable.of("drive");
    const newPersonDefaultSpot = Writable.of("");
    const editSpotLabelField = Writable.of("");
    const editSpotNotesField = Writable.of("");
    const editPersonEmailField = Writable.of("");
    const editPersonCommuteField = Writable.of("drive");
    const editPersonDefaultSpotField = Writable.of("");
    const editPersonIsAdminField = Writable.of(false);
    const manualAssignPersonField = Writable.of("");
    const manualAssignSpotField = Writable.of("");

    // Week dates (static)
    const weekDates = [0, 1, 2, 3, 4, 5, 6].map((i) => getDateOffset(i));

    // ============================================================
    // Actions
    // ============================================================

    const selectUser = action<{ name: string }>(({ name }) => {
      currentUser.set(name);
    });

    const requestSpot = action<{ personName: string; date: string }>(
      ({ personName, date }) => {
        if (date < todayDate) return;

        const curSpots = [...spots.get()];
        const curPeople = [...people.get()];
        const curAllocs = [...allocations.get()];
        const curReqs = [...requests.get()];

        // Cancel existing active request for same date
        const existingIdx = curReqs.findIndex(
          (r: SpotRequest) =>
            r.personName === personName &&
            r.date === date &&
            r.status !== "cancelled",
        );

        const updatedReqs = [...curReqs];
        let updatedAllocs = [...curAllocs];

        if (existingIdx >= 0) {
          const existing = updatedReqs[existingIdx];
          updatedReqs[existingIdx] = {
            ...existing,
            status: "cancelled" as RequestStatus,
          };
          if (
            existing.status === "allocated" &&
            existing.assignedSpot
          ) {
            updatedAllocs = updatedAllocs.filter(
              (a: Allocation) =>
                !(
                  a.spotNumber === existing.assignedSpot &&
                  a.date === date &&
                  a.personName === personName
                ),
            );
          }
        }

        // Auto-allocate
        const spotNumber = findAvailableSpot(
          personName,
          date,
          curSpots,
          curPeople,
          updatedAllocs,
        );

        if (spotNumber) {
          updatedReqs.push({
            personName,
            date,
            status: "allocated" as RequestStatus,
            assignedSpot: spotNumber,
          });
          updatedAllocs.push({
            spotNumber,
            date,
            personName,
            autoAllocated: true,
          });
        } else {
          updatedReqs.push({
            personName,
            date,
            status: "denied" as RequestStatus,
            assignedSpot: "",
          });
        }

        requests.set(updatedReqs);
        allocations.set(updatedAllocs);
      },
    );

    const cancelRequest = action<{ personName: string; date: string }>(
      ({ personName, date }) => {
        const curReqs = [...requests.get()];
        const curAllocs = [...allocations.get()];

        const idx = curReqs.findIndex(
          (r: SpotRequest) =>
            r.personName === personName &&
            r.date === date &&
            (r.status === "allocated" || r.status === "pending"),
        );

        if (idx < 0) return;

        const req = curReqs[idx];
        const updatedReqs = curReqs.map((r: SpotRequest, i: number) =>
          i === idx ? { ...r, status: "cancelled" as RequestStatus } : r
        );

        let updatedAllocs = curAllocs;
        if (req.status === "allocated" && req.assignedSpot) {
          updatedAllocs = curAllocs.filter(
            (a: Allocation) =>
              !(
                a.spotNumber === req.assignedSpot &&
                a.date === date &&
                a.personName === personName
              ),
          );
        }

        requests.set(updatedReqs);
        allocations.set(updatedAllocs);
        confirmCancelDate.set("");
      },
    );

    const addSpot = action<{
      spotNumber: string;
      label: string;
      notes: string;
    }>(({ spotNumber, label, notes }) => {
      const trimmed = spotNumber.trim().replace(/^#/, "");
      if (!trimmed) return;
      const existing = spots.get();
      if (existing.some((s: ParkingSpot) => s.spotNumber === trimmed)) return;
      spots.push({
        spotNumber: trimmed,
        label: label || "",
        notes: notes || "",
      });
      newSpotNumber.set("");
      newSpotLabel.set("");
      newSpotNotes.set("");
      addSpotFormOpen.set(false);
    });

    const editSpot = action<{
      spotNumber: string;
      label: string;
      notes: string;
    }>(({ spotNumber: rawSpot, label, notes }) => {
      const spotNumber = rawSpot.trim().replace(/^#/, "");
      const current = [...spots.get()];
      spots.set(
        current.map((s: ParkingSpot) =>
          s.spotNumber === spotNumber ? { ...s, label, notes } : s
        ),
      );
      editingSpotId.set("");
    });

    const removeSpot = action<{ spotNumber: string }>(({ spotNumber: rawSpot }) => {
      const spotNumber = rawSpot.trim().replace(/^#/, "");
      const current = [...spots.get()];
      spots.set(
        current.filter((s: ParkingSpot) => s.spotNumber !== spotNumber),
      );

      const curAllocs = [...allocations.get()];
      allocations.set(
        curAllocs.filter(
          (a: Allocation) =>
            !(a.spotNumber === spotNumber && a.date >= todayDate),
        ),
      );

      const curReqs = [...requests.get()];
      requests.set(
        curReqs.map((r: SpotRequest) =>
          r.assignedSpot === spotNumber &&
          r.date >= todayDate &&
          r.status === "allocated"
            ? { ...r, status: "cancelled" as RequestStatus }
            : r
        ),
      );

      confirmRemoveSpot.set("");
    });

    const addPerson = action<{
      name: string;
      email: string;
      commuteMode: string;
      defaultSpot: string;
    }>(({ name, email, commuteMode, defaultSpot }) => {
      const trimmedName = name.trim();
      if (!trimmedName) return;
      const current = [...people.get()];
      if (current.some((p: Person) => p.name === trimmedName)) return;

      const maxRank = current.reduce(
        (max: number, p: Person) => Math.max(max, p.priorityRank),
        0,
      );

      const cleanDefault = (defaultSpot || "").trim().replace(/^#/, "");
      people.push({
        name: trimmedName,
        email: email || "",
        commuteMode: (commuteMode || "drive") as CommuteMode,
        spotPreferences: [],
        defaultSpot: cleanDefault,
        priorityRank: maxRank + 1,
        isAdmin: false,
      });

      newPersonName.set("");
      newPersonEmail.set("");
      newPersonCommute.set("drive");
      newPersonDefaultSpot.set("");
      addPersonFormOpen.set(false);
    });

    const editPerson = action<{
      name: string;
      email: string;
      commuteMode: string;
      defaultSpot: string;
      isAdmin: boolean;
    }>(({ name, email, commuteMode, defaultSpot, isAdmin }) => {
      const cleanDefault = (defaultSpot || "").trim().replace(/^#/, "");
      const current = [...people.get()];
      people.set(
        current.map((p: Person) =>
          p.name === name
            ? {
                ...p,
                email,
                commuteMode: commuteMode as CommuteMode,
                defaultSpot: cleanDefault,
                isAdmin,
              }
            : p
        ),
      );
      editingPersonId.set("");
    });

    const removePerson = action<{ name: string }>(({ name }) => {
      const current = [...people.get()];
      const remaining = current.filter((p: Person) => p.name !== name);
      const sorted = [...remaining].sort(
        (a: Person, b: Person) => a.priorityRank - b.priorityRank,
      );
      people.set(sorted.map((p: Person, i: number) => ({ ...p, priorityRank: i + 1 })));

      const curAllocs = [...allocations.get()];
      allocations.set(
        curAllocs.filter(
          (a: Allocation) =>
            !(a.personName === name && a.date >= todayDate),
        ),
      );

      const curReqs = [...requests.get()];
      requests.set(
        curReqs.map((r: SpotRequest) =>
          r.personName === name &&
          r.date >= todayDate &&
          r.status === "allocated"
            ? { ...r, status: "cancelled" as RequestStatus }
            : r
        ),
      );

      confirmRemovePerson.set("");
    });

    const reorderPriority = action<{ name: string; newRank: number }>(
      ({ name, newRank }) => {
        const current = [...people.get()];
        const person = current.find((p: Person) => p.name === name);
        if (!person) return;

        const oldRank = person.priorityRank;
        if (oldRank === newRank) return;

        const updated = current.map((p: Person) => {
          if (p.name === name) return { ...p, priorityRank: newRank };
          if (newRank < oldRank) {
            if (p.priorityRank >= newRank && p.priorityRank < oldRank) {
              return { ...p, priorityRank: p.priorityRank + 1 };
            }
          } else {
            if (p.priorityRank > oldRank && p.priorityRank <= newRank) {
              return { ...p, priorityRank: p.priorityRank - 1 };
            }
          }
          return p;
        });

        people.set(updated);
      },
    );

    const manualAssign = action<{
      spotNumber: string;
      personName: string;
      date: string;
    }>(({ spotNumber: rawSpot, personName, date }) => {
      const spotNumber = rawSpot.trim().replace(/^#/, "");
      const curAllocs = [...allocations.get()];
      const curReqs = [...requests.get()];

      // Identify the displaced person from allocations
      const displacedNames: string[] = [];
      for (const a of curAllocs) {
        if (a.spotNumber === spotNumber && a.date === date && a.personName !== personName) {
          displacedNames.push(a.personName);
        }
      }

      // Remove existing allocation for this person on this date
      let updatedAllocs = curAllocs.filter(
        (a: Allocation) => !(a.personName === personName && a.date === date),
      );
      // Remove existing allocation for this spot on this date
      updatedAllocs = updatedAllocs.filter(
        (a: Allocation) => !(a.spotNumber === spotNumber && a.date === date),
      );

      // Cancel related requests: the assignee's prior request AND
      // the displaced person's request
      const updatedReqs = curReqs.map((r: SpotRequest) => {
        // Cancel the new assignee's prior allocated request for this date
        if (r.personName === personName && r.date === date && r.status === "allocated") {
          return { ...r, status: "cancelled" as RequestStatus };
        }
        // Cancel the displaced person's allocated request for this date
        if (
          r.date === date &&
          r.status === "allocated" &&
          displacedNames.includes(r.personName)
        ) {
          return { ...r, status: "cancelled" as RequestStatus };
        }
        return r;
      });

      updatedAllocs.push({
        spotNumber,
        date,
        personName,
        autoAllocated: false,
      });

      updatedReqs.push({
        personName,
        date,
        status: "allocated" as RequestStatus,
        assignedSpot: spotNumber,
      });

      allocations.set(updatedAllocs);
      requests.set(updatedReqs);
      manualAssignPersonField.set("");
    });

    const adminCancelAllocation = action<{
      spotNumber: string;
      date: string;
    }>(({ spotNumber: rawSpot, date }) => {
      const spotNumber = rawSpot.trim().replace(/^#/, "");
      const curAllocs = [...allocations.get()];
      const alloc = curAllocs.find(
        (a: Allocation) => a.spotNumber === spotNumber && a.date === date,
      );
      if (!alloc) return;

      allocations.set(
        curAllocs.filter(
          (a: Allocation) => !(a.spotNumber === spotNumber && a.date === date),
        ),
      );

      const curReqs = [...requests.get()];
      requests.set(
        curReqs.map((r: SpotRequest) =>
          r.personName === alloc.personName &&
          r.date === date &&
          r.assignedSpot === spotNumber &&
          r.status === "allocated"
            ? { ...r, status: "cancelled" as RequestStatus }
            : r
        ),
      );
    });

    // ============================================================
    // Computed values
    // ============================================================

    const currentPersonIsAdmin = computed(() => {
      const cur = currentUser.get();
      if (!cur) return false;
      const person = people.get().find((p: Person) => p.name === cur);
      return person ? !!person.isAdmin : false;
    });

    const spotCount = computed(() => spots.get().filter(() => true).length);

    const identityState = computed(() => {
      const cur = currentUser.get();
      const ppl = people.get();
      if (ppl.filter(() => true).length === 0) return "no-people";
      if (!cur || !ppl.some((p: Person) => p.name === cur)) return "select";
      return "selected";
    });

    // Combined tab-visibility computeds: avoids bare computed proxies in JSX && chains
    const showTodayTab = computed(() =>
      activeTab.get() === "today" &&
      identityState === "selected" &&
      spotCount > 0
    );
    const showWeekTab = computed(() =>
      activeTab.get() === "week" &&
      identityState === "selected" &&
      spotCount > 0
    );
    const showNoSpotsMessage = computed(() =>
      identityState === "selected" &&
      spotCount === 0
    );
    const showManageTab = computed(() =>
      (activeTab.get() === "manage" && currentPersonIsAdmin === true) ||
      identityState === "no-people"
    );

    const myTodayAllocation = computed(() => {
      const cur = currentUser.get();
      if (!cur) return null;
      const alloc = allocations
        .get()
        .find((a: Allocation) => a.personName === cur && a.date === todayDate);
      return alloc || null;
    });

    const myTodayRequest = computed(() => {
      const cur = currentUser.get();
      if (!cur) return null;
      const reqs = requests.get().filter(
        (r: SpotRequest) =>
          r.personName === cur &&
          r.date === todayDate &&
          r.status !== "cancelled",
      );
      return reqs.length > 0 ? reqs[reqs.length - 1] : null;
    });

    const allSpotsFullToday = computed(() => {
      const allSpots = spots.get();
      const todayAllocs = allocations
        .get()
        .filter((a: Allocation) => a.date === todayDate);
      return (
        allSpots.filter(() => true).length > 0 &&
        todayAllocs.length >= allSpots.filter(() => true).length
      );
    });

    const todayAllocations = computed(() =>
      allocations.get().filter((a: Allocation) => a.date === todayDate)
    );

    // For My Requests tab
    const myRequests = computed(() => {
      const cur = currentUser.get();
      return requests
        .get()
        .filter((r: SpotRequest) => r.personName === cur);
    });

    const hasMyRequests = computed(
      () => myRequests.filter(() => true).length > 0,
    );

    // For Manage tab - sorted people
    const sortedPeople = computed(() => {
      const ppl = [...people.get()];
      return ppl.sort(
        (a: Person, b: Person) => a.priorityRank - b.priorityRank,
      );
    });

    const peopleCount = computed(
      () => people.get().filter(() => true).length,
    );

    // Separate computed for Manage tab spots list to avoid reactive proxy
    // conflicts with sortedPeople.map() in the same conditional branch.
    const manageSpots = computed(() => [...spots.get()]);

    // ============================================================
    // UI
    // ============================================================

    return {
      [NAME]: "Parking Coordinator",
      [UI]: (
        <ct-screen>
          {/* Header */}
          <ct-vstack slot="header" gap="1" style="padding: 0.5rem 1rem;">
            <ct-hstack justify="between" align="center">
              <ct-heading level={4}>Parking Coordinator</ct-heading>
              {identityState === "selected"
                ? (
                  <ct-select
                    $value={currentUser}
                    items={people.map((p: Person) => ({
                      label: p.name,
                      value: p.name,
                    }))}
                    style="max-width: 160px; font-size: 0.875rem;"
                  />
                )
                : null}
            </ct-hstack>

            {/* Tab bar */}
            {identityState === "selected"
              ? (
                <ct-hstack gap="1">
                  <ct-button
                    variant={activeTab.get() === "today"
                      ? "primary"
                      : "secondary"}
                    onClick={() => activeTab.set("today")}
                    style="flex: 1;"
                  >
                    Today
                  </ct-button>
                  <ct-button
                    variant={activeTab.get() === "week"
                      ? "primary"
                      : "secondary"}
                    onClick={() => activeTab.set("week")}
                    style="flex: 1;"
                  >
                    Week
                  </ct-button>
                  <ct-button
                    variant={activeTab.get() === "requests"
                      ? "primary"
                      : "secondary"}
                    onClick={() => activeTab.set("requests")}
                    style="flex: 1;"
                  >
                    My Requests
                  </ct-button>
                  {currentPersonIsAdmin === true
                    ? (
                      <ct-button
                        variant={activeTab.get() === "manage"
                          ? "primary"
                          : "secondary"}
                        onClick={() => activeTab.set("manage")}
                        style="flex: 1;"
                      >
                        Manage
                      </ct-button>
                    )
                    : null}
                </ct-hstack>
              )
              : null}
            {/* Bootstrap setup tab when no people exist */}
            {identityState === "no-people"
              ? (
                <ct-hstack gap="1">
                  <ct-button variant="primary" style="flex: 1;">
                    Setup
                  </ct-button>
                </ct-hstack>
              )
              : null}
          </ct-vstack>

          {/* Main content */}
          <ct-vscroll flex showScrollbar fadeEdges>
            <ct-vstack gap="2" style="padding: 1rem;">
              {/* === Identity selection screen === */}
              {identityState === "select"
                ? (
                  <ct-vstack gap="2">
                    <ct-heading level={5}>Who are you?</ct-heading>
                    {people.map((person: Person) => (
                      <ct-card>
                        <ct-hstack
                          gap="2"
                          align="center"
                          onClick={() =>
                            selectUser.send({ name: person.name })}
                          style="cursor: pointer;"
                        >
                          <span style={{ fontWeight: "500" }}>
                            {person.name}
                          </span>
                          <span
                            style={{
                              fontSize: "0.75rem",
                              color: "var(--ct-color-gray-500, #6b7280)",
                            }}
                          >
                            {person.commuteMode}
                          </span>
                        </ct-hstack>
                      </ct-card>
                    ))}
                  </ct-vstack>
                )
                : null}

              {/* === No people empty state (bootstrap) === */}
              {identityState === "no-people"
                ? (
                  <ct-vstack gap="2">
                    <ct-card>
                      <div
                        style={{
                          textAlign: "center",
                          padding: "1rem",
                          color: "var(--ct-color-gray-500, #6b7280)",
                        }}
                      >
                        No team members yet. Use the forms below to add people
                        and parking spots to get started.
                      </div>
                    </ct-card>
                  </ct-vstack>
                )
                : null}

              {/* === No spots empty state === */}
              {showNoSpotsMessage
                ? (
                  <div
                    style={{
                      textAlign: "center",
                      padding: "2rem",
                      color: "var(--ct-color-gray-500, #6b7280)",
                    }}
                  >
                    {currentPersonIsAdmin
                      ? "No parking spots configured yet. Go to Manage to add spots."
                      : "No parking spots configured yet. Ask an admin to set up the system."}
                  </div>
                )
                : null}

              {/* ===== TODAY TAB ===== */}
              {showTodayTab
                ? (
                  <ct-vstack gap="2">
                    {/* My Status Banner */}
                    <ct-card
                      style={`background: ${
                        myTodayAllocation
                          ? "var(--ct-color-green-50, #f0fdf4)"
                          : "var(--ct-color-gray-50, #f9fafb)"
                      };`}
                    >
                      <ct-vstack gap="1">
                        <span style={{ fontWeight: "600", fontSize: "1rem" }}>
                          {myTodayAllocation
                            ? computed(
                                () =>
                                  `You have Spot #${myTodayAllocation.spotNumber} today`,
                              )
                            : myTodayRequest &&
                                myTodayRequest.status === "denied"
                            ? "No spots are available today."
                            : "You have no spot today"}
                        </span>

                        {/* Action buttons */}
                        {myTodayAllocation
                          ? (
                            <ct-vstack gap="1">
                              {confirmCancelDate.get() === todayDate
                                ? (
                                  <ct-hstack gap="1" align="center">
                                    <span style={{ fontSize: "0.875rem" }}>
                                      Cancel your spot for today?
                                    </span>
                                    <ct-button
                                      variant="primary"
                                      onClick={() =>
                                        cancelRequest.send({
                                          personName: currentUser.get(),
                                          date: todayDate,
                                        })}
                                    >
                                      Yes, cancel
                                    </ct-button>
                                    <ct-button
                                      variant="secondary"
                                      onClick={() =>
                                        confirmCancelDate.set("")}
                                    >
                                      Keep it
                                    </ct-button>
                                  </ct-hstack>
                                )
                                : (
                                  <ct-button
                                    variant="secondary"
                                    onClick={() =>
                                      confirmCancelDate.set(todayDate)}
                                  >
                                    Cancel My Request
                                  </ct-button>
                                )}
                            </ct-vstack>
                          )
                          : allSpotsFullToday === false
                          ? (
                            <ct-button
                              variant="primary"
                              onClick={() =>
                                requestSpot.send({
                                  personName: currentUser.get(),
                                  date: todayDate,
                                })}
                            >
                              Request a Spot
                            </ct-button>
                          )
                          : (
                            <span
                              style={{
                                fontSize: "0.875rem",
                                color: "var(--ct-color-gray-500, #6b7280)",
                              }}
                            >
                              All spots are taken. Check back if a spot opens
                              up.
                            </span>
                          )}
                      </ct-vstack>
                    </ct-card>

                    {/* Spot grid */}
                    <ct-heading level={5}>Spots</ct-heading>
                    {spots.map((spot: ParkingSpot) => {
                      const alloc = computed(() =>
                        todayAllocations.find(
                          (a: Allocation) =>
                            a.spotNumber === spot.spotNumber,
                        )
                      );
                      const isFree = computed(() => !alloc);
                      const isManual = computed(
                        () => alloc && !alloc.autoAllocated,
                      );

                      return (
                        <ct-card
                          style={`border-left: 4px solid ${
                            isFree
                              ? "var(--ct-color-green-500, #22c55e)"
                              : "var(--ct-color-blue-500, #3b82f6)"
                          }; margin-bottom: 0.5rem;`}
                        >
                          <ct-hstack gap="2" align="center">
                            <ct-vstack gap="0" style="flex: 1;">
                              <span
                                style={{
                                  fontWeight: "600",
                                  fontSize: "1.1rem",
                                }}
                              >
                                #{spot.spotNumber}
                              </span>
                              {spot.label
                                ? (
                                  <span
                                    style={{
                                      fontSize: "0.75rem",
                                      color:
                                        "var(--ct-color-gray-500, #6b7280)",
                                    }}
                                  >
                                    {spot.label}
                                  </span>
                                )
                                : null}
                            </ct-vstack>
                            <span
                              style={{
                                fontWeight: "500",
                                color: isFree
                                  ? "var(--ct-color-green-600, #16a34a)"
                                  : "var(--ct-color-gray-700, #374151)",
                              }}
                            >
                              {isFree
                                ? "Free"
                                : alloc
                                ? alloc.personName
                                : ""}
                            </span>
                            {isManual
                              ? (
                                <span
                                  style={{
                                    fontSize: "0.625rem",
                                    backgroundColor:
                                      "var(--ct-color-yellow-100, #fef9c3)",
                                    color:
                                      "var(--ct-color-yellow-800, #854d0e)",
                                    padding: "0.125rem 0.375rem",
                                    borderRadius: "4px",
                                    fontWeight: "600",
                                  }}
                                >
                                  M
                                </span>
                              )
                              : null}
                          </ct-hstack>
                        </ct-card>
                      );
                    })}
                  </ct-vstack>
                )
                : null}

              {/* ===== WEEK TAB ===== */}
              {showWeekTab
                ? (
                  <ct-vstack gap="1">
                    <ct-heading level={5}>Week Overview</ct-heading>
                    {weekDates.map((date: string, dateIdx: number) => {
                      const isExpanded = computed(
                        () => expandedDay.get() === date,
                      );
                      const dayAllocs = computed(() =>
                        allocations
                          .get()
                          .filter((a: Allocation) => a.date === date)
                      );
                      const myAlloc = computed(() =>
                        dayAllocs.find(
                          (a: Allocation) =>
                            a.personName === currentUser.get(),
                        )
                      );
                      const myReq = computed(() => {
                        const reqs = requests
                          .get()
                          .filter(
                            (r: SpotRequest) =>
                              r.personName === currentUser.get() &&
                              r.date === date &&
                              r.status !== "cancelled",
                          );
                        return reqs.length > 0
                          ? reqs[reqs.length - 1]
                          : null;
                      });
                      const freeCount = computed(
                        () =>
                          spots.get().filter(() => true).length -
                          dayAllocs.filter(() => true).length,
                      );
                      const daySpotTotal = computed(
                        () => spots.get().filter(() => true).length,
                      );

                      return (
                        <ct-card
                          style={`margin-bottom: 0.25rem; ${
                            dateIdx === 0
                              ? "border-left: 3px solid var(--ct-color-blue-500, #3b82f6);"
                              : ""
                          }`}
                        >
                          <ct-vstack gap="1">
                            <ct-hstack
                              gap="2"
                              align="center"
                              onClick={() =>
                                expandedDay.set(
                                  expandedDay.get() === date ? "" : date,
                                )}
                              style="cursor: pointer;"
                            >
                              <ct-vstack gap="0" style="flex: 1;">
                                <span style={{ fontWeight: "500" }}>
                                  {dateIdx === 0 ? "Today " : ""}
                                  {formatDateLabel(date)}
                                </span>
                                <span
                                  style={{
                                    fontSize: "0.75rem",
                                    color:
                                      "var(--ct-color-gray-500, #6b7280)",
                                  }}
                                >
                                  {freeCount} free of {daySpotTotal}
                                </span>
                              </ct-vstack>
                              {myAlloc
                                ? (
                                  <span
                                    style={{
                                      fontSize: "0.75rem",
                                      backgroundColor:
                                        "var(--ct-color-green-100, #dcfce7)",
                                      color:
                                        "var(--ct-color-green-800, #166534)",
                                      padding: "0.125rem 0.5rem",
                                      borderRadius: "4px",
                                      fontWeight: "600",
                                    }}
                                  >
                                    You: #{myAlloc.spotNumber}
                                  </span>
                                )
                                : myReq && myReq.status === "denied"
                                ? (
                                  <span
                                    style={{
                                      fontSize: "0.75rem",
                                      backgroundColor:
                                        "var(--ct-color-gray-100, #f3f4f6)",
                                      color:
                                        "var(--ct-color-gray-500, #6b7280)",
                                      padding: "0.125rem 0.5rem",
                                      borderRadius: "4px",
                                    }}
                                  >
                                    No spot
                                  </span>
                                )
                                : null}
                            </ct-hstack>

                            {/* Expanded detail */}
                            {isExpanded
                              ? (
                                <ct-vstack
                                  gap="1"
                                  style="padding-top: 0.5rem;"
                                >
                                  {spots.map((spot: ParkingSpot) => {
                                    const spotAlloc = computed(() =>
                                      dayAllocs.find(
                                        (a: Allocation) =>
                                          a.spotNumber === spot.spotNumber,
                                      )
                                    );
                                    const spotFree = computed(
                                      () => !spotAlloc,
                                    );
                                    const spotManual = computed(
                                      () =>
                                        spotAlloc &&
                                        !spotAlloc.autoAllocated,
                                    );

                                    return (
                                      <ct-card
                                        style={`border-left: 4px solid ${
                                          spotFree
                                            ? "var(--ct-color-green-500, #22c55e)"
                                            : "var(--ct-color-blue-500, #3b82f6)"
                                        }; margin-bottom: 0.25rem;`}
                                      >
                                        <ct-hstack gap="2" align="center">
                                          <span
                                            style={{
                                              fontWeight: "600",
                                              minWidth: "40px",
                                            }}
                                          >
                                            #{spot.spotNumber}
                                          </span>
                                          <span
                                            style={{
                                              flex: "1",
                                              color: spotFree
                                                ? "var(--ct-color-green-600, #16a34a)"
                                                : "var(--ct-color-gray-700, #374151)",
                                            }}
                                          >
                                            {spotFree
                                              ? "Free"
                                              : spotAlloc
                                              ? spotAlloc.personName
                                              : ""}
                                          </span>
                                          {spotManual
                                            ? (
                                              <span
                                                style={{
                                                  fontSize: "0.625rem",
                                                  backgroundColor:
                                                    "var(--ct-color-yellow-100, #fef9c3)",
                                                  color:
                                                    "var(--ct-color-yellow-800, #854d0e)",
                                                  padding:
                                                    "0.125rem 0.375rem",
                                                  borderRadius: "4px",
                                                  fontWeight: "600",
                                                }}
                                              >
                                                M
                                              </span>
                                            )
                                            : null}
                                        </ct-hstack>
                                      </ct-card>
                                    );
                                  })}

                                  {/* Request / Cancel */}
                                  {myAlloc
                                    ? (
                                      <ct-button
                                        variant="secondary"
                                        onClick={() =>
                                          cancelRequest.send({
                                            personName: currentUser.get(),
                                            date,
                                          })}
                                      >
                                        Cancel My Request
                                      </ct-button>
                                    )
                                    : freeCount > 0
                                    ? (
                                      <ct-button
                                        variant="primary"
                                        onClick={() =>
                                          requestSpot.send({
                                            personName: currentUser.get(),
                                            date,
                                          })}
                                      >
                                        Request for {formatDateLabel(date)}
                                      </ct-button>
                                    )
                                    : (
                                      <span
                                        style={{
                                          fontSize: "0.875rem",
                                          color:
                                            "var(--ct-color-gray-500, #6b7280)",
                                          textAlign: "center",
                                        }}
                                      >
                                        No spots available
                                      </span>
                                    )}

                                  {/* Admin manual assign */}
                                  {currentPersonIsAdmin
                                    ? (
                                      <ct-vstack
                                        gap="1"
                                        style="border-top: 1px solid var(--ct-color-gray-200, #e5e7eb); padding-top: 0.5rem; margin-top: 0.25rem;"
                                      >
                                        <span
                                          style={{
                                            fontSize: "0.75rem",
                                            fontWeight: "600",
                                            color:
                                              "var(--ct-color-gray-500, #6b7280)",
                                          }}
                                        >
                                          Admin: Manual Assign
                                        </span>
                                        <ct-hstack gap="1" align="end">
                                          <ct-select
                                            $value={manualAssignPersonField}
                                            items={people.map(
                                              (p: Person) => ({
                                                label: p.name,
                                                value: p.name,
                                              }),
                                            )}
                                            style="flex: 1;"
                                          />
                                          <ct-select
                                            $value={manualAssignSpotField}
                                            items={spots.map(
                                              (s: ParkingSpot) => ({
                                                label: `#${s.spotNumber}`,
                                                value: s.spotNumber,
                                              }),
                                            )}
                                            style="flex: 1;"
                                          />
                                          <ct-button
                                            variant="primary"
                                            onClick={() => {
                                              const p =
                                                manualAssignPersonField.get();
                                              const s =
                                                manualAssignSpotField.get();
                                              if (p && s) {
                                                manualAssign.send({
                                                  spotNumber: s,
                                                  personName: p,
                                                  date,
                                                });
                                              }
                                            }}
                                          >
                                            Assign
                                          </ct-button>
                                        </ct-hstack>
                                      </ct-vstack>
                                    )
                                    : null}
                                </ct-vstack>
                              )
                              : null}
                          </ct-vstack>
                        </ct-card>
                      );
                    })}
                  </ct-vstack>
                )
                : null}

              {/* ===== MY REQUESTS TAB ===== */}
              {activeTab.get() === "requests" &&
                  identityState === "selected"
                ? (
                  <ct-vstack gap="2">
                    <ct-heading level={5}>My Requests</ct-heading>
                    {hasMyRequests === false
                      ? (
                        <div
                          style={{
                            textAlign: "center",
                            padding: "2rem",
                            color: "var(--ct-color-gray-500, #6b7280)",
                          }}
                        >
                          You haven't made any requests yet.
                        </div>
                      )
                      : null}

                    {myRequests.map((req: SpotRequest) => {
                      const isFuture = req.date >= todayDate;
                      const canCancel =
                        isFuture &&
                        (req.status === "allocated" ||
                          req.status === "pending");
                      const statusColor = computed(() => {
                        const colors: Record<string, string> = {
                          allocated: "var(--ct-color-green-600, #16a34a)",
                          denied: "var(--ct-color-red-500, #ef4444)",
                          pending: "var(--ct-color-yellow-600, #ca8a04)",
                          cancelled: "var(--ct-color-gray-400, #9ca3af)",
                        };
                        return (
                          colors[req.status] ||
                          "var(--ct-color-gray-500, #6b7280)"
                        );
                      });

                      return (
                        <ct-card>
                          <ct-hstack gap="2" align="center">
                            <ct-vstack gap="0" style="flex: 1;">
                              <span style={{ fontWeight: "500" }}>
                                {formatDateLabel(req.date)}
                              </span>
                              {req.assignedSpot
                                ? (
                                  <span style={{ fontSize: "0.875rem" }}>
                                    Spot #{req.assignedSpot}
                                  </span>
                                )
                                : null}
                            </ct-vstack>
                            <span
                              style={{
                                fontSize: "0.75rem",
                                fontWeight: "600",
                                color: statusColor,
                                textTransform: "capitalize",
                              }}
                            >
                              {req.status}
                            </span>
                            {canCancel
                              ? (
                                <ct-button
                                  variant="ghost"
                                  onClick={() =>
                                    cancelRequest.send({
                                      personName: currentUser.get(),
                                      date: req.date,
                                    })}
                                >
                                  Cancel
                                </ct-button>
                              )
                              : null}
                          </ct-hstack>
                        </ct-card>
                      );
                    })}
                  </ct-vstack>
                )
                : null}

              {/* ===== MANAGE TAB (Admin or bootstrap) ===== */}
              {showManageTab
                ? (
                  <ct-vstack gap="3">
                    {/* --- PEOPLE section --- */}
                    <ct-vstack gap="2">
                      <ct-heading level={5}>People</ct-heading>
                      {sortedPeople.map((person: Person) => {
                        const isEditing = computed(
                          () => editingPersonId.get() === person.name,
                        );
                        const isConfirmingRemove = computed(
                          () =>
                            confirmRemovePerson.get() === person.name,
                        );

                        return (
                          <ct-card>
                            {isEditing
                              ? (
                                <ct-vstack gap="1">
                                  <span style={{ fontWeight: "600" }}>
                                    {person.name}
                                  </span>
                                  <ct-input
                                    $value={editPersonEmailField}
                                    placeholder="Email"
                                  />
                                  <ct-select
                                    $value={editPersonCommuteField}
                                    items={[
                                      { label: "Drive", value: "drive" },
                                      {
                                        label: "Transit",
                                        value: "transit",
                                      },
                                      { label: "Bike", value: "bike" },
                                      { label: "WFH", value: "wfh" },
                                      { label: "Other", value: "other" },
                                    ]}
                                  />
                                  <ct-select
                                    $value={editPersonDefaultSpotField}
                                    items={[
                                      { label: "(none)", value: "" },
                                      ...spots.map(
                                        (s: ParkingSpot) => ({
                                          label: `#${s.spotNumber}`,
                                          value: s.spotNumber,
                                        }),
                                      ),
                                    ]}
                                  />
                                  <ct-checkbox
                                    $checked={editPersonIsAdminField}
                                  >
                                    Admin
                                  </ct-checkbox>
                                  <ct-hstack gap="1">
                                    <ct-button
                                      variant="primary"
                                      onClick={() =>
                                        editPerson.send({
                                          name: person.name,
                                          email:
                                            editPersonEmailField.get(),
                                          commuteMode:
                                            editPersonCommuteField.get(),
                                          defaultSpot:
                                            editPersonDefaultSpotField.get(),
                                          isAdmin:
                                            editPersonIsAdminField.get(),
                                        })}
                                    >
                                      Save
                                    </ct-button>
                                    <ct-button
                                      variant="secondary"
                                      onClick={() =>
                                        editingPersonId.set("")}
                                    >
                                      Cancel
                                    </ct-button>
                                  </ct-hstack>
                                </ct-vstack>
                              )
                              : (
                                <ct-vstack gap="1">
                                  <ct-hstack gap="2" align="center">
                                    <span
                                      style={{
                                        fontSize: "0.75rem",
                                        fontWeight: "600",
                                        color:
                                          "var(--ct-color-gray-400, #9ca3af)",
                                        minWidth: "24px",
                                      }}
                                    >
                                      #{person.priorityRank}
                                    </span>
                                    <ct-vstack gap="0" style="flex: 1;">
                                      <span style={{ fontWeight: "500" }}>
                                        {person.name}
                                        {person.isAdmin
                                          ? (
                                            <span
                                              style={{
                                                fontSize: "0.625rem",
                                                marginLeft: "0.25rem",
                                                color:
                                                  "var(--ct-color-blue-500, #3b82f6)",
                                              }}
                                            >
                                              Admin
                                            </span>
                                          )
                                          : null}
                                      </span>
                                      <span
                                        style={{
                                          fontSize: "0.75rem",
                                          color:
                                            "var(--ct-color-gray-500, #6b7280)",
                                        }}
                                      >
                                        {person.commuteMode}
                                        {person.defaultSpot
                                          ? ` | Default: #${person.defaultSpot}`
                                          : ""}
                                      </span>
                                    </ct-vstack>

                                    <ct-vstack gap="0">
                                      {person.priorityRank > 1
                                        ? (
                                          <ct-button
                                            variant="ghost"
                                            onClick={() =>
                                              reorderPriority.send({
                                                name: person.name,
                                                newRank:
                                                  person.priorityRank - 1,
                                              })}
                                          >
                                            Up
                                          </ct-button>
                                        )
                                        : null}
                                      {person.priorityRank < peopleCount
                                        ? (
                                          <ct-button
                                            variant="ghost"
                                            onClick={() =>
                                              reorderPriority.send({
                                                name: person.name,
                                                newRank:
                                                  person.priorityRank + 1,
                                              })}
                                          >
                                            Down
                                          </ct-button>
                                        )
                                        : null}
                                    </ct-vstack>

                                    <ct-button
                                      variant="ghost"
                                      onClick={() => {
                                        editingPersonId.set(person.name);
                                        editPersonEmailField.set(
                                          person.email,
                                        );
                                        editPersonCommuteField.set(
                                          person.commuteMode || "drive",
                                        );
                                        editPersonDefaultSpotField.set(
                                          person.defaultSpot || "",
                                        );
                                        editPersonIsAdminField.set(
                                          !!person.isAdmin,
                                        );
                                      }}
                                    >
                                      Edit
                                    </ct-button>
                                    <ct-button
                                      variant="ghost"
                                      onClick={() =>
                                        confirmRemovePerson.set(
                                          person.name,
                                        )}
                                    >
                                      Remove
                                    </ct-button>
                                  </ct-hstack>

                                  {isConfirmingRemove
                                    ? (
                                      <ct-hstack gap="1" align="center">
                                        <span
                                          style={{ fontSize: "0.875rem" }}
                                        >
                                          Remove {person.name}? Future
                                          allocations will be cancelled.
                                        </span>
                                        <ct-button
                                          variant="primary"
                                          onClick={() =>
                                            removePerson.send({
                                              name: person.name,
                                            })}
                                        >
                                          Yes, Remove
                                        </ct-button>
                                        <ct-button
                                          variant="secondary"
                                          onClick={() =>
                                            confirmRemovePerson.set("")}
                                        >
                                          Cancel
                                        </ct-button>
                                      </ct-hstack>
                                    )
                                    : null}
                                </ct-vstack>
                              )}
                          </ct-card>
                        );
                      })}

                      {/* Add person form */}
                      {addPersonFormOpen.get()
                        ? (
                          <ct-card>
                            <ct-vstack gap="1">
                              <ct-heading level={6}>Add Person</ct-heading>
                              <ct-input
                                $value={newPersonName}
                                placeholder="Name"
                              />
                              <ct-input
                                $value={newPersonEmail}
                                placeholder="Email"
                              />
                              <ct-select
                                $value={newPersonCommute}
                                items={[
                                  { label: "Drive", value: "drive" },
                                  { label: "Transit", value: "transit" },
                                  { label: "Bike", value: "bike" },
                                  { label: "WFH", value: "wfh" },
                                  { label: "Other", value: "other" },
                                ]}
                              />
                              <ct-select
                                $value={newPersonDefaultSpot}
                                items={[
                                  { label: "(none)", value: "" },
                                  ...spots.map(
                                    (s: ParkingSpot) => ({
                                      label: `#${s.spotNumber}`,
                                      value: s.spotNumber,
                                    }),
                                  ),
                                ]}
                              />
                              <ct-hstack gap="1">
                                <ct-button
                                  variant="primary"
                                  onClick={() =>
                                    addPerson.send({
                                      name: newPersonName.get(),
                                      email: newPersonEmail.get(),
                                      commuteMode: newPersonCommute.get(),
                                      defaultSpot:
                                        newPersonDefaultSpot.get(),
                                    })}
                                >
                                  Save
                                </ct-button>
                                <ct-button
                                  variant="secondary"
                                  onClick={() =>
                                    addPersonFormOpen.set(false)}
                                >
                                  Cancel
                                </ct-button>
                              </ct-hstack>
                            </ct-vstack>
                          </ct-card>
                        )
                        : (
                          <ct-button
                            variant="secondary"
                            onClick={() => addPersonFormOpen.set(true)}
                          >
                            Add Person
                          </ct-button>
                        )}
                    </ct-vstack>

                    {/* --- SPOTS section --- */}
                    <ct-vstack gap="2">
                      <ct-heading level={5}>Parking Spots</ct-heading>
                      {manageSpots.map((spot: ParkingSpot) => {
                        const isEditingSpot = computed(
                          () => editingSpotId.get() === spot.spotNumber,
                        );
                        const isConfirmingRemoveSpot = computed(
                          () =>
                            confirmRemoveSpot.get() === spot.spotNumber,
                        );
                        const futureAllocCount = computed(
                          () =>
                            allocations
                              .get()
                              .filter(
                                (a: Allocation) =>
                                  a.spotNumber === spot.spotNumber &&
                                  a.date >= todayDate,
                              )
                              .filter(() => true).length,
                        );

                        return (
                          <ct-card>
                            {isEditingSpot
                              ? (
                                <ct-vstack gap="1">
                                  <span style={{ fontWeight: "600" }}>
                                    #{spot.spotNumber}
                                  </span>
                                  <ct-input
                                    $value={editSpotLabelField}
                                    placeholder="Label (optional)"
                                  />
                                  <ct-input
                                    $value={editSpotNotesField}
                                    placeholder="Notes (optional)"
                                  />
                                  <ct-hstack gap="1">
                                    <ct-button
                                      variant="primary"
                                      onClick={() =>
                                        editSpot.send({
                                          spotNumber: spot.spotNumber,
                                          label: editSpotLabelField.get(),
                                          notes: editSpotNotesField.get(),
                                        })}
                                    >
                                      Save
                                    </ct-button>
                                    <ct-button
                                      variant="secondary"
                                      onClick={() =>
                                        editingSpotId.set("")}
                                    >
                                      Cancel
                                    </ct-button>
                                  </ct-hstack>
                                </ct-vstack>
                              )
                              : (
                                <ct-vstack gap="1">
                                  <ct-hstack gap="2" align="center">
                                    <ct-vstack gap="0" style="flex: 1;">
                                      <span
                                        style={{ fontWeight: "600" }}
                                      >
                                        #{spot.spotNumber}
                                      </span>
                                      {spot.label
                                        ? (
                                          <span
                                            style={{
                                              fontSize: "0.875rem",
                                            }}
                                          >
                                            {spot.label}
                                          </span>
                                        )
                                        : null}
                                      {spot.notes
                                        ? (
                                          <span
                                            style={{
                                              fontSize: "0.75rem",
                                              color:
                                                "var(--ct-color-gray-500, #6b7280)",
                                            }}
                                          >
                                            {spot.notes}
                                          </span>
                                        )
                                        : null}
                                    </ct-vstack>
                                    <ct-button
                                      variant="ghost"
                                      onClick={() => {
                                        editingSpotId.set(
                                          spot.spotNumber,
                                        );
                                        editSpotLabelField.set(
                                          spot.label || "",
                                        );
                                        editSpotNotesField.set(
                                          spot.notes || "",
                                        );
                                      }}
                                    >
                                      Edit
                                    </ct-button>
                                    <ct-button
                                      variant="ghost"
                                      onClick={() =>
                                        confirmRemoveSpot.set(
                                          spot.spotNumber,
                                        )}
                                    >
                                      Remove
                                    </ct-button>
                                  </ct-hstack>

                                  {isConfirmingRemoveSpot
                                    ? (
                                      <ct-vstack gap="1">
                                        {futureAllocCount > 0
                                          ? (
                                            <span
                                              style={{
                                                fontSize: "0.875rem",
                                                color:
                                                  "var(--ct-color-yellow-700, #a16207)",
                                              }}
                                            >
                                              This spot has{" "}
                                              {futureAllocCount}{" "}
                                              upcoming allocation(s). They
                                              will be cancelled.
                                            </span>
                                          )
                                          : null}
                                        <ct-hstack gap="1">
                                          <ct-button
                                            variant="primary"
                                            onClick={() =>
                                              removeSpot.send({
                                                spotNumber:
                                                  spot.spotNumber,
                                              })}
                                          >
                                            Yes, Remove
                                          </ct-button>
                                          <ct-button
                                            variant="secondary"
                                            onClick={() =>
                                              confirmRemoveSpot.set("")}
                                          >
                                            Cancel
                                          </ct-button>
                                        </ct-hstack>
                                      </ct-vstack>
                                    )
                                    : null}
                                </ct-vstack>
                              )}
                          </ct-card>
                        );
                      })}

                      {/* Add spot form */}
                      {addSpotFormOpen.get()
                        ? (
                          <ct-card>
                            <ct-vstack gap="1">
                              <ct-heading level={6}>Add Spot</ct-heading>
                              <ct-input
                                $value={newSpotNumber}
                                placeholder="Spot number (e.g. 5)"
                              />
                              <ct-input
                                $value={newSpotLabel}
                                placeholder="Label (optional)"
                              />
                              <ct-input
                                $value={newSpotNotes}
                                placeholder="Notes (optional)"
                              />
                              <ct-hstack gap="1">
                                <ct-button
                                  variant="primary"
                                  onClick={() =>
                                    addSpot.send({
                                      spotNumber: newSpotNumber.get(),
                                      label: newSpotLabel.get(),
                                      notes: newSpotNotes.get(),
                                    })}
                                >
                                  Save
                                </ct-button>
                                <ct-button
                                  variant="secondary"
                                  onClick={() =>
                                    addSpotFormOpen.set(false)}
                                >
                                  Cancel
                                </ct-button>
                              </ct-hstack>
                            </ct-vstack>
                          </ct-card>
                        )
                        : (
                          <ct-button
                            variant="secondary"
                            onClick={() => addSpotFormOpen.set(true)}
                          >
                            Add Spot
                          </ct-button>
                        )}
                    </ct-vstack>
                  </ct-vstack>
                )
                : null}
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),
      spots,
      people,
      requests,
      allocations,
      currentUser,
      requestSpot,
      cancelRequest,
      selectUser,
      addSpot,
      editSpot,
      removeSpot,
      addPerson,
      editPerson,
      removePerson,
      reorderPriority,
      manualAssign,
      adminCancelAllocation,
    };
  },
);
