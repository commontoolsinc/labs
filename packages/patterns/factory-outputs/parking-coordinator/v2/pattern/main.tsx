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

// ===== Utility =====

/** Today's date as YYYY-MM-DD */
const getTodayDate = (): string => new Date().toISOString().split("T")[0];

/** Get date string N days from today */
const getDateOffset = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
};

/** Format a YYYY-MM-DD date for display (e.g. "Mon 2/24") */
const formatShortDate = (dateStr: string): string => {
  const d = new Date(dateStr + "T12:00:00");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${days[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
};

let _idCounter = 0;
const genId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${++_idCounter}`;

// ===== Types =====

export interface ParkingSpot {
  id: string;
  number: string;
  label: Default<string, "">;
  notes: Default<string, "">;
}

export type CommuteMode = "drive" | "transit" | "bike" | "wfh" | "other";

export interface Person {
  id: string;
  name: string;
  email: Default<string, "">;
  usualCommuteMode: Default<CommuteMode, "drive">;
  /** Ordered list of preferred spot IDs */
  spotPreferences: Default<string[], []>;
  /** Default spot ID, or empty string for none */
  defaultSpotId: Default<string, "">;
}

export type RequestStatus = "pending" | "allocated" | "denied" | "cancelled";

export interface SpotRequest {
  id: string;
  personId: string;
  date: string; // YYYY-MM-DD
  status: RequestStatus;
  /** Spot ID when allocated */
  assignedSpotId: Default<string, "">;
  autoAllocated: Default<boolean, true>;
}

// ===== Initial Data =====

export const INITIAL_SPOTS: ParkingSpot[] = [
  { id: "spot-1", number: "1", label: "", notes: "" },
  { id: "spot-5", number: "5", label: "", notes: "" },
  { id: "spot-12", number: "12", label: "", notes: "" },
];

// ===== Pattern Input / Output =====

interface ParkingCoordinatorInput {
  spots?: Writable<Default<ParkingSpot[], typeof INITIAL_SPOTS>>;
  persons?: Writable<Default<Person[], []>>;
  requests?: Writable<Default<SpotRequest[], []>>;
  /** Priority ordering: list of person IDs from highest to lowest priority */
  priorityOrder?: Writable<Default<string[], []>>;
}

interface ParkingCoordinatorOutput {
  [NAME]: string;
  [UI]: VNode;

  // Exposed state
  spots: ParkingSpot[];
  persons: Person[];
  requests: SpotRequest[];
  priorityOrder: string[];

  // Person CRUD
  addPerson: Stream<{
    name: string;
    email: string;
    usualCommuteMode: CommuteMode;
  }>;
  removePerson: Stream<{ personId: string }>;
  setDefaultSpot: Stream<{ personId: string; spotId: string }>;
  setSpotPreferences: Stream<{ personId: string; spotIds: string[] }>;
  movePriorityUp: Stream<{ personId: string }>;
  movePriorityDown: Stream<{ personId: string }>;

  // Spot CRUD
  addSpot: Stream<{ number: string; label: string; notes: string }>;
  removeSpot: Stream<{ spotId: string }>;
  editSpot: Stream<{ spotId: string; label: string; notes: string }>;

  // Request actions
  requestParking: Stream<{ personId: string; date: string }>;
  cancelRequest: Stream<{ requestId: string }>;
  manualOverride: Stream<{
    personId: string;
    date: string;
    spotId: string;
  }>;
}

// ===== Helpers (module scope) =====

/** Check if a person already has a non-cancelled request for a date */
const hasActiveRequest = (
  allRequests: readonly SpotRequest[],
  personId: string,
  date: string,
): boolean =>
  allRequests.some(
    (r) =>
      r.personId === personId &&
      r.date === date &&
      (r.status === "allocated" || r.status === "pending"),
  );

// ===== Helper: auto-allocation logic (module scope) =====

const allocateSpot = (
  personId: string,
  date: string,
  allSpots: readonly ParkingSpot[],
  allPersons: readonly Person[],
  allRequests: readonly SpotRequest[],
): string => {
  // Find spots already allocated for this date
  const allocatedSpotIds = new Set(
    allRequests
      .filter(
        (r) =>
          r.date === date &&
          r.status === "allocated" &&
          (r.assignedSpotId ?? "") !== "",
      )
      .map((r) => r.assignedSpotId as string),
  );

  const availableSpotIds = allSpots
    .filter((s) => !allocatedSpotIds.has(s.id))
    .map((s) => s.id);

  if (availableSpotIds.length === 0) return ""; // No spots free

  const person = allPersons.find((p) => p.id === personId);
  if (!person) return "";

  // 1. Try default spot
  const defaultId = (person.defaultSpotId as string) ?? "";
  if (defaultId && availableSpotIds.includes(defaultId)) {
    return defaultId;
  }

  // 2. Try preferences in order
  const prefs = (person.spotPreferences as string[]) ?? [];
  for (const prefId of prefs) {
    if (availableSpotIds.includes(prefId)) {
      return prefId;
    }
  }

  // 3. Any free spot
  return availableSpotIds[0];
};

// ===== Main Pattern =====

export default pattern<ParkingCoordinatorInput, ParkingCoordinatorOutput>(
  ({ spots, persons, requests, priorityOrder }) => {
    const TODAY = getTodayDate();


    // ---- Local UI state ----
    const adminMode = Writable.of(false);
    // Views: "main" | "request-form" | "admin-persons" | "admin-spots" | "add-person" | "add-spot" | "edit-spot" | "edit-person" | "my-requests"
    const currentView = Writable.of<string>("main");
    const selectedPersonId = Writable.of<string>("");

    // Request form state
    const reqPersonId = Writable.of<string>("");
    const reqDate = Writable.of<string>(TODAY);
    const reqMessage = Writable.of<string>("");

    // Add person form state
    const newPersonName = Writable.of<string>("");
    const newPersonEmail = Writable.of<string>("");
    const newPersonCommute = Writable.of<CommuteMode>("drive");

    // Add spot form state
    const newSpotNumber = Writable.of<string>("");
    const newSpotLabel = Writable.of<string>("");
    const newSpotNotes = Writable.of<string>("");

    // Edit spot form state
    const editSpotId = Writable.of<string>("");
    const editSpotLabel = Writable.of<string>("");
    const editSpotNotes = Writable.of<string>("");

    // Edit person form state (default spot + preferences)
    const editPersonId = Writable.of<string>("");
    const editPersonDefaultSpot = Writable.of<string>("");
    const editPersonPrefs = Writable.of<string[]>([]);
    const editPersonAddPrefSpotId = Writable.of<string>("");

    // ---- Actions ----

    // --- Person CRUD ---

    const addPerson = action(
      (event: {
        name: string;
        email: string;
        usualCommuteMode: CommuteMode;
      }) => {
        const trimmed = event.name.trim();
        if (!trimmed) return;
        const id = genId("person");
        persons.push({
          id,
          name: trimmed,
          email: event.email ?? "",
          usualCommuteMode: event.usualCommuteMode ?? "drive",
          spotPreferences: [],
          defaultSpotId: "",
        });
        // Add to bottom of priority list
        const current = priorityOrder.get();
        priorityOrder.set([...current, id]);
      },
    );

    const removePerson = action((event: { personId: string }) => {
      const { personId } = event;

      // Remove from persons
      const currentPersons = persons.get();
      const filtered = currentPersons.filter((p: Person) => p.id !== personId);
      persons.set(filtered);

      // Remove from priority order
      const currentPriority = priorityOrder.get();
      priorityOrder.set(currentPriority.filter((id: string) => id !== personId));

      // Cancel upcoming allocated requests for this person
      const currentRequests = requests.get();
      let requestsChanged = false;
      const updated = currentRequests.map((r: SpotRequest) => {
        if (
          r.personId === personId &&
          r.date >= TODAY &&
          r.status === "allocated"
        ) {
          requestsChanged = true;
          return { ...r, status: "cancelled" as RequestStatus, assignedSpotId: "" };
        }
        return r;
      });
      if (requestsChanged) {
        requests.set(updated);
      }
    });

    const setDefaultSpot = action(
      (event: { personId: string; spotId: string }) => {
        const currentPersons = persons.get();
        persons.set(
          currentPersons.map((p: Person) =>
            p.id === event.personId
              ? { ...p, defaultSpotId: event.spotId }
              : p
          ),
        );
      },
    );

    const setSpotPreferences = action(
      (event: { personId: string; spotIds: string[] }) => {
        const currentPersons = persons.get();
        persons.set(
          currentPersons.map((p: Person) =>
            p.id === event.personId
              ? { ...p, spotPreferences: event.spotIds }
              : p
          ),
        );
      },
    );

    const movePriorityUp = action((event: { personId: string }) => {
      const current = priorityOrder.get();
      const idx = current.indexOf(event.personId);
      if (idx > 0) {
        const updated = [...current];
        [updated[idx - 1], updated[idx]] = [updated[idx], updated[idx - 1]];
        priorityOrder.set(updated);
      }
    });

    const movePriorityDown = action((event: { personId: string }) => {
      const current = priorityOrder.get();
      const idx = current.indexOf(event.personId);
      if (idx >= 0 && idx < current.length - 1) {
        const updated = [...current];
        [updated[idx], updated[idx + 1]] = [updated[idx + 1], updated[idx]];
        priorityOrder.set(updated);
      }
    });

    // --- Spot CRUD ---

    const addSpot = action(
      (event: { number: string; label: string; notes: string }) => {
        const trimmed = event.number.trim();
        if (!trimmed) return;
        // Check uniqueness
        const existing = spots.get();
        if (existing.some((s: ParkingSpot) => s.number === trimmed)) return;
        spots.push({
          id: genId("spot"),
          number: trimmed,
          label: event.label ?? "",
          notes: event.notes ?? "",
        });
      },
    );

    const removeSpot = action((event: { spotId: string }) => {
      const { spotId } = event;
      // Cancel upcoming allocated requests for this spot
      const currentRequests = requests.get();
      const updated = currentRequests.map((r: SpotRequest) => {
        if (
          (r.assignedSpotId as string) === spotId &&
          r.date >= TODAY &&
          r.status === "allocated"
        ) {
          return {
            ...r,
            status: "denied" as RequestStatus,
            assignedSpotId: "",
          };
        }
        return r;
      });
      requests.set(updated);

      // Remove from all persons' preferences and defaults (only if needed)
      const currentPersons = persons.get();
      let personsChanged = false;
      const updatedPersons = currentPersons.map((p: Person) => {
        const prefs = (p.spotPreferences as string[]) ?? [];
        const defaultId = (p.defaultSpotId as string) ?? "";
        const needsUpdate =
          prefs.includes(spotId) || defaultId === spotId;
        if (needsUpdate) {
          personsChanged = true;
          return {
            ...p,
            spotPreferences: prefs.filter((id: string) => id !== spotId),
            defaultSpotId: defaultId === spotId ? "" : defaultId,
          };
        }
        return p;
      });
      if (personsChanged) {
        persons.set(updatedPersons);
      }

      // Remove the spot
      const currentSpots = spots.get();
      spots.set(currentSpots.filter((s: ParkingSpot) => s.id !== spotId));
    });

    const editSpotAction = action(
      (event: { spotId: string; label: string; notes: string }) => {
        const currentSpots = spots.get();
        const idx = currentSpots.findIndex(
          (s: ParkingSpot) => s.id === event.spotId,
        );
        if (idx < 0) return;
        spots.set(
          currentSpots.toSpliced(idx, 1, {
            ...currentSpots[idx],
            label: event.label,
            notes: event.notes,
          }),
        );
      },
    );

    // --- Request actions ---

    const requestParking = action(
      (event: { personId: string; date: string }) => {
        const { personId, date } = event;
        if (!personId || !date) return;

        // Check for duplicate active request
        const currentRequests = requests.get();
        if (hasActiveRequest(currentRequests, personId, date)) return;

        const allSpots = spots.get();
        const allPersons = persons.get();

        // Run auto-allocation
        const assignedSpotId = allocateSpot(
          personId,
          date,
          allSpots,
          allPersons,
          currentRequests,
        );

        const newRequest: SpotRequest = {
          id: genId("req"),
          personId,
          date,
          status: assignedSpotId ? "allocated" : "denied",
          assignedSpotId: assignedSpotId || "",
          autoAllocated: true,
        };

        console.log("[DEBUG requestParking] pushing request:", JSON.stringify(newRequest), "requests before push:", currentRequests.length);
        requests.push(newRequest);
        console.log("[DEBUG requestParking] requests after push:", requests.get().length);
      },
    );

    const cancelRequest = action((event: { requestId: string }) => {
      const currentRequests = requests.get();
      requests.set(
        currentRequests.map((r: SpotRequest) =>
          r.id === event.requestId && r.status === "allocated"
            ? { ...r, status: "cancelled" as RequestStatus, assignedSpotId: "" }
            : r
        ),
      );
    });

    const manualOverride = action(
      (event: { personId: string; date: string; spotId: string }) => {
        const { personId, date, spotId } = event;
        if (!personId || !date || !spotId) return;

        // Check spot is available on that date
        const currentRequests = requests.get();
        const spotTaken = currentRequests.some(
          (r: SpotRequest) =>
            r.date === date &&
            r.status === "allocated" &&
            (r.assignedSpotId as string) === spotId,
        );
        if (spotTaken) return;

        // Check if person already has an active request for this date
        const hasExisting = currentRequests.some(
          (r: SpotRequest) =>
            r.personId === personId &&
            r.date === date &&
            (r.status === "allocated" || r.status === "pending"),
        );

        if (hasExisting) {
          // Update existing request
          requests.set(
            currentRequests.map((r: SpotRequest) =>
              r.personId === personId &&
              r.date === date &&
              (r.status === "allocated" || r.status === "pending")
                ? {
                    ...r,
                    status: "allocated" as RequestStatus,
                    assignedSpotId: spotId,
                    autoAllocated: false,
                  }
                : r
            ),
          );
        } else {
          // Create new allocated request
          requests.push({
            id: genId("req"),
            personId,
            date,
            status: "allocated" as RequestStatus,
            assignedSpotId: spotId,
            autoAllocated: false,
          });
        }
      },
    );

    // ---- Computed values ----

    const spotCount = computed(() => spots.get().length);
    const personCount = computed(() => persons.get().length);
    const requestCount = computed(() => requests.get().length);
    const hasNoPersons = computed(() => persons.get().length === 0);

    // Today's allocations: for each spot, who has it today
    const todayAllocations = computed(() => {
      const allSpots = spots.get();
      const allPersons = persons.get();
      const allRequests = requests.get();
      console.log("[DEBUG todayAllocations] requests count:", allRequests.length, "allocated:", allRequests.filter((r: SpotRequest) => r?.status === "allocated").length);
      return allSpots
        .filter((spot: ParkingSpot) => spot && spot.id != null)
        .map((spot: ParkingSpot) => {
          const req = allRequests.find(
            (r: SpotRequest) =>
              r?.date === TODAY &&
              r?.status === "allocated" &&
              (r?.assignedSpotId as string) === spot.id,
          );
          const personName = req
            ? (allPersons.find((p: Person) => p?.id === req.personId)?.name ?? "Unknown")
            : null;
          return {
            spot,
            personName,
            requestId: req?.id ?? "",
            occupied: !!req,
          };
        });
    });

    // Week-ahead data: 7 days starting from today
    const weekDays = computed(() => {
      const days: string[] = [];
      for (let i = 0; i < 7; i++) {
        days.push(getDateOffset(i));
      }
      return days;
    });

    const weekGrid = computed(() => {
      const allSpots = spots.get();
      const allPersons = persons.get();
      const allRequests = requests.get();
      const days: string[] = weekDays;
      console.log("[DEBUG weekGrid] spots:", allSpots.length, "requests:", allRequests.length, "days:", Array.isArray(days) ? days.length : typeof days, "days value:", JSON.stringify(days));

      return allSpots
        .filter((spot: ParkingSpot) => spot && spot.id != null)
        .map((spot: ParkingSpot) => {
          const dayCells = days.map((day: string) => {
            const req = allRequests.find(
              (r: SpotRequest) =>
                r?.date === day &&
                r?.status === "allocated" &&
                (r?.assignedSpotId as string) === spot.id,
            );
            const personName = req
              ? (allPersons.find((p: Person) => p?.id === req.personId)?.name ??
                "?")
              : "";
            return { day, personName, occupied: !!req };
          });
          return { spot, cells: dayCells };
        });
    });

    // My requests (filtered by selected person)
    const myRequests = computed(() => {
      const pid = selectedPersonId.get();
      if (!pid) return [];
      const allRequests = requests.get();
      const allSpots = spots.get();
      return allRequests
        .filter((r: SpotRequest) => r && r.personId === pid)
        .map((r: SpotRequest) => {
          const spot = allSpots.find(
            (s: ParkingSpot) => s?.id === (r.assignedSpotId as string),
          );
          return {
            ...r,
            spotNumber: spot?.number ?? "-",
          };
        })
        .sort((a: SpotRequest & { spotNumber: string }, b: SpotRequest & { spotNumber: string }) =>
          (b?.date ?? "").localeCompare(a?.date ?? "")
        );
    });

    // Priority list: persons in priority order with names
    const priorityList = computed(() => {
      const allPersons = persons.get();
      const order = priorityOrder.get();
      return order
        .map((id: string) => allPersons.find((p: Person) => p.id === id))
        .filter((p: Person | undefined): p is Person => !!p);
    });

    // Person options for select
    const personOptions = computed(() => {
      return [
        { label: "Select person...", value: "" },
        ...persons.get()
          .filter((p: Person) => p && p.name != null)
          .map((p: Person) => ({
            label: p.name,
            value: p.id,
          })),
      ];
    });

    // Spot options for select
    const spotOptions = computed(() => {
      return [
        { label: "None", value: "" },
        ...spots.get()
          .filter((s: ParkingSpot) => s && s.number != null)
          .map((s: ParkingSpot) => ({
            label: `#${s.number}${(s.label as string) ? ` (${s.label})` : ""}`,
            value: s.id,
          })),
      ];
    });

    const commuteOptions = [
      { label: "Drive", value: "drive" },
      { label: "Transit", value: "transit" },
      { label: "Bike", value: "bike" },
      { label: "WFH", value: "wfh" },
      { label: "Other", value: "other" },
    ];

    // ---- UI Navigation actions ----

    const openRequestForm = action(() => {
      reqPersonId.set("");
      reqDate.set(TODAY);
      reqMessage.set("");
      currentView.set("request-form");
    });

    const submitRequest = action(() => {
      const personId = reqPersonId.get();
      const date = reqDate.get();
      if (!personId || !date) {
        reqMessage.set("Please select a person and date.");
        return;
      }
      if (date < TODAY) {
        reqMessage.set("Cannot request parking for a past date.");
        return;
      }
      // Check duplicate
      const currentRequests = requests.get();
      if (hasActiveRequest(currentRequests, personId, date)) {
        reqMessage.set("This person already has an active request for this date.");
        return;
      }
      // Compute the expected allocation result before sending
      const allSpots = spots.get();
      const allPersons = persons.get();
      const assignedSpotId = allocateSpot(
        personId,
        date,
        allSpots,
        allPersons,
        currentRequests,
      );

      requestParking.send({ personId, date });

      // Show result and navigate back to main view on success
      if (assignedSpotId) {
        const spot = allSpots.find(
          (s: ParkingSpot) => s.id === assignedSpotId,
        );
        reqMessage.set(`Allocated spot #${spot?.number ?? "?"}!`);
        currentView.set("main");
      } else {
        reqMessage.set("Denied: no spots available for this date.");
      }
    });

    const openAddPerson = action(() => {
      newPersonName.set("");
      newPersonEmail.set("");
      newPersonCommute.set("drive");
      currentView.set("add-person");
    });

    const submitAddPerson = action(() => {
      const name = newPersonName.get().trim();
      if (!name) return;
      addPerson.send({
        name,
        email: newPersonEmail.get(),
        usualCommuteMode: newPersonCommute.get(),
      });
      currentView.set("admin-persons");
    });

    const openAddSpot = action(() => {
      newSpotNumber.set("");
      newSpotLabel.set("");
      newSpotNotes.set("");
      currentView.set("add-spot");
    });

    const submitAddSpot = action(() => {
      const num = newSpotNumber.get().trim();
      if (!num) return;
      addSpot.send({
        number: num,
        label: newSpotLabel.get(),
        notes: newSpotNotes.get(),
      });
      currentView.set("admin-spots");
    });

    const openEditSpot = action((event: { spotId: string }) => {
      const spot = spots
        .get()
        .find((s: ParkingSpot) => s.id === event.spotId);
      if (!spot) return;
      editSpotId.set(spot.id);
      editSpotLabel.set((spot.label as string) ?? "");
      editSpotNotes.set((spot.notes as string) ?? "");
      currentView.set("edit-spot");
    });

    const submitEditSpot = action(() => {
      const spotId = editSpotId.get();
      if (!spotId) return;
      editSpotAction.send({
        spotId,
        label: editSpotLabel.get(),
        notes: editSpotNotes.get(),
      });
      currentView.set("admin-spots");
    });

    // --- Edit person navigation ---

    const openEditPerson = action((event: { personId: string }) => {
      const person = persons
        .get()
        .find((p: Person) => p.id === event.personId);
      if (!person) return;
      editPersonId.set(person.id);
      editPersonDefaultSpot.set((person.defaultSpotId as string) ?? "");
      editPersonPrefs.set([...((person.spotPreferences as string[]) ?? [])]);
      editPersonAddPrefSpotId.set("");
      currentView.set("edit-person");
    });

    const saveEditPerson = action(() => {
      const personId = editPersonId.get();
      if (!personId) return;
      setDefaultSpot.send({
        personId,
        spotId: editPersonDefaultSpot.get(),
      });
      setSpotPreferences.send({
        personId,
        spotIds: [...editPersonPrefs.get()],
      });
      currentView.set("admin-persons");
    });

    const addPrefSpot = action(() => {
      const spotId = editPersonAddPrefSpotId.get();
      if (!spotId) return;
      const current = editPersonPrefs.get();
      if (current.includes(spotId)) return; // already in list
      editPersonPrefs.set([...current, spotId]);
      editPersonAddPrefSpotId.set("");
    });

    const removePrefSpot = action((event: { spotId: string }) => {
      const current = editPersonPrefs.get();
      editPersonPrefs.set(current.filter((id: string) => id !== event.spotId));
    });

    const movePrefUp = action((event: { spotId: string }) => {
      const current = editPersonPrefs.get();
      const idx = current.indexOf(event.spotId);
      if (idx > 0) {
        const updated = [...current];
        [updated[idx - 1], updated[idx]] = [updated[idx], updated[idx - 1]];
        editPersonPrefs.set(updated);
      }
    });

    const movePrefDown = action((event: { spotId: string }) => {
      const current = editPersonPrefs.get();
      const idx = current.indexOf(event.spotId);
      if (idx >= 0 && idx < current.length - 1) {
        const updated = [...current];
        [updated[idx], updated[idx + 1]] = [updated[idx + 1], updated[idx]];
        editPersonPrefs.set(updated);
      }
    });

    // ---- View computed flags ----
    const isMainView = computed(() => currentView.get() === "main");
    const isRequestForm = computed(() => currentView.get() === "request-form");
    const isAdminPersons = computed(() => currentView.get() === "admin-persons");
    const isAdminSpots = computed(() => currentView.get() === "admin-spots");
    const isAddPerson = computed(() => currentView.get() === "add-person");
    const isAddSpot = computed(() => currentView.get() === "add-spot");
    const isEditSpot = computed(() => currentView.get() === "edit-spot");
    const isEditPerson = computed(() => currentView.get() === "edit-person");
    const isMyRequests = computed(() => currentView.get() === "my-requests");
    const isAdmin = computed(() => adminMode.get());

    /** Name of the person being edited, for the heading */
    const editPersonName = computed(() => {
      const pid = editPersonId.get();
      if (!pid) return "";
      const person = persons.get().find((p: Person) => p.id === pid);
      return person?.name ?? "";
    });

    /** Spots available to add as preferences (not already in the pref list) */
    const availablePrefSpots = computed(() => {
      const current = editPersonPrefs.get() ?? [];
      const allSpots = spots.get();
      return [
        { label: "Add spot...", value: "" },
        ...allSpots
          .filter((s: ParkingSpot) => s && !current.includes(s.id))
          .map((s: ParkingSpot) => ({
            label: `#${s.number}${(s.label as string) ? ` (${s.label})` : ""}`,
            value: s.id,
          })),
      ];
    });

    /** The current preference list with spot details for display */
    const editPersonPrefDetails = computed(() => {
      const prefs = editPersonPrefs.get() ?? [];
      const allSpots = spots.get();
      return prefs
        .map((spotId: string) => {
          const spot = allSpots.find((s: ParkingSpot) => s.id === spotId);
          return spot ? { id: spot.id, number: spot.number, label: (spot.label as string) ?? "" } : null;
        })
        .filter((s: { id: string; number: string; label: string } | null): s is { id: string; number: string; label: string } => !!s);
    });

    // ---- UI ----

    return {
      [NAME]: "Parking Coordinator",
      [UI]: (
        <ct-screen>
          {/* ===== HEADER ===== */}
          <ct-vstack slot="header" gap="1" style="overflow: hidden;">
            <ct-hstack justify="between" align="center" style="min-width: 0;">
              <ct-heading level={4} style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;">Parking Coordinator</ct-heading>
              <ct-button
                variant={isAdmin ? "primary" : "ghost"}
                onClick={() => adminMode.set(!adminMode.get())}
              >
                Admin
              </ct-button>
            </ct-hstack>
            {/* Nav tabs */}
            <ct-hstack gap="0" style="border-bottom: 1px solid var(--ct-color-gray-200); overflow: hidden;">
              <ct-button
                variant={isMainView ? "primary" : "ghost"}
                onClick={() => currentView.set("main")}
                style="flex: 1; border-radius: 0; min-width: 0; overflow: hidden;"
              >
                Today
              </ct-button>
              <ct-button
                variant={isMyRequests ? "primary" : "ghost"}
                onClick={() => currentView.set("my-requests")}
                style="flex: 1; border-radius: 0; min-width: 0; overflow: hidden;"
              >
                My Requests
              </ct-button>
              {isAdmin
                ? (
                  <ct-button
                    variant={isAdminPersons ? "primary" : "ghost"}
                    onClick={() => currentView.set("admin-persons")}
                    style="flex: 1; border-radius: 0; min-width: 0; overflow: hidden;"
                  >
                    People
                  </ct-button>
                )
                : null}
              {isAdmin
                ? (
                  <ct-button
                    variant={isAdminSpots ? "primary" : "ghost"}
                    onClick={() => currentView.set("admin-spots")}
                    style="flex: 1; border-radius: 0; min-width: 0; overflow: hidden;"
                  >
                    Spots
                  </ct-button>
                )
                : null}
            </ct-hstack>
          </ct-vstack>

          <ct-vscroll flex showScrollbar fadeEdges>
            {/* ===== MAIN VIEW: Today + Week Grid ===== */}
            {isMainView
              ? (
                <ct-vstack gap="3" style="padding: 1rem;">
                  {/* Request result message */}
                  {reqMessage
                    ? (
                      <div
                        style={{
                          padding: "0.5rem",
                          borderRadius: "4px",
                          fontSize: "0.875rem",
                          backgroundColor: "var(--ct-color-gray-100)",
                          fontWeight: "500",
                        }}
                      >
                        {reqMessage}
                      </div>
                    )
                    : null}
                  {/* Today's Status Panel */}
                  <ct-heading level={5}>
                    Today ({TODAY})
                  </ct-heading>
                  <ct-vstack gap="2">
                    {todayAllocations.map(
                      (alloc: {
                        spot: ParkingSpot;
                        personName: string | null;
                        requestId: string;
                        occupied: boolean;
                      }) => (
                        <ct-card
                          style={alloc.occupied
                            ? "border-left: 4px solid #dc2626;"
                            : "border-left: 4px solid #16a34a;"}
                        >
                          <ct-hstack justify="between" align="center">
                            <ct-vstack gap="0">
                              <span style={{ fontWeight: "600" }}>
                                Spot #{alloc.spot.number}
                              </span>
                              {(alloc.spot.label as string)
                                ? (
                                  <span style={{ fontSize: "0.75rem", color: "var(--ct-color-gray-500)" }}>
                                    {alloc.spot.label}
                                  </span>
                                )
                                : null}
                            </ct-vstack>
                            <span
                              style={{
                                fontWeight: "500",
                                color: alloc.occupied
                                  ? "#dc2626"
                                  : "#16a34a",
                              }}
                            >
                              {alloc.occupied ? alloc.personName : "Available"}
                            </span>
                          </ct-hstack>
                        </ct-card>
                      ),
                    )}
                  </ct-vstack>

                  {/* Week-Ahead Grid */}
                  <ct-heading level={5}>Week Ahead ({requestCount} requests)</ct-heading>
                  <ct-vstack gap="0" style="font-size: 0.8125rem;" key={requestCount}>
                    {/* Header row */}
                    <ct-hstack gap="0" style="border-bottom: 2px solid var(--ct-color-gray-300);">
                      <span style={{ flex: "1", padding: "6px 8px", fontWeight: "600" }}>
                        Spot
                      </span>
                      {weekDays.map((day: string) => (
                        <span
                          style={{
                            flex: "1",
                            padding: "6px 4px",
                            textAlign: "center",
                            fontWeight: day === TODAY ? "700" : "500",
                            backgroundColor:
                              day === TODAY
                                ? "var(--ct-color-gray-100)"
                                : "transparent",
                          }}
                        >
                          {formatShortDate(day)}
                        </span>
                      ))}
                    </ct-hstack>
                    {/* Data rows */}
                    {weekGrid.map(
                      (row: {
                        spot: ParkingSpot;
                        cells: {
                          day: string;
                          personName: string;
                          occupied: boolean;
                        }[];
                      }) => {
                        const occupiedCells = row.cells.filter((c: { occupied: boolean }) => c.occupied);
                        if (occupiedCells.length > 0) {
                          console.log("[DEBUG weekGrid render]", row.spot.number, "occupied cells:", JSON.stringify(occupiedCells));
                        }
                        return (
                        <ct-hstack gap="0" style="border-bottom: 1px solid var(--ct-color-gray-200);">
                          <span style={{ flex: "1", padding: "6px 8px", fontWeight: "500" }}>
                            #{row.spot.number}
                          </span>
                          {row.cells.map(
                            (cell: {
                              day: string;
                              personName: string;
                              occupied: boolean;
                            }) => (
                              <span
                                style={{
                                  flex: "1",
                                  padding: "6px 4px",
                                  textAlign: "center",
                                  backgroundColor: cell.occupied
                                    ? "#fee2e2"
                                    : cell.day === TODAY
                                      ? "var(--ct-color-gray-50)"
                                      : "transparent",
                                  fontSize: "0.75rem",
                                  color: cell.occupied
                                    ? "#dc2626"
                                    : "var(--ct-color-gray-400)",
                                }}
                              >
                                {cell.occupied ? cell.personName : "-"}
                              </span>
                            ),
                          )}
                        </ct-hstack>
                        );
                      },
                    )}
                  </ct-vstack>
                </ct-vstack>
              )
              : null}

            {/* ===== REQUEST FORM ===== */}
            {isRequestForm
              ? (
                <ct-vstack gap="3" style="padding: 1rem;">
                  <ct-heading level={5}>Request Parking</ct-heading>

                  {hasNoPersons
                    ? (
                      <div style={{ color: "var(--ct-color-gray-500)", padding: "1rem", textAlign: "center" }}>
                        No people registered yet. Ask an admin to add team members.
                      </div>
                    )
                    : null}

                  <ct-vstack gap="1">
                    <label>Person</label>
                    <ct-select $value={reqPersonId} items={personOptions} />
                  </ct-vstack>

                  <ct-vstack gap="1">
                    <label>Date</label>
                    <ct-input $value={reqDate} type="date" min={TODAY} max={getDateOffset(30)} />
                  </ct-vstack>

                  {reqMessage
                    ? (
                      <div
                        style={{
                          padding: "0.5rem",
                          borderRadius: "4px",
                          fontSize: "0.875rem",
                          backgroundColor: "var(--ct-color-gray-100)",
                          fontWeight: "500",
                        }}
                      >
                        {reqMessage}
                      </div>
                    )
                    : null}

                  <ct-hstack gap="2">
                    <ct-button
                      variant="primary"
                      onClick={submitRequest}
                      style="flex: 1;"
                    >
                      Submit Request
                    </ct-button>
                    <ct-button
                      variant="secondary"
                      onClick={() => currentView.set("main")}
                    >
                      Back
                    </ct-button>
                  </ct-hstack>
                </ct-vstack>
              )
              : null}

            {/* ===== MY REQUESTS ===== */}
            {isMyRequests
              ? (
                <ct-vstack gap="3" style="padding: 1rem;">
                  <ct-heading level={5}>My Requests</ct-heading>
                  <ct-vstack gap="1">
                    <label>Select your name</label>
                    <ct-select
                      $value={selectedPersonId}
                      items={personOptions}
                    />
                  </ct-vstack>

                  {myRequests.map(
                    (r: SpotRequest & { spotNumber: string }) => (
                      <ct-card>
                        <ct-hstack justify="between" align="center">
                          <ct-vstack gap="0">
                            <span style={{ fontWeight: "500" }}>
                              {r.date}
                            </span>
                            <span
                              style={{
                                fontSize: "0.75rem",
                                color:
                                  r.status === "allocated"
                                    ? "#16a34a"
                                    : r.status === "denied"
                                      ? "#dc2626"
                                      : "var(--ct-color-gray-500)",
                              }}
                            >
                              {r.status === "allocated"
                                ? `Spot #${r.spotNumber}`
                                : r.status === "denied"
                                  ? "Denied"
                                  : r.status === "cancelled"
                                    ? "Cancelled"
                                    : "Pending"}
                            </span>
                          </ct-vstack>
                          {r.status === "allocated" && r.date >= TODAY
                            ? (
                              <ct-button
                                variant="ghost"
                                onClick={() =>
                                  cancelRequest.send({ requestId: r.id })}
                              >
                                Cancel
                              </ct-button>
                            )
                            : null}
                        </ct-hstack>
                      </ct-card>
                    ),
                  )}
                </ct-vstack>
              )
              : null}

            {/* ===== ADMIN: PERSONS ===== */}
            {isAdminPersons
              ? (
                <ct-vstack gap="3" style="padding: 1rem;">
                  <ct-hstack justify="between" align="center">
                    <ct-heading level={5}>
                      Manage People ({personCount})
                    </ct-heading>
                    <ct-button variant="primary" onClick={openAddPerson}>
                      + Add Person
                    </ct-button>
                  </ct-hstack>

                  {/* Priority list */}
                  <ct-heading level={6}>Priority Order</ct-heading>
                  {priorityList.map((person: Person) => (
                    <ct-card>
                      <ct-vstack gap="1">
                        <ct-hstack justify="between" align="center">
                          <span style={{ fontWeight: "500" }}>
                            {person.name}
                          </span>
                          <span style={{ fontSize: "0.75rem", color: "var(--ct-color-gray-500)" }}>
                            {person.usualCommuteMode}
                          </span>
                        </ct-hstack>
                        <ct-hstack gap="1" justify="end">
                          <ct-button
                            variant="ghost"
                            onClick={() =>
                              movePriorityUp.send({ personId: person.id })}
                          >
                            Up
                          </ct-button>
                          <ct-button
                            variant="ghost"
                            onClick={() =>
                              movePriorityDown.send({ personId: person.id })}
                          >
                            Down
                          </ct-button>
                          <ct-button
                            variant="ghost"
                            onClick={() =>
                              openEditPerson.send({ personId: person.id })}
                          >
                            Edit
                          </ct-button>
                          <ct-button
                            variant="ghost"
                            onClick={() =>
                              removePerson.send({ personId: person.id })}
                            style="color: #dc2626;"
                          >
                            Del
                          </ct-button>
                        </ct-hstack>
                      </ct-vstack>
                    </ct-card>
                  ))}

                  {hasNoPersons
                    ? (
                      <div style={{ textAlign: "center", color: "var(--ct-color-gray-500)", padding: "2rem" }}>
                        No people added yet. Add team members to get started.
                      </div>
                    )
                    : null}
                </ct-vstack>
              )
              : null}

            {/* ===== ADMIN: SPOTS ===== */}
            {isAdminSpots
              ? (
                <ct-vstack gap="3" style="padding: 1rem;">
                  <ct-hstack justify="between" align="center">
                    <ct-heading level={5}>
                      Manage Spots ({spotCount})
                    </ct-heading>
                    <ct-button variant="primary" onClick={openAddSpot}>
                      + Add Spot
                    </ct-button>
                  </ct-hstack>

                  {spots.map((spot: ParkingSpot) => (
                    <ct-card>
                      <ct-hstack justify="between" align="center">
                        <ct-vstack gap="0">
                          <span style={{ fontWeight: "500" }}>
                            Spot #{spot.number}
                          </span>
                          {(spot.label as string)
                            ? (
                              <span style={{ fontSize: "0.75rem", color: "var(--ct-color-gray-500)" }}>
                                {spot.label}
                              </span>
                            )
                            : null}
                          {(spot.notes as string)
                            ? (
                              <span style={{ fontSize: "0.75rem", color: "var(--ct-color-gray-400)" }}>
                                {spot.notes}
                              </span>
                            )
                            : null}
                        </ct-vstack>
                        <ct-hstack gap="1">
                          <ct-button
                            variant="ghost"
                            onClick={() =>
                              openEditSpot.send({ spotId: spot.id })}
                          >
                            Edit
                          </ct-button>
                          <ct-button
                            variant="ghost"
                            onClick={() =>
                              removeSpot.send({ spotId: spot.id })}
                            style="color: #dc2626;"
                          >
                            Remove
                          </ct-button>
                        </ct-hstack>
                      </ct-hstack>
                    </ct-card>
                  ))}
                </ct-vstack>
              )
              : null}

            {/* ===== ADD PERSON FORM ===== */}
            {isAddPerson
              ? (
                <ct-vstack gap="3" style="padding: 1rem;">
                  <ct-heading level={5}>Add Person</ct-heading>
                  <ct-vstack gap="1">
                    <label>Name *</label>
                    <ct-input $value={newPersonName} placeholder="e.g. Alice" />
                  </ct-vstack>
                  <ct-vstack gap="1">
                    <label>Email (optional)</label>
                    <ct-input
                      $value={newPersonEmail}
                      placeholder="alice@example.com"
                    />
                  </ct-vstack>
                  <ct-vstack gap="1">
                    <label>Usual Commute Mode</label>
                    <ct-select
                      $value={newPersonCommute}
                      items={commuteOptions}
                    />
                  </ct-vstack>
                  <ct-hstack gap="2">
                    <ct-button
                      variant="primary"
                      onClick={submitAddPerson}
                      style="flex: 1;"
                    >
                      Add Person
                    </ct-button>
                    <ct-button
                      variant="secondary"
                      onClick={() => currentView.set("admin-persons")}
                    >
                      Cancel
                    </ct-button>
                  </ct-hstack>
                </ct-vstack>
              )
              : null}

            {/* ===== ADD SPOT FORM ===== */}
            {isAddSpot
              ? (
                <ct-vstack gap="3" style="padding: 1rem;">
                  <ct-heading level={5}>Add Parking Spot</ct-heading>
                  <ct-vstack gap="1">
                    <label>Spot Number *</label>
                    <ct-input $value={newSpotNumber} placeholder="e.g. 7" />
                  </ct-vstack>
                  <ct-vstack gap="1">
                    <label>Label (optional)</label>
                    <ct-input
                      $value={newSpotLabel}
                      placeholder="Near entrance"
                    />
                  </ct-vstack>
                  <ct-vstack gap="1">
                    <label>Notes (optional)</label>
                    <ct-input
                      $value={newSpotNotes}
                      placeholder="Van accessible"
                    />
                  </ct-vstack>
                  <ct-hstack gap="2">
                    <ct-button
                      variant="primary"
                      onClick={submitAddSpot}
                      style="flex: 1;"
                    >
                      Add Spot
                    </ct-button>
                    <ct-button
                      variant="secondary"
                      onClick={() => currentView.set("admin-spots")}
                    >
                      Cancel
                    </ct-button>
                  </ct-hstack>
                </ct-vstack>
              )
              : null}

            {/* ===== EDIT SPOT FORM ===== */}
            {isEditSpot
              ? (
                <ct-vstack gap="3" style="padding: 1rem;">
                  <ct-heading level={5}>Edit Parking Spot</ct-heading>
                  <ct-vstack gap="1">
                    <label>Label</label>
                    <ct-input $value={editSpotLabel} placeholder="Optional label" />
                  </ct-vstack>
                  <ct-vstack gap="1">
                    <label>Notes</label>
                    <ct-input $value={editSpotNotes} placeholder="Optional notes" />
                  </ct-vstack>
                  <ct-hstack gap="2">
                    <ct-button
                      variant="primary"
                      onClick={submitEditSpot}
                      style="flex: 1;"
                    >
                      Save Changes
                    </ct-button>
                    <ct-button
                      variant="secondary"
                      onClick={() => currentView.set("admin-spots")}
                      style="flex: 1;"
                    >
                      Cancel
                    </ct-button>
                  </ct-hstack>
                </ct-vstack>
              )
              : null}

            {/* ===== EDIT PERSON (Default Spot + Preferences) ===== */}
            {isEditPerson
              ? (
                <ct-vstack gap="3" style="padding: 1rem;">
                  <ct-heading level={5}>
                    Edit {editPersonName}
                  </ct-heading>

                  {/* Default Spot */}
                  <ct-vstack gap="1">
                    <label>Default Spot</label>
                    <ct-select
                      $value={editPersonDefaultSpot}
                      items={spotOptions}
                    />
                    <span style={{ fontSize: "0.75rem", color: "var(--ct-color-gray-500)" }}>
                      This spot is tried first when this person requests parking.
                    </span>
                  </ct-vstack>

                  {/* Spot Preferences */}
                  <ct-vstack gap="1">
                    <label>Spot Preferences (in order)</label>
                    <span style={{ fontSize: "0.75rem", color: "var(--ct-color-gray-500)" }}>
                      Tried in order when the default spot is unavailable.
                    </span>

                    {editPersonPrefDetails.map(
                      (pref: { id: string; number: string; label: string }) => (
                        <ct-card>
                          <ct-vstack gap="1">
                            <span style={{ fontWeight: "500" }}>
                              #{pref.number}
                              {pref.label ? ` (${pref.label})` : ""}
                            </span>
                            <ct-hstack gap="1" justify="end">
                              <ct-button
                                variant="ghost"
                                onClick={() =>
                                  movePrefUp.send({ spotId: pref.id })}
                              >
                                Up
                              </ct-button>
                              <ct-button
                                variant="ghost"
                                onClick={() =>
                                  movePrefDown.send({ spotId: pref.id })}
                              >
                                Down
                              </ct-button>
                              <ct-button
                                variant="ghost"
                                onClick={() =>
                                  removePrefSpot.send({ spotId: pref.id })}
                                style="color: #dc2626;"
                              >
                                Remove
                              </ct-button>
                            </ct-hstack>
                          </ct-vstack>
                        </ct-card>
                      ),
                    )}

                    {/* Add preference */}
                    <ct-hstack gap="1" align="end">
                      <ct-select
                        $value={editPersonAddPrefSpotId}
                        items={availablePrefSpots}
                        style="flex: 1;"
                      />
                      <ct-button
                        variant="secondary"
                        onClick={addPrefSpot}
                      >
                        Add
                      </ct-button>
                    </ct-hstack>
                  </ct-vstack>

                  {/* Save / Cancel */}
                  <ct-hstack gap="2">
                    <ct-button
                      variant="primary"
                      onClick={saveEditPerson}
                      style="flex: 1;"
                    >
                      Save
                    </ct-button>
                    <ct-button
                      variant="secondary"
                      onClick={() => currentView.set("admin-persons")}
                    >
                      Cancel
                    </ct-button>
                  </ct-hstack>
                </ct-vstack>
              )
              : null}
          </ct-vscroll>

          {/* ===== FOOTER ===== */}
          <ct-hstack slot="footer" gap="2" style="padding: 1rem;">
            <ct-button
              variant="primary"
              onClick={openRequestForm}
              style="flex: 1;"
            >
              Request Parking
            </ct-button>
          </ct-hstack>
        </ct-screen>
      ),

      // Exposed state
      spots,
      persons,
      requests,
      priorityOrder,

      // Exposed actions (for testing via .send())
      addPerson,
      removePerson,
      setDefaultSpot,
      setSpotPreferences,
      movePriorityUp,
      movePriorityDown,

      addSpot,
      removeSpot,
      editSpot: editSpotAction,

      requestParking,
      cancelRequest,
      manualOverride,
    };
  },
);
