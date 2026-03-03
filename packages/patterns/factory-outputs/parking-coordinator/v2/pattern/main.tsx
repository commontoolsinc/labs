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

// ===== Helpers (module scope) =====

const getTodayDate = (): string => new Date().toISOString().split("T")[0];

const getDateOffset = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().split("T")[0];
};

const formatDay = (dateStr: string): string => {
  const d = new Date(dateStr + "T12:00:00");
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
};

const formatDate = (dateStr: string): string => {
  const d = new Date(dateStr + "T12:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

const statusColor = (status: string): string => {
  const colors: Record<string, string> = {
    allocated: "#22c55e",
    pending: "#f59e0b",
    denied: "#ef4444",
    cancelled: "#9ca3af",
  };
  return colors[status] || "#9ca3af";
};

const COMMUTE_LABELS: Record<string, string> = {
  drive: "Car",
  transit: "Transit",
  bike: "Bike",
  wfh: "WFH",
  other: "Other",
};

// ===== Types =====

interface ParkingSpot {
  number: number;
  label: Default<string, "">;
  notes: Default<string, "">;
}

interface Person {
  name: string;
  email: string;
  commuteMode: Default<"drive" | "transit" | "bike" | "wfh" | "other", "drive">;
  defaultSpot: Default<number, 0>;
  spotPreferences: Default<number[], []>;
}

interface SpotRequest {
  personName: string;
  requestedDate: string;
  status: Default<"pending" | "allocated" | "denied" | "cancelled", "pending">;
  assignedSpot: Default<number, 0>;
  autoAllocated: Default<boolean, true>;
}

// ===== Input / Output =====

interface ParkingInput {
  spots: Writable<Default<ParkingSpot[], []>>;
  people: Writable<Default<Person[], []>>;
  requests: Writable<Default<SpotRequest[], []>>;
}

interface ParkingOutput {
  [NAME]: string;
  [UI]: VNode;
  spots: ParkingSpot[];
  people: Person[];
  requests: SpotRequest[];
  requestSpot: Stream<{ personName: string; date: string }>;
  cancelRequest: Stream<{ personName: string; date: string }>;
  addPerson: Stream<{ name: string; email: string; commuteMode: string }>;
  removePerson: Stream<{ name: string }>;
  movePersonUp: Stream<{ name: string }>;
  movePersonDown: Stream<{ name: string }>;
  setDefaultSpot: Stream<{ personName: string; spotNumber: number }>;
  setSpotPreferences: Stream<{
    personName: string;
    preferences: number[];
  }>;
  addSpot: Stream<{ number: number; label: string; notes: string }>;
  editSpot: Stream<{ number: number; label: string; notes: string }>;
  removeSpot: Stream<{ number: number }>;
  manualAssign: Stream<{
    personName: string;
    date: string;
    spotNumber: number;
  }>;
}

// ===== Pattern =====

export default pattern<ParkingInput, ParkingOutput>(
  ({ spots, people, requests }) => {
    const todayDate = getTodayDate();
    const weekDates: string[] = [];
    for (let i = 0; i < 7; i++) {
      weekDates.push(getDateOffset(i));
    }

    // ---- UI State ----
    const currentTab = Writable.of("parking");
    const adminMode = Writable.of(false);
    const selectedPerson = Writable.of("");
    const editingPerson = Writable.of("");
    const editingSpot = Writable.of(-1);
    const showAddPerson = Writable.of(false);
    const showAddSpot = Writable.of(false);

    // Form fields
    const newPersonName = Writable.of("");
    const newPersonEmail = Writable.of("");
    const newPersonCommute = Writable.of("drive");
    const newSpotNumber = Writable.of("");
    const newSpotLabel = Writable.of("");
    const newSpotNotes = Writable.of("");
    const editSpotLabel = Writable.of("");
    const editSpotNotes = Writable.of("");
    const editPersonDefaultSpot = Writable.of(0);
    // ---- Computed ----
    const hasSpots = computed(() => spots.get().length > 0);
    const hasPeople = computed(() => people.get().length > 0);
    const isParking = computed(() => currentTab.get() === "parking");
    const isRequests = computed(() => currentTab.get() === "requests");
    const isAdmin = computed(() => currentTab.get() === "admin");
    const noPeople = computed(() => people.get().length === 0);
    const noSpots = computed(() => spots.get().length === 0);

    // ---- Actions ----

    const requestSpot = action(
      ({ personName, date }: { personName: string; date: string }) => {
        if (!personName || !date) return;
        if (date < todayDate) return;

        // Check for duplicate active request
        const existing = requests
          .get()
          .find(
            (r) =>
              r.personName === personName &&
              r.requestedDate === date &&
              r.status !== "cancelled" &&
              r.status !== "denied",
          );
        if (existing) return;

        // Auto-allocate
        const allSpots = spots.get();
        const allPeople = people.get();
        const allRequests = requests.get();
        const person = allPeople.find((p) => p.name === personName);
        if (!person) return;

        const takenSpots = allRequests
          .filter(
            (r) =>
              r.requestedDate === date &&
              r.status === "allocated" &&
              r.assignedSpot > 0,
          )
          .map((r) => r.assignedSpot);

        const isAvailable = (spotNum: number): boolean =>
          allSpots.some((s) => s.number === spotNum) &&
          !takenSpots.includes(spotNum);

        let spotNum = 0;
        // 1. Default spot
        if (person.defaultSpot > 0 && isAvailable(person.defaultSpot)) {
          spotNum = person.defaultSpot;
        }
        // 2. Preferences
        if (spotNum === 0) {
          const prefs = person.spotPreferences || [];
          for (const pref of prefs) {
            if (isAvailable(pref)) {
              spotNum = pref;
              break;
            }
          }
        }
        // 3. Any free
        if (spotNum === 0) {
          for (const s of allSpots) {
            if (isAvailable(s.number)) {
              spotNum = s.number;
              break;
            }
          }
        }

        if (spotNum > 0) {
          requests.push({
            personName,
            requestedDate: date,
            status: "allocated" as const,
            assignedSpot: spotNum,
            autoAllocated: true,
          });
        } else {
          requests.push({
            personName,
            requestedDate: date,
            status: "denied" as const,
            assignedSpot: 0,
            autoAllocated: true,
          });
        }
      },
    );

    const cancelRequest = action(
      ({ personName, date }: { personName: string; date: string }) => {
        const all = requests.get();
        const updated = all.map((r) => {
          if (
            r.personName === personName &&
            r.requestedDate === date &&
            (r.status === "pending" || r.status === "allocated")
          ) {
            return { ...r, status: "cancelled" as const, assignedSpot: 0 };
          }
          return r;
        });
        requests.set(updated);
      },
    );

    const addPerson = action(
      ({
        name,
        email,
        commuteMode,
      }: {
        name: string;
        email: string;
        commuteMode: string;
      }) => {
        const trimmed = name.trim();
        if (!trimmed || !email.trim()) return;
        if (people.get().some((p) => p.name === trimmed)) return;
        people.push({
          name: trimmed,
          email: email.trim(),
          commuteMode: (commuteMode || "drive") as "drive" | "transit" | "bike" | "wfh" | "other",
          defaultSpot: 0,
          spotPreferences: [],
        });
      },
    );

    const removePerson = action(({ name }: { name: string }) => {
      const allReqs = requests.get();
      const updated = allReqs.map((r) => {
        if (
          r.personName === name &&
          (r.status === "pending" || r.status === "allocated")
        ) {
          return { ...r, status: "cancelled" as const, assignedSpot: 0 };
        }
        return r;
      });
      requests.set(updated);

      const current = people.get();
      const idx = current.findIndex((p) => p.name === name);
      if (idx >= 0) {
        people.set(current.toSpliced(idx, 1));
      }

      if (selectedPerson.get() === name) {
        selectedPerson.set("");
      }
    });

    const movePersonUp = action(({ name }: { name: string }) => {
      const current = people.get();
      const idx = current.findIndex((p) => p.name === name);
      if (idx > 0) {
        const updated = [...current];
        [updated[idx - 1], updated[idx]] = [updated[idx], updated[idx - 1]];
        people.set(updated);
      }
    });

    const movePersonDown = action(({ name }: { name: string }) => {
      const current = people.get();
      const idx = current.findIndex((p) => p.name === name);
      if (idx >= 0 && idx < current.length - 1) {
        const updated = [...current];
        [updated[idx], updated[idx + 1]] = [updated[idx + 1], updated[idx]];
        people.set(updated);
      }
    });

    const setDefaultSpot = action(
      ({
        personName,
        spotNumber,
      }: {
        personName: string;
        spotNumber: number;
      }) => {
        const current = people.get();
        const updated = current.map((p) =>
          p.name === personName ? { ...p, defaultSpot: spotNumber } : p
        );
        people.set(updated);
      },
    );

    const setSpotPreferences = action(
      ({
        personName,
        preferences,
      }: {
        personName: string;
        preferences: number[];
      }) => {
        const current = people.get();
        const updated = current.map((p) =>
          p.name === personName ? { ...p, spotPreferences: preferences } : p
        );
        people.set(updated);
      },
    );

    const addSpot = action(
      ({
        number: num,
        label,
        notes,
      }: {
        number: number;
        label: string;
        notes: string;
      }) => {
        if (num <= 0) return;
        if (spots.get().some((s) => s.number === num)) return;
        spots.push({ number: num, label: label || "", notes: notes || "" });
      },
    );

    const editSpot = action(
      ({
        number: num,
        label,
        notes,
      }: {
        number: number;
        label: string;
        notes: string;
      }) => {
        const current = spots.get();
        const updated = current.map((s) =>
          s.number === num ? { ...s, label, notes } : s
        );
        spots.set(updated);
      },
    );

    const removeSpot = action(({ number: num }: { number: number }) => {
      const allReqs = requests.get();
      const updatedReqs = allReqs.map((r) => {
        if (r.assignedSpot === num && r.status === "allocated") {
          return { ...r, status: "pending" as const, assignedSpot: 0 };
        }
        return r;
      });
      requests.set(updatedReqs);

      const currentPeople = people.get();
      const updatedPeople = currentPeople.map((p) => ({
        ...p,
        defaultSpot: p.defaultSpot === num ? 0 : p.defaultSpot,
        spotPreferences: (p.spotPreferences || []).filter(
          (pref) => pref !== num,
        ),
      }));
      people.set(updatedPeople);

      const current = spots.get();
      const idx = current.findIndex((s) => s.number === num);
      if (idx >= 0) {
        spots.set(current.toSpliced(idx, 1));
      }
    });

    const manualAssign = action(
      ({
        personName,
        date,
        spotNumber,
      }: {
        personName: string;
        date: string;
        spotNumber: number;
      }) => {
        const all = requests.get();
        const updated = all.map((r) => {
          if (
            r.personName === personName &&
            r.requestedDate === date &&
            r.status === "pending"
          ) {
            return {
              ...r,
              status: "allocated" as const,
              assignedSpot: spotNumber,
              autoAllocated: false,
            };
          }
          return r;
        });
        requests.set(updated);
      },
    );

    // ---- Pre-computed week day data ----
    const futureDates = weekDates.slice(1); // skip today

    // ---- Computed views for My Requests ----
    const myUpcoming = computed(() => {
      const sel = selectedPerson.get();
      if (!sel) return [];
      return requests
        .get()
        .filter(
          (r) =>
            r.personName === sel &&
            r.requestedDate >= todayDate &&
            (r.status === "allocated" || r.status === "pending"),
        )
        .sort((a, b) => (a.requestedDate > b.requestedDate ? 1 : -1));
    });

    const myPast = computed(() => {
      const sel = selectedPerson.get();
      if (!sel) return [];
      return requests
        .get()
        .filter(
          (r) =>
            r.personName === sel &&
            (r.requestedDate < todayDate ||
              r.status === "cancelled" ||
              r.status === "denied"),
        )
        .sort((a, b) => (b.requestedDate > a.requestedDate ? 1 : -1));
    });

    // ---- Main UI ----

    return {
      [NAME]: "Parking Coordinator",
      [UI]: (
        <ct-screen>
          {/* Header */}
          <ct-vstack slot="header" gap="2">
            <ct-hstack justify="between" align="center">
              <ct-heading level={4}>Parking Coordinator</ct-heading>
              <ct-hstack gap="2" align="center">
                <span style={{ fontSize: "0.8rem", color: "var(--ct-color-gray-500)" }}>
                  Admin
                </span>
                <ct-checkbox $checked={adminMode} />
              </ct-hstack>
            </ct-hstack>

            {/* Person selector */}
            <ct-hstack gap="2" align="center">
              <span style={{ fontSize: "0.875rem", fontWeight: "500" }}>
                You are:
              </span>
              {hasPeople
                ? (
                  <ct-select
                    $value={selectedPerson}
                    items={computed(() => [
                      { label: "Select yourself...", value: "" },
                      ...people.get().map((p) => ({
                        label: p.name,
                        value: p.name,
                      })),
                    ])}
                    style="flex: 1;"
                  />
                )
                : (
                  <span style={{ fontSize: "0.8rem", color: "var(--ct-color-gray-500)", fontStyle: "italic" }}>
                    No team members added yet.
                  </span>
                )}
            </ct-hstack>

            {/* Tabs */}
            <ct-hstack gap="0">
              <ct-button
                variant={isParking ? "primary" : "secondary"}
                onClick={() => currentTab.set("parking")}
              >
                Parking
              </ct-button>
              <ct-button
                variant={isRequests ? "primary" : "secondary"}
                onClick={() => currentTab.set("requests")}
              >
                My Requests
              </ct-button>
              {adminMode
                ? (
                  <ct-button
                    variant={isAdmin ? "primary" : "secondary"}
                    onClick={() => currentTab.set("admin")}
                  >
                    Admin
                  </ct-button>
                )
                : null}
            </ct-hstack>
          </ct-vstack>

          {/* Content */}
          <ct-vscroll flex showScrollbar fadeEdges>
            <ct-vstack gap="2" style="padding: 1rem;">
              {/* ======= PARKING TAB ======= */}
              {isParking
                ? (
                  <ct-vstack gap="3">
                    {/* No spots message */}
                    {noSpots
                      ? (
                        <div style={{ textAlign: "center", color: "var(--ct-color-gray-500)", padding: "2rem" }}>
                          No parking spots configured. An admin needs to add
                          spots in Admin mode.
                        </div>
                      )
                      : (
                        <ct-vstack gap="3">
                          {/* Today Panel */}
                          <ct-card>
                            <ct-vstack gap="2">
                              <ct-hstack justify="between" align="center">
                                <span style={{ fontWeight: "600", fontSize: "1.1rem" }}>
                                  Today - {formatDay(todayDate)}{" "}
                                  {formatDate(todayDate)}
                                </span>
                                <span style={{ fontSize: "0.875rem", color: "var(--ct-color-gray-500)" }}>
                                  {computed(() => {
                                    const total = spots.get().length;
                                    const taken = requests
                                      .get()
                                      .filter(
                                        (r) =>
                                          r.requestedDate === todayDate &&
                                          r.status === "allocated" &&
                                          r.assignedSpot > 0,
                                      ).length;
                                    return `${total - taken} of ${total} free`;
                                  })}
                                </span>
                              </ct-hstack>

                              {/* Spot list for today */}
                              {spots.map((spot) => {
                                const occupant = computed(() => {
                                  const req = requests.get().find(
                                    (r) =>
                                      r.requestedDate === todayDate &&
                                      r.assignedSpot === spot.number &&
                                      r.status === "allocated",
                                  );
                                  return req ? req.personName : "";
                                });
                                const isFree = computed(() => occupant === "");

                                return (
                                  <ct-hstack
                                    gap="2"
                                    align="center"
                                    style="padding: 4px 0;"
                                  >
                                    <span
                                      style={{
                                        width: "36px",
                                        height: "36px",
                                        borderRadius: "6px",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        fontWeight: "600",
                                        fontSize: "0.875rem",
                                        backgroundColor: isFree
                                          ? "#dcfce7"
                                          : "#fee2e2",
                                        color: isFree ? "#15803d" : "#b91c1c",
                                      }}
                                    >
                                      #{spot.number}
                                    </span>
                                    <span style={{ flex: "1" }}>
                                      {spot.label
                                        ? (
                                          <span style={{ fontSize: "0.8rem", color: "var(--ct-color-gray-500)" }}>
                                            {spot.label}
                                          </span>
                                        )
                                        : null}
                                    </span>
                                    <span
                                      style={{
                                        fontWeight: "500",
                                        color: isFree ? "#16a34a" : "inherit",
                                      }}
                                    >
                                      {isFree ? "Free" : occupant}
                                    </span>
                                  </ct-hstack>
                                );
                              })}

                              {/* User status row */}
                              {computed(() => !!selectedPerson.get())
                                ? (
                                  <ct-hstack
                                    gap="2"
                                    align="center"
                                    style="padding: 8px 0; border-top: 1px solid #e5e7eb; margin-top: 4px;"
                                  >
                                    <span style={{ fontWeight: "500" }}>
                                      Your status:
                                    </span>
                                    {computed(() => {
                                      const sel = selectedPerson.get();
                                      const req = requests.get().find(
                                        (r) =>
                                          r.personName === sel &&
                                          r.requestedDate === todayDate &&
                                          r.status !== "cancelled",
                                      );
                                      if (
                                        req &&
                                        (req.status === "allocated" ||
                                          req.status === "pending")
                                      ) {
                                        const statusText = req.status === "allocated"
                                          ? `Allocated - Spot #${req.assignedSpot}`
                                          : "Pending";
                                        return (
                                          <ct-hstack gap="2" align="center">
                                            <span
                                              style={{
                                                padding: "2px 8px",
                                                borderRadius: "12px",
                                                fontSize: "0.75rem",
                                                fontWeight: "500",
                                                backgroundColor: "#22c55e20",
                                                color: "#22c55e",
                                              }}
                                            >
                                              {statusText}
                                            </span>
                                            <ct-button
                                              variant="ghost"
                                              onClick={() =>
                                                cancelRequest.send({
                                                  personName:
                                                    selectedPerson.get(),
                                                  date: todayDate,
                                                })}
                                            >
                                              Cancel
                                            </ct-button>
                                          </ct-hstack>
                                        );
                                      }
                                      if (req && req.status === "denied") {
                                        return (
                                          <span
                                            style={{
                                              padding: "2px 8px",
                                              borderRadius: "12px",
                                              fontSize: "0.75rem",
                                              fontWeight: "500",
                                              backgroundColor: "#ef444420",
                                              color: "#ef4444",
                                            }}
                                          >
                                            No spots available
                                          </span>
                                        );
                                      }
                                      return (
                                        <ct-button
                                          variant="primary"
                                          onClick={() =>
                                            requestSpot.send({
                                              personName:
                                                selectedPerson.get(),
                                              date: todayDate,
                                            })}
                                        >
                                          Request spot
                                        </ct-button>
                                      );
                                    })}
                                  </ct-hstack>
                                )
                                : (
                                  <div style={{ padding: "8px", color: "var(--ct-color-gray-500)", fontStyle: "italic" }}>
                                    Select yourself above to make requests.
                                  </div>
                                )}
                            </ct-vstack>
                          </ct-card>

                          {/* Week Ahead */}
                          <ct-vstack gap="1">
                            <span
                              style={{
                                fontWeight: "600",
                                fontSize: "1rem",
                                padding: "4px 0",
                              }}
                            >
                              This Week
                            </span>
                            {futureDates.map((dateStr: string) => {
                              const free = computed(() => {
                                const total = spots.get().length;
                                const taken = requests
                                  .get()
                                  .filter(
                                    (r) =>
                                      r.requestedDate === dateStr &&
                                      r.status === "allocated" &&
                                      r.assignedSpot > 0,
                                  ).length;
                                return total - taken;
                              });
                              const totalSpots = computed(
                                () => spots.get().length,
                              );
                              const dayLabel = `${formatDay(dateStr)} ${formatDate(dateStr)}`;
                              const userStatus = computed(() => {
                                const sel = selectedPerson.get();
                                if (!sel) return "none";
                                const req = requests.get().find(
                                  (r) =>
                                    r.personName === sel &&
                                    r.requestedDate === dateStr &&
                                    r.status !== "cancelled",
                                );
                                if (!req) return "none";
                                if (
                                  req.status === "allocated" ||
                                  req.status === "pending"
                                )
                                  return "active";
                                if (req.status === "denied") return "denied";
                                return "none";
                              });
                              const userSpot = computed(() => {
                                const sel = selectedPerson.get();
                                if (!sel) return "";
                                const req = requests.get().find(
                                  (r) =>
                                    r.personName === sel &&
                                    r.requestedDate === dateStr &&
                                    r.status === "allocated",
                                );
                                return req ? `#${req.assignedSpot}` : "";
                              });

                              return (
                                <ct-hstack
                                  gap="2"
                                  align="center"
                                  style="padding: 8px; border-bottom: 1px solid #f3f4f6;"
                                >
                                  <span style={{ width: "100px", fontWeight: "500" }}>
                                    {dayLabel}
                                  </span>
                                  <span style={{ flex: "1", fontSize: "0.875rem", color: "var(--ct-color-gray-500)" }}>
                                    {free} of {totalSpots} free
                                  </span>
                                  {computed(() => {
                                    const sel = selectedPerson.get();
                                    if (!sel) return null;
                                    if (userStatus === "active") {
                                      return (
                                        <ct-hstack gap="1" align="center">
                                          <span
                                            style={{
                                              padding: "2px 8px",
                                              borderRadius: "12px",
                                              fontSize: "0.75rem",
                                              backgroundColor: "#22c55e20",
                                              color: "#22c55e",
                                            }}
                                          >
                                            {userSpot
                                              ? userSpot
                                              : "Pending"}
                                          </span>
                                          <ct-button
                                            variant="ghost"
                                            onClick={() =>
                                              cancelRequest.send({
                                                personName:
                                                  selectedPerson.get(),
                                                date: dateStr,
                                              })}
                                          >
                                            x
                                          </ct-button>
                                        </ct-hstack>
                                      );
                                    }
                                    if (userStatus === "denied") {
                                      return (
                                        <span
                                          style={{
                                            padding: "2px 8px",
                                            borderRadius: "12px",
                                            fontSize: "0.75rem",
                                            backgroundColor: "#ef444420",
                                            color: "#ef4444",
                                          }}
                                        >
                                          Denied
                                        </span>
                                      );
                                    }
                                    return (
                                      <ct-button
                                        variant="secondary"
                                        onClick={() =>
                                          requestSpot.send({
                                            personName:
                                              selectedPerson.get(),
                                            date: dateStr,
                                          })}
                                      >
                                        Request
                                      </ct-button>
                                    );
                                  })}
                                </ct-hstack>
                              );
                            })}
                          </ct-vstack>
                        </ct-vstack>
                      )}
                  </ct-vstack>
                )
                : null}

              {/* ======= MY REQUESTS TAB ======= */}
              {isRequests
                ? (
                  <ct-vstack gap="3">
                    {computed(() => !selectedPerson.get())
                      ? (
                        <div style={{ textAlign: "center", color: "var(--ct-color-gray-500)", padding: "2rem" }}>
                          Select who you are on the Parking tab to see your
                          requests.
                        </div>
                      )
                      : (
                        <ct-vstack gap="3">
                          {/* Upcoming */}
                          <ct-vstack gap="1">
                            <span style={{ fontWeight: "600" }}>Upcoming</span>
                            {computed(
                              () => myUpcoming.length === 0,
                            )
                              ? (
                                <div style={{ color: "var(--ct-color-gray-500)", padding: "1rem", fontStyle: "italic" }}>
                                  No upcoming requests.
                                </div>
                              )
                              : myUpcoming.map((req: SpotRequest) => (
                                  <ct-card>
                                    <ct-hstack
                                      gap="2"
                                      align="center"
                                      justify="between"
                                    >
                                      <ct-vstack gap="0">
                                        <span style={{ fontWeight: "500" }}>
                                          {formatDay(req.requestedDate)}{" "}
                                          {formatDate(req.requestedDate)}
                                        </span>
                                        <span
                                          style={{
                                            padding: "2px 8px",
                                            borderRadius: "12px",
                                            fontSize: "0.75rem",
                                            fontWeight: "500",
                                            backgroundColor:
                                              statusColor(req.status) + "20",
                                            color: statusColor(req.status),
                                          }}
                                        >
                                          {req.status === "allocated"
                                            ? `Allocated - Spot #${req.assignedSpot}`
                                            : req.status}
                                        </span>
                                      </ct-vstack>
                                      <ct-button
                                        variant="ghost"
                                        onClick={() =>
                                          cancelRequest.send({
                                            personName: selectedPerson.get(),
                                            date: req.requestedDate,
                                          })}
                                      >
                                        Cancel
                                      </ct-button>
                                    </ct-hstack>
                                  </ct-card>
                                ))}
                          </ct-vstack>

                          {/* Past */}
                          <ct-vstack gap="1">
                            <span style={{ fontWeight: "600" }}>Past</span>
                            {computed(
                              () => myPast.length === 0,
                            )
                              ? (
                                <div style={{ color: "var(--ct-color-gray-500)", padding: "1rem", fontStyle: "italic" }}>
                                  No past requests.
                                </div>
                              )
                              : myPast.map((req: SpotRequest) => (
                                  <ct-card>
                                    <ct-hstack
                                      gap="2"
                                      align="center"
                                      justify="between"
                                    >
                                      <ct-vstack gap="0">
                                        <span>
                                          {formatDay(req.requestedDate)}{" "}
                                          {formatDate(req.requestedDate)}
                                        </span>
                                        <span
                                          style={{
                                            padding: "2px 8px",
                                            borderRadius: "12px",
                                            fontSize: "0.75rem",
                                            fontWeight: "500",
                                            backgroundColor:
                                              statusColor(req.status) + "20",
                                            color: statusColor(req.status),
                                          }}
                                        >
                                          {req.status === "allocated"
                                            ? `Spot #${req.assignedSpot}`
                                            : req.status}
                                        </span>
                                      </ct-vstack>
                                    </ct-hstack>
                                  </ct-card>
                                ))}
                          </ct-vstack>
                        </ct-vstack>
                      )}
                  </ct-vstack>
                )
                : null}

              {/* ======= ADMIN TAB ======= */}
              {isAdmin
                ? (
                  <ct-vstack gap="4">
                    {/* ---- People Section ---- */}
                    <ct-vstack gap="2">
                      <span style={{ fontWeight: "600", fontSize: "1rem" }}>
                        People (priority order)
                      </span>

                      {noPeople
                        ? (
                          <div style={{ color: "var(--ct-color-gray-500)", padding: "1rem" }}>
                            No team members yet. Add the first person below.
                          </div>
                        )
                        : people.map((person) => {
                            const isEditingThis = computed(
                              () => editingPerson.get() === person.name,
                            );
                            return (
                              <ct-card>
                                <ct-vstack gap="2">
                                  <ct-hstack gap="2" align="center">
                                    <ct-vstack gap="0" style="width: 24px;">
                                      <ct-button
                                        variant="ghost"
                                        onClick={() =>
                                          movePersonUp.send({
                                            name: person.name,
                                          })}
                                      >
                                        ^
                                      </ct-button>
                                      <ct-button
                                        variant="ghost"
                                        onClick={() =>
                                          movePersonDown.send({
                                            name: person.name,
                                          })}
                                      >
                                        v
                                      </ct-button>
                                    </ct-vstack>
                                    <ct-vstack gap="0" style="flex: 1;">
                                      <span style={{ fontWeight: "500" }}>
                                        {person.name}
                                      </span>
                                      <span style={{ fontSize: "0.8rem", color: "var(--ct-color-gray-500)" }}>
                                        {person.email}
                                      </span>
                                    </ct-vstack>
                                    <span
                                      style={{
                                        padding: "2px 8px",
                                        borderRadius: "12px",
                                        fontSize: "0.75rem",
                                        backgroundColor: "#f3f4f6",
                                      }}
                                    >
                                      {COMMUTE_LABELS[person.commuteMode] ||
                                        person.commuteMode}
                                    </span>
                                    {computed(() => person.defaultSpot > 0)
                                      ? (
                                        <span style={{ fontSize: "0.8rem", color: "var(--ct-color-gray-500)" }}>
                                          Default: #{person.defaultSpot}
                                        </span>
                                      )
                                      : null}
                                    <ct-button
                                      variant="ghost"
                                      onClick={() => {
                                        if (
                                          editingPerson.get() === person.name
                                        ) {
                                          editingPerson.set("");
                                        } else {
                                          editingPerson.set(person.name);
                                          editPersonDefaultSpot.set(
                                            person.defaultSpot || 0,
                                          );
                                        }
                                      }}
                                    >
                                      {isEditingThis ? "Close" : "Edit"}
                                    </ct-button>
                                    <ct-button
                                      variant="ghost"
                                      onClick={() =>
                                        removePerson.send({
                                          name: person.name,
                                        })}
                                    >
                                      Remove
                                    </ct-button>
                                  </ct-hstack>

                                  {isEditingThis
                                    ? (
                                      <ct-vstack
                                        gap="2"
                                        style="padding: 8px; background: #f9fafb; border-radius: 8px;"
                                      >
                                        <ct-hstack gap="2" align="center">
                                          <span style={{ fontSize: "0.875rem", width: "100px" }}>
                                            Default Spot:
                                          </span>
                                          <ct-select
                                            $value={editPersonDefaultSpot}
                                            items={computed(() => [
                                              { label: "None", value: 0 },
                                              ...spots.get().map((s) => ({
                                                label: `#${s.number}${s.label ? ` (${s.label})` : ""}`,
                                                value: s.number,
                                              })),
                                            ])}
                                          />
                                          <ct-button
                                            variant="primary"
                                            onClick={() =>
                                              setDefaultSpot.send({
                                                personName: person.name,
                                                spotNumber:
                                                  editPersonDefaultSpot.get(),
                                              })}
                                          >
                                            Save
                                          </ct-button>
                                        </ct-hstack>
                                        <span style={{ fontSize: "0.8rem", color: "var(--ct-color-gray-500)" }}>
                                          Preferences:{" "}
                                          {computed(() => {
                                            const prefs =
                                              person.spotPreferences || [];
                                            return prefs.length > 0
                                              ? prefs
                                                  .map((p: number) => `#${p}`)
                                                  .join(", ")
                                              : "None set";
                                          })}
                                        </span>
                                        <ct-vstack gap="1">
                                          <span style={{ fontSize: "0.8rem", fontWeight: "500" }}>
                                            Set Spot Preferences:
                                          </span>
                                          {spots.map((s) => {
                                            const isSelected = computed(() =>
                                              (person.spotPreferences || []).some((p: number) => p === s.number)
                                            );
                                            return (
                                              <ct-hstack gap="1" align="center">
                                                <ct-checkbox
                                                  $checked={isSelected}
                                                  onct-change={() => {
                                                    const currentPrefs = person.spotPreferences || [];
                                                    const spotNum = s.number;
                                                    let newPrefs: number[];
                                                    if (currentPrefs.some((p: number) => p === spotNum)) {
                                                      newPrefs = currentPrefs.filter((p: number) => p !== spotNum);
                                                    } else {
                                                      newPrefs = [...currentPrefs, spotNum];
                                                    }
                                                    setSpotPreferences.send({
                                                      personName: person.name,
                                                      preferences: newPrefs,
                                                    });
                                                  }}
                                                />
                                                <span style={{ fontSize: "0.8rem" }}>
                                                  #{s.number}{s.label ? ` (${s.label})` : ""}
                                                </span>
                                              </ct-hstack>
                                            );
                                          })}
                                        </ct-vstack>
                                      </ct-vstack>
                                    )
                                    : null}
                                </ct-vstack>
                              </ct-card>
                            );
                          })}

                      {/* Add person form */}
                      {computed(() => showAddPerson.get())
                        ? (
                          <ct-card>
                            <ct-vstack gap="2">
                              <span style={{ fontWeight: "500" }}>
                                Add Person
                              </span>
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
                              <ct-hstack gap="2">
                                <ct-button
                                  variant="primary"
                                  onClick={() => {
                                    addPerson.send({
                                      name: newPersonName.get(),
                                      email: newPersonEmail.get(),
                                      commuteMode: newPersonCommute.get(),
                                    });
                                    newPersonName.set("");
                                    newPersonEmail.set("");
                                    newPersonCommute.set("drive");
                                    showAddPerson.set(false);
                                  }}
                                >
                                  Add
                                </ct-button>
                                <ct-button
                                  variant="ghost"
                                  onClick={() => showAddPerson.set(false)}
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
                            onClick={() => showAddPerson.set(true)}
                          >
                            + Add Person
                          </ct-button>
                        )}
                    </ct-vstack>

                    <div style={{ borderTop: "1px solid #e5e7eb", margin: "8px 0" }} />

                    {/* ---- Spots Section ---- */}
                    <ct-vstack gap="2">
                      <span style={{ fontWeight: "600", fontSize: "1rem" }}>
                        Parking Spots
                      </span>

                      {noSpots
                        ? (
                          <div style={{ color: "var(--ct-color-gray-500)", padding: "1rem" }}>
                            No spots configured.
                          </div>
                        )
                        : spots.map((spot) => {
                            const isEditingThis = computed(
                              () => editingSpot.get() === spot.number,
                            );

                            return (
                              <ct-card>
                                <ct-vstack gap="1">
                                  <ct-hstack gap="2" align="center">
                                    <span
                                      style={{
                                        fontWeight: "600",
                                        fontSize: "1rem",
                                      }}
                                    >
                                      #{spot.number}
                                    </span>
                                    <span style={{ flex: "1", color: "var(--ct-color-gray-500)", fontSize: "0.875rem" }}>
                                      {spot.label}
                                    </span>
                                    <ct-button
                                      variant="ghost"
                                      onClick={() => {
                                        if (
                                          editingSpot.get() === spot.number
                                        ) {
                                          editingSpot.set(-1);
                                        } else {
                                          editingSpot.set(spot.number);
                                          editSpotLabel.set(spot.label || "");
                                          editSpotNotes.set(spot.notes || "");
                                        }
                                      }}
                                    >
                                      {isEditingThis ? "Close" : "Edit"}
                                    </ct-button>
                                    <ct-button
                                      variant="ghost"
                                      onClick={() =>
                                        removeSpot.send({
                                          number: spot.number,
                                        })}
                                    >
                                      Remove
                                    </ct-button>
                                  </ct-hstack>
                                  {spot.notes
                                    ? (
                                      <span style={{ fontSize: "0.8rem", color: "var(--ct-color-gray-400)" }}>
                                        {spot.notes}
                                      </span>
                                    )
                                    : null}

                                  {isEditingThis
                                    ? (
                                      <ct-vstack
                                        gap="2"
                                        style="padding: 8px; background: #f9fafb; border-radius: 8px;"
                                      >
                                        <span style={{ fontSize: "0.8rem", color: "var(--ct-color-gray-500)" }}>
                                          Spot #{spot.number} (number cannot be
                                          changed)
                                        </span>
                                        <ct-input
                                          $value={editSpotLabel}
                                          placeholder="Label (e.g., Near entrance)"
                                        />
                                        <ct-input
                                          $value={editSpotNotes}
                                          placeholder="Notes"
                                        />
                                        <ct-hstack gap="2">
                                          <ct-button
                                            variant="primary"
                                            onClick={() => {
                                              editSpot.send({
                                                number: spot.number,
                                                label: editSpotLabel.get(),
                                                notes: editSpotNotes.get(),
                                              });
                                              editingSpot.set(-1);
                                            }}
                                          >
                                            Save
                                          </ct-button>
                                          <ct-button
                                            variant="ghost"
                                            onClick={() =>
                                              editingSpot.set(-1)}
                                          >
                                            Cancel
                                          </ct-button>
                                        </ct-hstack>
                                      </ct-vstack>
                                    )
                                    : null}
                                </ct-vstack>
                              </ct-card>
                            );
                          })}

                      {/* Add spot form */}
                      {computed(() => showAddSpot.get())
                        ? (
                          <ct-card>
                            <ct-vstack gap="2">
                              <span style={{ fontWeight: "500" }}>
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
                              <ct-hstack gap="2">
                                <ct-button
                                  variant="primary"
                                  onClick={() => {
                                    const num = parseInt(newSpotNumber.get());
                                    if (num > 0) {
                                      addSpot.send({
                                        number: num,
                                        label: newSpotLabel.get(),
                                        notes: newSpotNotes.get(),
                                      });
                                      newSpotNumber.set("");
                                      newSpotLabel.set("");
                                      newSpotNotes.set("");
                                      showAddSpot.set(false);
                                    }
                                  }}
                                >
                                  Add
                                </ct-button>
                                <ct-button
                                  variant="ghost"
                                  onClick={() => showAddSpot.set(false)}
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
                            onClick={() => showAddSpot.set(true)}
                          >
                            + Add Spot
                          </ct-button>
                        )}
                    </ct-vstack>

                    <div style={{ borderTop: "1px solid #e5e7eb", margin: "8px 0" }} />

                    {/* ---- Manual Assign Section ---- */}
                    <ct-vstack gap="2">
                      <span style={{ fontWeight: "600", fontSize: "1rem" }}>
                        Manual Assignment
                      </span>
                      {computed(() => {
                        const pendingReqs = requests.get().filter(
                          (r) => r.status === "pending"
                        );
                        if (pendingReqs.length === 0) {
                          return (
                            <div style={{ color: "var(--ct-color-gray-500)", padding: "1rem" }}>
                              No pending requests to assign.
                            </div>
                          );
                        }
                        return pendingReqs.map((req) => {
                          const rowSpot = Writable.of(0);
                          const taken = requests.get()
                            .filter(
                              (r) =>
                                r.requestedDate === req.requestedDate &&
                                r.status === "allocated" &&
                                r.assignedSpot > 0,
                            )
                            .map((r) => r.assignedSpot);
                          const freeSpots = spots.get().filter(
                            (s) => !taken.includes(s.number)
                          );
                          const spotItems = [
                            { label: "Select spot...", value: 0 },
                            ...freeSpots.map((s) => ({
                              label: `#${s.number}${s.label ? ` (${s.label})` : ""}`,
                              value: s.number,
                            })),
                          ];
                          return (
                            <ct-card>
                              <ct-hstack gap="2" align="center" justify="between">
                                <ct-vstack gap="0">
                                  <span style={{ fontWeight: "500" }}>
                                    {req.personName}
                                  </span>
                                  <span style={{ fontSize: "0.8rem", color: "var(--ct-color-gray-500)" }}>
                                    {formatDay(req.requestedDate)}{" "}
                                    {formatDate(req.requestedDate)}
                                  </span>
                                </ct-vstack>
                                <ct-hstack gap="1" align="center">
                                  <ct-select
                                    $value={rowSpot}
                                    items={spotItems}
                                  />
                                  <ct-button
                                    variant="primary"
                                    onClick={() => {
                                      const spotNum = rowSpot.get();
                                      if (spotNum > 0) {
                                        manualAssign.send({
                                          personName: req.personName,
                                          date: req.requestedDate,
                                          spotNumber: spotNum,
                                        });
                                        rowSpot.set(0);
                                      }
                                    }}
                                  >
                                    Assign
                                  </ct-button>
                                </ct-hstack>
                              </ct-hstack>
                            </ct-card>
                          );
                        });
                      })}
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
      requestSpot,
      cancelRequest,
      addPerson,
      removePerson,
      movePersonUp,
      movePersonDown,
      setDefaultSpot,
      setSpotPreferences,
      addSpot,
      editSpot,
      removeSpot,
      manualAssign,
    };
  },
);
