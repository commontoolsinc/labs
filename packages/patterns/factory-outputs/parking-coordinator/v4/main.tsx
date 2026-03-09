/// <cts-enable />
import {
  action,
  computed,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";
import type {
  Allocation,
  CommuteMode,
  ParkingCoordinatorInput,
  ParkingCoordinatorOutput,
  ParkingSpot,
  Person,
  RequestStatus,
  SpotRequest,
} from "./schemas.tsx";

// === Helpers ===

const getTodayDate = (): string => {
  const now = new Date();
  return now.toISOString().split("T")[0];
};

const getDateOffset = (baseDate: string, daysOffset: number): string => {
  const date = new Date(baseDate + "T00:00:00");
  date.setDate(date.getDate() + daysOffset);
  return date.toISOString().split("T")[0];
};

const formatDate = (dateStr: string): string => {
  const date = new Date(dateStr + "T00:00:00");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${days[date.getDay()]} ${months[date.getMonth()]} ${date.getDate()}`;
};

// === Auto-allocation Algorithm ===

/**
 * Runs auto-allocation for a person on a date.
 * Priority chain: (1) default spot, (2) spot preferences in order, (3) any available spot.
 * Returns the allocated spot number, or 0 if all spots taken.
 */
const autoAllocate = (
  person: Person,
  date: string,
  allSpots: readonly ParkingSpot[],
  existingAllocations: readonly Allocation[],
): number => {
  const dateAllocations = existingAllocations.filter((a) => a.date === date);
  const takenSpotNumbers = new Set(dateAllocations.map((a) => a.spotNumber));
  const availableSpots = allSpots.filter(
    (s) => !takenSpotNumbers.has(s.number),
  );

  if (availableSpots.length === 0) return 0;

  // 1. Try default spot
  if (person.defaultSpot && person.defaultSpot > 0) {
    const defaultAvailable = availableSpots.find(
      (s) => s.number === person.defaultSpot,
    );
    if (defaultAvailable) return defaultAvailable.number;
  }

  // 2. Try spot preferences in order
  const prefs = person.spotPreferences || [];
  for (const prefNum of prefs) {
    const prefAvailable = availableSpots.find((s) => s.number === prefNum);
    if (prefAvailable) return prefAvailable.number;
  }

  // 3. Any available spot (lowest number first)
  const sorted = [...availableSpots].sort((a, b) => a.number - b.number);
  return sorted[0].number;
};

// === UI Helpers ===

const getAllocForSpotDate = (
  spotNum: number,
  date: string,
  allocs: readonly Allocation[],
): Allocation | undefined => {
  return allocs.find(
    (a) => a.spotNumber === spotNum && a.date === date,
  );
};

const getPersonByEmail = (
  email: string,
  ppl: readonly Person[],
): Person | undefined => {
  return ppl.find((p) => p.email === email);
};

// === Pattern ===

export default pattern<ParkingCoordinatorInput, ParkingCoordinatorOutput>(
  ({ spots, people, requests, allocations }) => {
    const todayDate = getTodayDate();
    const adminMode = Writable.of(false);
    const viewMode = Writable.of("today"); // "today" | "week" | "requests"

    // UI form state
    const newPersonName = Writable.of("");
    const newPersonEmail = Writable.of("");
    const newPersonCommute = Writable.of("drive");
    const newSpotNumber = Writable.of("");
    const newSpotLabel = Writable.of("");
    const newSpotNotes = Writable.of("");
    const requestDate = Writable.of(todayDate);
    const requestPersonEmail = Writable.of("");
    const manualAllocPersonEmail = Writable.of("");
    const manualAllocDate = Writable.of(todayDate);
    const manualAllocSpotNumber = Writable.of("");

    // === Initialization ===

    const seedSpots = action(() => {
      if (spots.get().length === 0) {
        spots.set([
          { number: 1, label: "", notes: "" },
          { number: 5, label: "", notes: "" },
          { number: 12, label: "", notes: "" },
        ]);
      }
    });

    // === Team Member Actions ===

    const requestSpot = action<{ personEmail: string; date: string }>(
      ({ personEmail, date }) => {
        const currentPeople = people.get();
        const person = currentPeople.find((p) => p.email === personEmail);
        if (!person) return;

        // Cannot request past dates
        if (date < todayDate) return;

        // Check for duplicate active request
        const currentRequests = requests.get();
        const existingActive = currentRequests.find(
          (r) =>
            r.personEmail === personEmail &&
            r.date === date &&
            (r.status === "allocated" || r.status === "pending"),
        );
        if (existingActive) return;

        const currentSpots = spots.get();
        const currentAllocations = allocations.get();

        // Run auto-allocation
        const allocatedSpotNum = autoAllocate(
          person,
          date,
          currentSpots,
          currentAllocations,
        );

        if (allocatedSpotNum > 0) {
          // Allocated
          requests.push({
            personEmail,
            date,
            status: "allocated" as RequestStatus,
            assignedSpot: allocatedSpotNum,
            requestedAt: new Date().toISOString(),
          });
          allocations.push({
            spotNumber: allocatedSpotNum,
            date,
            personEmail,
            autoAllocated: true,
          });
        } else {
          // Denied
          requests.push({
            personEmail,
            date,
            status: "denied" as RequestStatus,
            assignedSpot: 0,
            requestedAt: new Date().toISOString(),
          });
        }
      },
    );

    const cancelRequest = action<{ personEmail: string; date: string }>(
      ({ personEmail, date }) => {
        const currentRequests = requests.get();
        const reqIdx = currentRequests.findIndex(
          (r) =>
            r.personEmail === personEmail &&
            r.date === date &&
            (r.status === "allocated" || r.status === "pending"),
        );
        if (reqIdx < 0) return;

        const req = currentRequests[reqIdx];

        // Update request status to cancelled
        const updatedRequests = currentRequests.map((r, i) =>
          i === reqIdx ? { ...r, status: "cancelled" as RequestStatus } : r
        );
        requests.set(updatedRequests);

        // Remove allocation if it existed
        if (req.assignedSpot && req.assignedSpot > 0) {
          const currentAllocations = allocations.get();
          const allocIdx = currentAllocations.findIndex(
            (a) =>
              a.personEmail === personEmail &&
              a.date === date &&
              a.spotNumber === req.assignedSpot,
          );
          if (allocIdx >= 0) {
            allocations.set(currentAllocations.toSpliced(allocIdx, 1));
          }
        }
      },
    );

    const retryRequest = action<{ personEmail: string; date: string }>(
      ({ personEmail, date }) => {
        const currentRequests = requests.get();
        const reqIdx = currentRequests.findIndex(
          (r) =>
            r.personEmail === personEmail &&
            r.date === date &&
            r.status === "denied",
        );
        if (reqIdx < 0) return;

        const currentPeople = people.get();
        const person = currentPeople.find((p) => p.email === personEmail);
        if (!person) return;

        const currentSpots = spots.get();
        const currentAllocations = allocations.get();

        const allocatedSpotNum = autoAllocate(
          person,
          date,
          currentSpots,
          currentAllocations,
        );

        if (allocatedSpotNum > 0) {
          const updatedRequests = currentRequests.map((r, i) =>
            i === reqIdx
              ? {
                ...r,
                status: "allocated" as RequestStatus,
                assignedSpot: allocatedSpotNum,
              }
              : r
          );
          requests.set(updatedRequests);
          allocations.push({
            spotNumber: allocatedSpotNum,
            date,
            personEmail,
            autoAllocated: true,
          });
        }
        // If still no spot, leave as denied
      },
    );

    // === Admin Actions ===

    const toggleAdmin = action(() => {
      adminMode.set(!adminMode.get());
    });

    const setViewMode = action<{ mode: string }>(({ mode }) => {
      viewMode.set(mode);
    });

    const addPerson = action<{
      name: string;
      email: string;
      commuteMode: string;
    }>(
      ({ name, email, commuteMode }) => {
        const trimmedName = name.trim();
        const trimmedEmail = email.trim();
        if (!trimmedName || !trimmedEmail) return;

        // Check email uniqueness
        const currentPeople = people.get();
        if (currentPeople.some((p) => p.email === trimmedEmail)) return;

        people.push({
          name: trimmedName,
          email: trimmedEmail,
          commuteMode: (commuteMode || "drive") as CommuteMode,
          spotPreferences: [],
          defaultSpot: 0,
        });

        newPersonName.set("");
        newPersonEmail.set("");
        newPersonCommute.set("drive");
      },
    );

    const removePerson = action<{ email: string }>(({ email }) => {
      const currentPeople = people.get();
      const personIdx = currentPeople.findIndex((p) => p.email === email);
      if (personIdx < 0) return;

      // Cancel future requests and free allocations
      const currentRequests = requests.get();
      const updatedRequests = currentRequests.map((r) => {
        if (
          r.personEmail === email &&
          r.date >= todayDate &&
          (r.status === "allocated" || r.status === "pending")
        ) {
          return { ...r, status: "cancelled" as RequestStatus };
        }
        return r;
      });
      requests.set(updatedRequests);

      // Remove future allocations
      const currentAllocations = allocations.get();
      allocations.set(
        currentAllocations.filter(
          (a) => !(a.personEmail === email && a.date >= todayDate),
        ),
      );

      // Remove person
      people.set(currentPeople.toSpliced(personIdx, 1));
    });

    const movePersonUp = action<{ email: string }>(({ email }) => {
      const currentPeople = people.get();
      const idx = currentPeople.findIndex((p) => p.email === email);
      if (idx <= 0) return;

      const updated = [...currentPeople];
      const temp = updated[idx - 1];
      updated[idx - 1] = updated[idx];
      updated[idx] = temp;
      people.set(updated);
    });

    const movePersonDown = action<{ email: string }>(({ email }) => {
      const currentPeople = people.get();
      const idx = currentPeople.findIndex((p) => p.email === email);
      if (idx < 0 || idx >= currentPeople.length - 1) return;

      const updated = [...currentPeople];
      const temp = updated[idx + 1];
      updated[idx + 1] = updated[idx];
      updated[idx] = temp;
      people.set(updated);
    });

    const setDefaultSpot = action<{ email: string; spotNumber: number }>(
      ({ email, spotNumber }) => {
        const currentPeople = people.get();
        const updated = currentPeople.map((p) =>
          p.email === email ? { ...p, defaultSpot: spotNumber } : p
        );
        people.set(updated);
      },
    );

    const setSpotPreferences = action<{
      email: string;
      preferences: number[];
    }>(
      ({ email, preferences }) => {
        const currentPeople = people.get();
        const updated = currentPeople.map((p) =>
          p.email === email ? { ...p, spotPreferences: preferences } : p
        );
        people.set(updated);
      },
    );

    const addSpot = action<{ number: number; label: string; notes: string }>(
      ({ number: spotNum, label, notes }) => {
        if (!spotNum || spotNum <= 0) return;

        // Check uniqueness
        const currentSpots = spots.get();
        if (currentSpots.some((s) => s.number === spotNum)) return;

        spots.push({
          number: spotNum,
          label: label || "",
          notes: notes || "",
        });

        newSpotNumber.set("");
        newSpotLabel.set("");
        newSpotNotes.set("");
      },
    );

    const removeSpot = action<{ spotNumber: number }>(({ spotNumber }) => {
      const currentSpots = spots.get();
      const spotIdx = currentSpots.findIndex((s) => s.number === spotNumber);
      if (spotIdx < 0) return;

      // Cancel future allocations for this spot
      const currentAllocations = allocations.get();
      const futureAllocsForSpot = currentAllocations.filter(
        (a) => a.spotNumber === spotNumber && a.date >= todayDate,
      );

      // Update requests for cancelled allocations
      if (futureAllocsForSpot.length > 0) {
        const cancelEmails = new Set(
          futureAllocsForSpot.map((a) => `${a.personEmail}|${a.date}`),
        );
        const currentRequests = requests.get();
        const updatedRequests = currentRequests.map((r) => {
          if (
            cancelEmails.has(`${r.personEmail}|${r.date}`) &&
            r.status === "allocated" &&
            r.assignedSpot === spotNumber
          ) {
            return { ...r, status: "cancelled" as RequestStatus };
          }
          return r;
        });
        requests.set(updatedRequests);
      }

      // Remove future allocations
      allocations.set(
        currentAllocations.filter(
          (a) => !(a.spotNumber === spotNumber && a.date >= todayDate),
        ),
      );

      // Remove spot
      spots.set(currentSpots.toSpliced(spotIdx, 1));
    });

    const editSpot = action<{
      spotNumber: number;
      label: string;
      notes: string;
    }>(
      ({ spotNumber, label, notes }) => {
        const currentSpots = spots.get();
        const updated = currentSpots.map((s) =>
          s.number === spotNumber ? { ...s, label, notes } : s
        );
        spots.set(updated);
      },
    );

    const manualAllocate = action<{
      personEmail: string;
      date: string;
      spotNumber: number;
    }>(
      ({ personEmail, date, spotNumber }) => {
        if (!personEmail || !date || !spotNumber) return;

        const currentPeople = people.get();
        if (!currentPeople.some((p) => p.email === personEmail)) return;

        const currentSpots = spots.get();
        if (!currentSpots.some((s) => s.number === spotNumber)) return;

        // Check spot is available on that date
        const currentAllocations = allocations.get();
        const alreadyTaken = currentAllocations.some(
          (a) => a.spotNumber === spotNumber && a.date === date,
        );
        if (alreadyTaken) return;

        // Check person doesn't already have an allocation for this date
        const existingPersonAlloc = currentAllocations.find(
          (a) => a.personEmail === personEmail && a.date === date,
        );
        if (existingPersonAlloc) return;

        // Create allocation
        allocations.push({
          spotNumber,
          date,
          personEmail,
          autoAllocated: false,
        });

        // Update or create request
        const currentRequests = requests.get();
        const reqIdx = currentRequests.findIndex(
          (r) => r.personEmail === personEmail && r.date === date,
        );
        if (reqIdx >= 0) {
          const updatedRequests = currentRequests.map((r, i) =>
            i === reqIdx
              ? {
                ...r,
                status: "allocated" as RequestStatus,
                assignedSpot: spotNumber,
              }
              : r
          );
          requests.set(updatedRequests);
        } else {
          requests.push({
            personEmail,
            date,
            status: "allocated" as RequestStatus,
            assignedSpot: spotNumber,
            requestedAt: new Date().toISOString(),
          });
        }
      },
    );

    // === UI ===

    // Today View
    const todayView = computed(() => {
      const currentSpots = spots.get();
      const currentAllocations = allocations.get();
      const currentPeople = people.get();

      return (
        <ct-vstack gap="2" style="padding: 1rem;">
          <ct-hstack justify="between" align="center">
            <span style={{ fontWeight: "600", fontSize: "1.1rem" }}>
              Today: {formatDate(todayDate)}
            </span>
            <span
              style={{
                fontSize: "0.875rem",
                color: "var(--ct-color-gray-500)",
              }}
            >
              {currentSpots.length} spots
            </span>
          </ct-hstack>

          {currentSpots.length === 0
            ? (
              <ct-card>
                <span style={{ color: "var(--ct-color-gray-500)" }}>
                  No parking spots configured. Add spots in admin mode.
                </span>
              </ct-card>
            )
            : null}

          {[...currentSpots]
            .sort((a: ParkingSpot, b: ParkingSpot) => a.number - b.number)
            .map((spot: ParkingSpot) => {
              const alloc = getAllocForSpotDate(
                spot.number,
                todayDate,
                currentAllocations,
              );
              const occupant = alloc
                ? getPersonByEmail(alloc.personEmail, currentPeople)
                : undefined;
              const isFree = !alloc;

              return (
                <ct-card>
                  <ct-hstack gap="2" align="center">
                    <span
                      style={{
                        fontWeight: "700",
                        fontSize: "1.2rem",
                        minWidth: "40px",
                      }}
                    >
                      #{spot.number}
                    </span>
                    <ct-vstack gap="0" style="flex: 1;">
                      <span style={{ fontWeight: "500" }}>
                        {spot.label || `Spot #${spot.number}`}
                      </span>
                      {spot.notes
                        ? (
                          <span
                            style={{
                              fontSize: "0.75rem",
                              color: "var(--ct-color-gray-500)",
                            }}
                          >
                            {spot.notes}
                          </span>
                        )
                        : null}
                    </ct-vstack>
                    <span
                      style={{
                        padding: "0.25rem 0.75rem",
                        borderRadius: "999px",
                        fontSize: "0.875rem",
                        fontWeight: "500",
                        backgroundColor: isFree
                          ? "var(--ct-color-green-100, #dcfce7)"
                          : "var(--ct-color-red-100, #fee2e2)",
                        color: isFree
                          ? "var(--ct-color-green-800, #166534)"
                          : "var(--ct-color-red-800, #991b1b)",
                      }}
                    >
                      {isFree ? "Free" : occupant ? occupant.name : "Taken"}
                    </span>
                  </ct-hstack>
                </ct-card>
              );
            })}
        </ct-vstack>
      );
    });

    // Week View
    const weekView = computed(() => {
      const currentSpots = spots.get();
      const currentAllocations = allocations.get();
      const currentPeople = people.get();
      const dates: string[] = [];
      for (let i = 0; i < 7; i++) {
        dates.push(getDateOffset(todayDate, i));
      }

      return (
        <ct-vstack gap="2" style="padding: 1rem;">
          <span style={{ fontWeight: "600", fontSize: "1.1rem" }}>
            Week Ahead
          </span>

          {dates.map((date: string) => (
            <ct-card>
              <ct-vstack gap="1">
                <span style={{ fontWeight: "600" }}>
                  {formatDate(date)}
                  {date === todayDate ? " (Today)" : ""}
                </span>
                <ct-vstack gap="0">
                  {[...currentSpots]
                    .sort(
                      (a: ParkingSpot, b: ParkingSpot) => a.number - b.number,
                    )
                    .map((spot: ParkingSpot) => {
                      const alloc = getAllocForSpotDate(
                        spot.number,
                        date,
                        currentAllocations,
                      );
                      const occupant = alloc
                        ? getPersonByEmail(alloc.personEmail, currentPeople)
                        : undefined;
                      return (
                        <ct-hstack
                          gap="2"
                          align="center"
                          style="padding: 0.25rem 0;"
                        >
                          <span
                            style={{
                              fontWeight: "600",
                              minWidth: "40px",
                              fontSize: "0.875rem",
                            }}
                          >
                            #{spot.number}
                          </span>
                          <span
                            style={{
                              fontSize: "0.875rem",
                              color: alloc
                                ? "var(--ct-color-gray-700)"
                                : "var(--ct-color-green-600, #16a34a)",
                            }}
                          >
                            {alloc
                              ? (occupant ? occupant.name : "Taken")
                              : "Free"}
                          </span>
                        </ct-hstack>
                      );
                    })}
                </ct-vstack>
              </ct-vstack>
            </ct-card>
          ))}
        </ct-vstack>
      );
    });

    // My Requests View (shown for the selected person)
    const requestsView = computed(() => {
      const currentRequests = requests.get();
      const currentPeople = people.get();
      const selectedEmail = requestPersonEmail.get();

      const personRequests = currentRequests.filter(
        (r) => r.personEmail === selectedEmail,
      );

      return (
        <ct-vstack gap="2" style="padding: 1rem;">
          <span style={{ fontWeight: "600", fontSize: "1.1rem" }}>
            My Requests
          </span>

          {currentPeople.length === 0
            ? (
              <ct-card>
                <span style={{ color: "var(--ct-color-gray-500)" }}>
                  No people in system. Add team members in admin mode.
                </span>
              </ct-card>
            )
            : (
              <ct-select
                $value={requestPersonEmail}
                items={currentPeople.map((p: Person) => ({
                  label: p.name,
                  value: p.email,
                }))}
              />
            )}

          {selectedEmail && personRequests.length === 0
            ? (
              <span
                style={{
                  color: "var(--ct-color-gray-500)",
                  padding: "1rem",
                  textAlign: "center",
                }}
              >
                No requests yet.
              </span>
            )
            : null}

          {personRequests.map((req: SpotRequest) => {
            const statusColor = req.status === "allocated"
              ? "var(--ct-color-green-600, #16a34a)"
              : req.status === "denied"
              ? "var(--ct-color-red-600, #dc2626)"
              : req.status === "cancelled"
              ? "var(--ct-color-gray-400)"
              : "var(--ct-color-yellow-600, #ca8a04)";

            return (
              <ct-card>
                <ct-hstack gap="2" align="center">
                  <ct-vstack gap="0" style="flex: 1;">
                    <span style={{ fontWeight: "500" }}>
                      {formatDate(req.date)}
                    </span>
                    <span style={{ fontSize: "0.875rem", color: statusColor }}>
                      {req.status === "allocated"
                        ? `Allocated: Spot #${req.assignedSpot}`
                        : req.status === "denied"
                        ? "Denied - no spots available"
                        : req.status === "cancelled"
                        ? "Cancelled"
                        : "Pending"}
                    </span>
                  </ct-vstack>
                  {req.status === "allocated" || req.status === "pending"
                    ? (
                      <ct-button
                        variant="ghost"
                        onClick={() =>
                          cancelRequest.send({
                            personEmail: req.personEmail,
                            date: req.date,
                          })}
                      >
                        Cancel
                      </ct-button>
                    )
                    : null}
                  {req.status === "denied"
                    ? (
                      <ct-button
                        variant="secondary"
                        onClick={() =>
                          retryRequest.send({
                            personEmail: req.personEmail,
                            date: req.date,
                          })}
                      >
                        Retry
                      </ct-button>
                    )
                    : null}
                </ct-hstack>
              </ct-card>
            );
          })}

          {selectedEmail
            ? (
              <ct-card>
                <ct-vstack gap="2">
                  <span style={{ fontWeight: "500" }}>Request a Spot</span>
                  <ct-input
                    $value={requestDate}
                    placeholder="YYYY-MM-DD"
                  />
                  <ct-button
                    variant="primary"
                    onClick={() =>
                      requestSpot.send({
                        personEmail: selectedEmail,
                        date: requestDate.get(),
                      })}
                  >
                    Request Parking
                  </ct-button>
                </ct-vstack>
              </ct-card>
            )
            : null}
        </ct-vstack>
      );
    });

    // Admin Panel
    const adminPanel = computed(() => {
      const currentSpots = spots.get();
      const currentPeople = people.get();
      const isAdmin = adminMode.get();

      if (!isAdmin) return null;

      return (
        <ct-vstack gap="3" style="padding: 1rem;">
          <span style={{ fontWeight: "600", fontSize: "1.1rem" }}>
            Admin Panel
          </span>

          {/* People Management */}
          <ct-card>
            <ct-vstack gap="2">
              <span style={{ fontWeight: "600" }}>
                People ({currentPeople.length})
              </span>

              {currentPeople.map((person: Person, idx: number) => (
                <ct-card>
                  <ct-vstack gap="1">
                    <ct-hstack gap="2" align="center">
                      <span
                        style={{
                          fontWeight: "600",
                          fontSize: "0.75rem",
                          color: "var(--ct-color-gray-400)",
                          minWidth: "20px",
                        }}
                      >
                        {idx + 1}
                      </span>
                      <ct-vstack gap="0" style="flex: 1;">
                        <span style={{ fontWeight: "500" }}>{person.name}</span>
                        <span
                          style={{
                            fontSize: "0.75rem",
                            color: "var(--ct-color-gray-500)",
                          }}
                        >
                          {person.email} | {person.commuteMode}
                        </span>
                        <span
                          style={{
                            fontSize: "0.75rem",
                            color: "var(--ct-color-gray-500)",
                          }}
                        >
                          Default: {person.defaultSpot > 0
                            ? `#${person.defaultSpot}`
                            : "None"}
                          {" | Prefs: "}
                          {person.spotPreferences &&
                              person.spotPreferences.length > 0
                            ? person.spotPreferences.map((n: number) => `#${n}`)
                              .join(", ")
                            : "None"}
                        </span>
                      </ct-vstack>
                      <ct-button
                        variant="ghost"
                        onClick={() =>
                          movePersonUp.send({ email: person.email })}
                      >
                        Up
                      </ct-button>
                      <ct-button
                        variant="ghost"
                        onClick={() =>
                          movePersonDown.send({ email: person.email })}
                      >
                        Dn
                      </ct-button>
                      <ct-button
                        variant="ghost"
                        onClick={() =>
                          removePerson.send({ email: person.email })}
                      >
                        x
                      </ct-button>
                    </ct-hstack>
                    <ct-vstack gap="1">
                      <ct-hstack
                        gap="1"
                        align="center"
                        style="flex-wrap: wrap;"
                      >
                        <span
                          style={{
                            fontSize: "0.75rem",
                            color: "var(--ct-color-gray-500)",
                          }}
                        >
                          Default:
                        </span>
                        {person.defaultSpot > 0
                          ? (
                            <ct-button
                              variant="ghost"
                              onClick={() =>
                                setDefaultSpot.send({
                                  email: person.email,
                                  spotNumber: 0,
                                })}
                            >
                              <span style={{ fontSize: "0.75rem" }}>
                                #{person.defaultSpot} (clear)
                              </span>
                            </ct-button>
                          )
                          : null}
                        {currentSpots
                          .filter(
                            (s: ParkingSpot) => s.number !== person.defaultSpot,
                          )
                          .map((s: ParkingSpot) => (
                            <ct-button
                              variant="secondary"
                              onClick={() =>
                                setDefaultSpot.send({
                                  email: person.email,
                                  spotNumber: s.number,
                                })}
                            >
                              <span style={{ fontSize: "0.75rem" }}>
                                #{s.number}
                              </span>
                            </ct-button>
                          ))}
                      </ct-hstack>
                      <ct-hstack
                        gap="1"
                        align="center"
                        style="flex-wrap: wrap;"
                      >
                        <span
                          style={{
                            fontSize: "0.75rem",
                            color: "var(--ct-color-gray-500)",
                          }}
                        >
                          Prefs:
                        </span>
                        {(person.spotPreferences || []).map(
                          (prefNum: number, prefIdx: number) => (
                            <ct-hstack
                              gap="0"
                              align="center"
                              style="display: inline-flex;"
                            >
                              {prefIdx > 0
                                ? (
                                  <ct-button
                                    variant="ghost"
                                    onClick={() => {
                                      const current = [
                                        ...(person.spotPreferences || []),
                                      ];
                                      const temp = current[prefIdx - 1];
                                      current[prefIdx - 1] = current[prefIdx];
                                      current[prefIdx] = temp;
                                      setSpotPreferences.send({
                                        email: person.email,
                                        preferences: current,
                                      });
                                    }}
                                  >
                                    <span style={{ fontSize: "0.65rem" }}>
                                      &lt;
                                    </span>
                                  </ct-button>
                                )
                                : null}
                              <ct-button
                                variant="ghost"
                                onClick={() => {
                                  const current = person.spotPreferences || [];
                                  const updated = current.filter(
                                    (_: number, i: number) => i !== prefIdx,
                                  );
                                  setSpotPreferences.send({
                                    email: person.email,
                                    preferences: updated,
                                  });
                                }}
                              >
                                <span style={{ fontSize: "0.75rem" }}>
                                  #{prefNum} x
                                </span>
                              </ct-button>
                              {prefIdx <
                                  (person.spotPreferences || []).length - 1
                                ? (
                                  <ct-button
                                    variant="ghost"
                                    onClick={() => {
                                      const current = [
                                        ...(person.spotPreferences || []),
                                      ];
                                      const temp = current[prefIdx + 1];
                                      current[prefIdx + 1] = current[prefIdx];
                                      current[prefIdx] = temp;
                                      setSpotPreferences.send({
                                        email: person.email,
                                        preferences: current,
                                      });
                                    }}
                                  >
                                    <span style={{ fontSize: "0.65rem" }}>
                                      &gt;
                                    </span>
                                  </ct-button>
                                )
                                : null}
                            </ct-hstack>
                          ),
                        )}
                        {currentSpots
                          .filter(
                            (s: ParkingSpot) =>
                              !(person.spotPreferences || []).includes(
                                s.number,
                              ),
                          )
                          .map((s: ParkingSpot) => (
                            <ct-button
                              variant="secondary"
                              onClick={() => {
                                const current = person.spotPreferences || [];
                                setSpotPreferences.send({
                                  email: person.email,
                                  preferences: [...current, s.number],
                                });
                              }}
                            >
                              <span style={{ fontSize: "0.75rem" }}>
                                +#{s.number}
                              </span>
                            </ct-button>
                          ))}
                      </ct-hstack>
                    </ct-vstack>
                  </ct-vstack>
                </ct-card>
              ))}

              <ct-vstack gap="1">
                <span style={{ fontSize: "0.875rem", fontWeight: "500" }}>
                  Add Person
                </span>
                <ct-input $value={newPersonName} placeholder="Name" />
                <ct-input $value={newPersonEmail} placeholder="Email" />
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
                <ct-button
                  variant="primary"
                  onClick={() =>
                    addPerson.send({
                      name: newPersonName.get(),
                      email: newPersonEmail.get(),
                      commuteMode: newPersonCommute.get(),
                    })}
                >
                  Add Person
                </ct-button>
              </ct-vstack>
            </ct-vstack>
          </ct-card>

          {/* Spots Management */}
          <ct-card>
            <ct-vstack gap="2">
              <span style={{ fontWeight: "600" }}>
                Spots ({currentSpots.length})
              </span>

              {[...currentSpots]
                .sort(
                  (a: ParkingSpot, b: ParkingSpot) => a.number - b.number,
                )
                .map((spot: ParkingSpot) => (
                  <ct-hstack gap="2" align="center">
                    <span style={{ fontWeight: "600", minWidth: "40px" }}>
                      #{spot.number}
                    </span>
                    <span style={{ flex: "1", fontSize: "0.875rem" }}>
                      {spot.label || "(no label)"}
                    </span>
                    <ct-button
                      variant="ghost"
                      onClick={() =>
                        removeSpot.send({ spotNumber: spot.number })}
                    >
                      x
                    </ct-button>
                  </ct-hstack>
                ))}

              <ct-vstack gap="1">
                <span style={{ fontSize: "0.875rem", fontWeight: "500" }}>
                  Add Spot
                </span>
                <ct-input
                  $value={newSpotNumber}
                  placeholder="Spot number"
                />
                <ct-input
                  $value={newSpotLabel}
                  placeholder="Label (optional)"
                />
                <ct-input
                  $value={newSpotNotes}
                  placeholder="Notes (optional)"
                />
                <ct-button
                  variant="primary"
                  onClick={() =>
                    addSpot.send({
                      number: parseInt(newSpotNumber.get()) || 0,
                      label: newSpotLabel.get(),
                      notes: newSpotNotes.get(),
                    })}
                >
                  Add Spot
                </ct-button>
              </ct-vstack>
            </ct-vstack>
          </ct-card>

          {/* Manual Allocation */}
          <ct-card>
            <ct-vstack gap="2">
              <span style={{ fontWeight: "600" }}>Manual Allocation</span>
              <ct-select
                $value={manualAllocPersonEmail}
                items={currentPeople.map((p: Person) => ({
                  label: p.name,
                  value: p.email,
                }))}
              />
              <ct-input
                $value={manualAllocDate}
                placeholder="YYYY-MM-DD"
              />
              <ct-input
                $value={manualAllocSpotNumber}
                placeholder="Spot number"
              />
              <ct-button
                variant="primary"
                onClick={() =>
                  manualAllocate.send({
                    personEmail: manualAllocPersonEmail.get(),
                    date: manualAllocDate.get(),
                    spotNumber: parseInt(manualAllocSpotNumber.get()) || 0,
                  })}
              >
                Assign Spot
              </ct-button>
            </ct-vstack>
          </ct-card>
        </ct-vstack>
      );
    });

    // Main UI
    const currentView = computed(() => {
      const mode = viewMode.get();
      if (mode === "week") return weekView;
      if (mode === "requests") return requestsView;
      return todayView;
    });

    return {
      [NAME]: "Parking Coordinator",
      [UI]: (
        <ct-screen>
          <ct-vstack slot="header" gap="1">
            <ct-hstack justify="between" align="center">
              <ct-heading level={4}>Parking Coordinator</ct-heading>
              <ct-button
                variant={computed(() =>
                  adminMode.get() ? "primary" : "secondary"
                )}
                onClick={toggleAdmin}
              >
                {computed(() => adminMode.get() ? "Admin ON" : "Admin")}
              </ct-button>
            </ct-hstack>
            <ct-hstack gap="1">
              <ct-button
                variant={computed(() =>
                  viewMode.get() === "today" ? "primary" : "ghost"
                )}
                onClick={() => setViewMode.send({ mode: "today" })}
              >
                Today
              </ct-button>
              <ct-button
                variant={computed(() =>
                  viewMode.get() === "week" ? "primary" : "ghost"
                )}
                onClick={() => setViewMode.send({ mode: "week" })}
              >
                Week
              </ct-button>
              <ct-button
                variant={computed(() =>
                  viewMode.get() === "requests" ? "primary" : "ghost"
                )}
                onClick={() => setViewMode.send({ mode: "requests" })}
              >
                My Requests
              </ct-button>
            </ct-hstack>
          </ct-vstack>

          <ct-vscroll flex showScrollbar fadeEdges>
            {currentView}
            {adminPanel}
          </ct-vscroll>
        </ct-screen>
      ),
      spots,
      people,
      requests,
      allocations,
      adminMode,
      todayDate,
      viewMode,
      seedSpots,
      requestSpot,
      cancelRequest,
      retryRequest,
      toggleAdmin,
      setViewMode,
      addPerson,
      removePerson,
      movePersonUp,
      movePersonDown,
      setDefaultSpot,
      setSpotPreferences,
      addSpot,
      removeSpot,
      editSpot,
      manualAllocate,
    };
  },
);
