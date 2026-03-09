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
  wish,
  Writable,
} from "commontools";

// ============================================================
// Domain Types
// ============================================================

export interface ParkingSpot {
  spotNumber: string;
  label: string;
  notes: string;
  active: boolean;
}

export type CommuteMode = "drive" | "transit" | "bike" | "wfh" | "other";

export interface Person {
  name: string;
  email: string;
  commuteMode: CommuteMode;
  spotPreferences: string[];
  defaultSpot: string;
  priorityRank: number;
}

export type RequestStatus = "pending" | "allocated" | "denied" | "cancelled";

export interface SpotRequest {
  id: string;
  personName: string;
  date: string;
  status: RequestStatus;
  assignedSpot: string;
  autoAllocated: boolean;
}

// ============================================================
// Pattern I/O Types
// ============================================================

export interface ParkingCoordinatorInput {
  spots: Writable<
    Default<ParkingSpot[], [
      { spotNumber: "1"; label: "Near entrance"; notes: ""; active: true },
      { spotNumber: "5"; label: ""; notes: ""; active: true },
      {
        spotNumber: "12";
        label: "Compact only";
        notes: "Tight, no large vehicles";
        active: true;
      },
    ]>
  >;
  people: Writable<Default<Person[], []>>;
  requests: Writable<Default<SpotRequest[], []>>;
}

export interface ParkingCoordinatorOutput {
  [NAME]: string;
  [UI]: VNode;
  spots: ParkingSpot[];
  people: Person[];
  requests: SpotRequest[];
  adminMode: boolean;
  selectedPersonName: string;
  requestDate: string;
  requestResult: string;
  toggleAdminMode: Stream<void>;
  submitRequest: Stream<{ personName: string; date: string }>;
  cancelRequest: Stream<{ requestId: string }>;
  addPerson: Stream<{
    name: string;
    email: string;
    commuteMode: CommuteMode;
    priorityRank: number;
    defaultSpot: string;
    preferences: string;
  }>;
  editPerson: Stream<{
    originalName: string;
    name: string;
    email: string;
    commuteMode: CommuteMode;
    priorityRank: number;
    defaultSpot: string;
    preferences: string;
  }>;
  removePerson: Stream<{ name: string }>;
  movePersonUp: Stream<{ name: string }>;
  movePersonDown: Stream<{ name: string }>;
  addSpot: Stream<{ spotNumber: string; label: string; notes: string }>;
  editSpot: Stream<
    {
      originalNumber: string;
      spotNumber: string;
      label: string;
      notes: string;
      active: boolean;
    }
  >;
  removeSpot: Stream<{ spotNumber: string }>;
  adminOverride: Stream<
    { spotNumber: string; date: string; personName: string }
  >;
}

// ============================================================
// Utilities
// ============================================================

const toLocalDateStr = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
    String(d.getDate()).padStart(2, "0")
  }`;
};

const getWeekDates = (todayStr: string): string[] => {
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(todayStr + "T00:00:00");
    d.setDate(d.getDate() + i);
    dates.push(toLocalDateStr(d.getTime()));
  }
  return dates;
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
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

const formatDateShort = (
  dateStr: string,
): { shortName: string; dayNum: string; monthLabel: string } => {
  const d = new Date(dateStr + "T00:00:00");
  return {
    shortName: DAY_NAMES[d.getDay()],
    dayNum: String(d.getDate()),
    monthLabel: MONTH_NAMES[d.getMonth()],
  };
};

const formatDateDisplay = (dateStr: string): string => {
  const { shortName, dayNum, monthLabel } = formatDateShort(dateStr);
  return `${shortName} ${monthLabel} ${dayNum}`;
};

let _idCounter = 0;
const genId = (): string => `req-${Date.now()}-${_idCounter++}`;

const parsePreferences = (s: string): string[] =>
  s.split(",").map((x) => x.trim()).filter(Boolean);

const commuteIcon = (mode: CommuteMode): string => {
  const icons: Record<CommuteMode, string> = {
    drive: "🚗",
    transit: "🚌",
    bike: "🚲",
    wfh: "🏠",
    other: "•",
  };
  return icons[mode] ?? "•";
};

// ============================================================
// Allocation Algorithm
// ============================================================

function runAutoAllocation(
  personName: string,
  date: string,
  allPeople: Person[],
  activeSpots: ParkingSpot[],
  existingRequests: SpotRequest[],
): string {
  const person = allPeople.find((p) => p.name === personName);
  if (!person) return "";

  const takenSpots = new Set<string>();
  for (const req of existingRequests) {
    if (req.date === date && req.status === "allocated") {
      takenSpots.add(req.assignedSpot);
    }
  }

  const activeSpotNumbers = activeSpots.filter((s) => s.active).map((s) =>
    s.spotNumber
  );
  const availableSpots = activeSpotNumbers.filter((n) => !takenSpots.has(n));
  if (availableSpots.length === 0) return "";

  if (person.defaultSpot && availableSpots.includes(person.defaultSpot)) {
    return person.defaultSpot;
  }

  for (const pref of person.spotPreferences) {
    if (availableSpots.includes(pref)) {
      return pref;
    }
  }

  return availableSpots[0];
}

// ============================================================
// Default Seed Data
// ============================================================

export const DEFAULT_SPOTS: ParkingSpot[] = [
  { spotNumber: "1", label: "Near entrance", notes: "", active: true },
  { spotNumber: "5", label: "", notes: "", active: true },
  {
    spotNumber: "12",
    label: "Compact only",
    notes: "Tight, no large vehicles",
    active: true,
  },
];

// ============================================================
// Pattern
// ============================================================

export default pattern<ParkingCoordinatorInput, ParkingCoordinatorOutput>(
  ({ spots, people, requests }) => {
    const nowTimestamp = wish<number>({ query: "#now" });
    const todayStr = computed(() =>
      toLocalDateStr(nowTimestamp.result || Date.now())
    );
    const weekDatesArr = computed(() => getWeekDates(todayStr));

    // UI state
    const adminMode = Writable.of(false);
    const selectedPersonName = Writable.of("");
    const requestDate = Writable.of(toLocalDateStr(Date.now()));
    const requestResult = Writable.of("");

    // Admin form state
    const addPersonFormOpen = Writable.of(false);
    const addSpotFormOpen = Writable.of(false);
    const editingPersonName = Writable.of<string | null>(null);
    const editingSpotNumber = Writable.of<string | null>(null);
    const removePersonConfirmTarget = Writable.of<string | null>(null);
    const removeSpotConfirmTarget = Writable.of<string | null>(null);

    // Add person form fields
    const newPersonName = Writable.of("");
    const newPersonEmail = Writable.of("");
    const newPersonCommuteMode = Writable.of<CommuteMode>("drive");
    const newPersonPriority = Writable.of("1");
    const newPersonDefaultSpot = Writable.of("");
    const newPersonPreferences = Writable.of("");
    const addPersonError = Writable.of("");

    // Add spot form fields
    const newSpotNumber = Writable.of("");
    const newSpotLabel = Writable.of("");
    const newSpotNotes = Writable.of("");
    const addSpotError = Writable.of("");

    // Edit person form fields
    const editName = Writable.of("");
    const editEmail = Writable.of("");
    const editCommuteMode = Writable.of<CommuteMode>("drive");
    const editPriorityRank = Writable.of("1");
    const editDefaultSpot = Writable.of("");
    const editPreferences = Writable.of("");

    // Edit spot form fields
    const editSpotNum = Writable.of("");
    const editSpotLabel = Writable.of("");
    const editSpotNotes = Writable.of("");
    const editSpotActive = Writable.of(true);

    // Override state
    const gridOverrideSpot = Writable.of("");
    const gridOverrideDate = Writable.of("");
    const overridePersonName = Writable.of("");

    // --------------------------------------------------------
    // Actions
    // --------------------------------------------------------

    const toggleAdminMode = action(() => {
      adminMode.set(!adminMode.get());
    });

    const submitRequest = action<{ personName: string; date: string }>(
      ({ personName: pNameArg, date: dateArg }) => {
        // Use provided args, or fall back to form state
        const pName = pNameArg || selectedPersonName.get();
        const date = dateArg || requestDate.get();

        if (!pName || !date || date < todayStr) {
          requestResult.set("Please select a person and a valid date.");
          return;
        }

        const allPeople = people.get();
        const person = allPeople.find((p) => p.name === pName);
        if (!person) {
          requestResult.set("Selected person not found.");
          return;
        }

        const existingReqs = requests.get();
        const duplicate = existingReqs.find(
          (r) =>
            r.personName === pName && r.date === date &&
            r.status !== "cancelled",
        );
        if (duplicate) {
          const spotInfo = duplicate.assignedSpot
            ? ` (Spot #${duplicate.assignedSpot})`
            : "";
          requestResult.set(
            `You already have an active request for ${
              formatDateDisplay(date)
            }${spotInfo}.`,
          );
          return;
        }

        const allSpotsArr = [...spots.get()];
        const assignedSpot = runAutoAllocation(
          pName,
          date,
          [...allPeople],
          allSpotsArr,
          [...existingReqs],
        );

        const newReq: SpotRequest = {
          id: genId(),
          personName: pName,
          date,
          status: assignedSpot ? "allocated" : "denied",
          assignedSpot,
          autoAllocated: true,
        };

        requests.set([...existingReqs, newReq]);

        if (assignedSpot) {
          requestResult.set(
            `Spot #${assignedSpot} allocated to ${pName} for ${
              formatDateDisplay(date)
            }.`,
          );
        } else {
          const activeCount = allSpotsArr.filter((s) => s.active).length;
          requestResult.set(
            `No spots available for ${
              formatDateDisplay(date)
            } — all ${activeCount} spots are taken.`,
          );
        }
      },
    );

    const cancelRequest = action<{ requestId: string }>(({ requestId }) => {
      requests.set(
        requests.get().map((r) =>
          r.id === requestId
            ? { ...r, status: "cancelled" as RequestStatus }
            : r
        ),
      );
    });

    const addPerson = action<
      {
        name: string;
        email: string;
        commuteMode: CommuteMode;
        priorityRank: number;
        defaultSpot: string;
        preferences: string;
      }
    >((
      { name, email, commuteMode, priorityRank, defaultSpot, preferences },
    ) => {
      const trimName = name.trim();
      const trimEmail = email.trim();
      if (!trimName || !trimEmail) return;

      const current = people.get();
      if (current.some((p) => p.name === trimName)) {
        addPersonError.set(`A person named "${trimName}" already exists.`);
        return;
      }
      addPersonError.set("");

      const newPerson: Person = {
        name: trimName,
        email: trimEmail,
        commuteMode,
        priorityRank: priorityRank || 1,
        defaultSpot: defaultSpot || "",
        spotPreferences: parsePreferences(preferences),
      };
      people.set([...current, newPerson]);

      if (!selectedPersonName.get()) {
        selectedPersonName.set(trimName);
      }

      newPersonName.set("");
      newPersonEmail.set("");
      newPersonCommuteMode.set("drive");
      newPersonPriority.set("1");
      newPersonDefaultSpot.set("");
      newPersonPreferences.set("");
      addPersonFormOpen.set(false);
    });

    const editPerson = action<
      {
        originalName: string;
        name: string;
        email: string;
        commuteMode: CommuteMode;
        priorityRank: number;
        defaultSpot: string;
        preferences: string;
      }
    >((
      {
        originalName,
        name,
        email,
        commuteMode,
        priorityRank,
        defaultSpot,
        preferences,
      },
    ) => {
      const trimName = name.trim();
      const trimEmail = email.trim();
      if (!trimName || !trimEmail) return;

      const current = people.get();
      if (
        trimName !== originalName && current.some((p) => p.name === trimName)
      ) return;

      people.set(current.map((p) =>
        p.name === originalName
          ? {
            ...p,
            name: trimName,
            email: trimEmail,
            commuteMode,
            priorityRank: priorityRank || p.priorityRank,
            defaultSpot: defaultSpot || "",
            spotPreferences: parsePreferences(preferences),
          }
          : p
      ));

      if (selectedPersonName.get() === originalName) {
        selectedPersonName.set(trimName);
      }

      if (trimName !== originalName) {
        requests.set(
          requests.get().map((r) =>
            r.personName === originalName ? { ...r, personName: trimName } : r
          ),
        );
      }

      editingPersonName.set(null);
    });

    const removePerson = action<{ name: string }>(({ name }) => {
      people.set(people.get().filter((p) => p.name !== name));
      if (selectedPersonName.get() === name) {
        const remaining = people.get();
        selectedPersonName.set(remaining[0]?.name ?? "");
      }
      removePersonConfirmTarget.set(null);
    });

    const movePersonUp = action<{ name: string }>(({ name }) => {
      const sorted = [...people.get()].sort((a, b) =>
        a.priorityRank - b.priorityRank
      );
      const idx = sorted.findIndex((p) => p.name === name);
      if (idx <= 0) return;
      const above = sorted[idx - 1];
      const current = sorted[idx];
      const aboveRank = above.priorityRank;
      const currentRank = current.priorityRank;
      people.set(
        people.get().map((p) => {
          if (p.name === above.name) return { ...p, priorityRank: currentRank };
          if (p.name === current.name) return { ...p, priorityRank: aboveRank };
          return p;
        }),
      );
    });

    const movePersonDown = action<{ name: string }>(({ name }) => {
      const sorted = [...people.get()].sort((a, b) =>
        a.priorityRank - b.priorityRank
      );
      const idx = sorted.findIndex((p) => p.name === name);
      if (idx < 0 || idx >= sorted.length - 1) return;
      const below = sorted[idx + 1];
      const current = sorted[idx];
      const belowRank = below.priorityRank;
      const currentRank = current.priorityRank;
      people.set(
        people.get().map((p) => {
          if (p.name === below.name) return { ...p, priorityRank: currentRank };
          if (p.name === current.name) return { ...p, priorityRank: belowRank };
          return p;
        }),
      );
    });

    const addSpot = action<
      { spotNumber: string; label: string; notes: string }
    >(({ spotNumber: spotNumArg, label, notes }) => {
      const trimNum = spotNumArg.trim();
      if (!trimNum) return;
      const current = spots.get();
      if (current.some((s) => s.spotNumber === trimNum)) {
        addSpotError.set(`Spot #${trimNum} already exists.`);
        return;
      }
      addSpotError.set("");
      spots.set([...current, {
        spotNumber: trimNum,
        label: label.trim(),
        notes: notes.trim(),
        active: true,
      }]);
      newSpotNumber.set("");
      newSpotLabel.set("");
      newSpotNotes.set("");
      addSpotFormOpen.set(false);
    });

    const editSpot = action<
      {
        originalNumber: string;
        spotNumber: string;
        label: string;
        notes: string;
        active: boolean;
      }
    >(({ originalNumber, spotNumber: spotNumArg2, label, notes, active }) => {
      const trimNum = spotNumArg2.trim();
      if (!trimNum) return;
      const current = spots.get();
      if (
        trimNum !== originalNumber &&
        current.some((s) => s.spotNumber === trimNum)
      ) return;

      spots.set(
        current.map((s) =>
          s.spotNumber === originalNumber
            ? {
              ...s,
              spotNumber: trimNum,
              label: label.trim(),
              notes: notes.trim(),
              active,
            }
            : s
        ),
      );

      if (trimNum !== originalNumber) {
        requests.set(
          requests.get().map((r) =>
            r.assignedSpot === originalNumber
              ? { ...r, assignedSpot: trimNum }
              : r
          ),
        );
      }
      editingSpotNumber.set(null);
    });

    const removeSpot = action<{ spotNumber: string }>(
      ({ spotNumber: spotNumArg3 }) => {
        spots.set(spots.get().filter((s) => s.spotNumber !== spotNumArg3));
        removeSpotConfirmTarget.set(null);
      },
    );

    const adminOverride = action<
      { spotNumber: string; date: string; personName: string }
    >(({ spotNumber, date, personName }) => {
      if (!personName || !spotNumber || !date) return;

      const existingReqs = requests.get();

      const spotExisting = existingReqs.find(
        (r) =>
          r.assignedSpot === spotNumber && r.date === date &&
          r.status === "allocated",
      );

      if (spotExisting && spotExisting.personName !== personName) {
        requests.set(
          existingReqs.map((r) =>
            r.id === spotExisting.id
              ? { ...r, status: "cancelled" as RequestStatus }
              : r
          ),
        );
      }

      const personExisting = requests.get().find(
        (r) =>
          r.personName === personName && r.date === date &&
          r.status !== "cancelled",
      );

      if (personExisting) {
        requests.set(
          requests.get().map((r) =>
            r.id === personExisting.id
              ? {
                ...r,
                assignedSpot: spotNumber,
                status: "allocated" as RequestStatus,
                autoAllocated: false,
              }
              : r
          ),
        );
      } else {
        requests.set([
          ...requests.get(),
          {
            id: genId(),
            personName,
            date,
            status: "allocated" as RequestStatus,
            assignedSpot: spotNumber,
            autoAllocated: false,
          },
        ]);
      }

      gridOverrideSpot.set("");
      gridOverrideDate.set("");
      overridePersonName.set("");
    });

    // Internal UI actions
    const startEditPerson = action<{ name: string }>(({ name }) => {
      const p = people.get().find((x) => x.name === name);
      if (!p) return;
      editingPersonName.set(name);
      editName.set(p.name);
      editEmail.set(p.email);
      editCommuteMode.set(p.commuteMode);
      editPriorityRank.set(String(p.priorityRank));
      editDefaultSpot.set(p.defaultSpot);
      editPreferences.set(p.spotPreferences.join(", "));
    });

    const cancelEditPerson = action(() => editingPersonName.set(null));

    const saveEditPerson = action<{ originalName: string }>(
      ({ originalName }) => {
        editPerson.send({
          originalName,
          name: editName.get(),
          email: editEmail.get(),
          commuteMode: editCommuteMode.get(),
          priorityRank: parseInt(editPriorityRank.get()) || 1,
          defaultSpot: editDefaultSpot.get(),
          preferences: editPreferences.get(),
        });
      },
    );

    const initiateRemovePerson = action<{ name: string }>(({ name }) => {
      removePersonConfirmTarget.set(name);
    });

    const cancelRemovePerson = action(() =>
      removePersonConfirmTarget.set(null)
    );

    const startEditSpot = action<{ spotNumber: string }>(
      ({ spotNumber: spotNumArg4 }) => {
        const s = spots.get().find((x) => x.spotNumber === spotNumArg4);
        if (!s) return;
        editingSpotNumber.set(spotNumArg4);
        editSpotNum.set(s.spotNumber);
        editSpotLabel.set(s.label);
        editSpotNotes.set(s.notes);
        editSpotActive.set(s.active);
      },
    );

    const cancelEditSpot = action(() => editingSpotNumber.set(null));

    const saveEditSpot = action<{ originalNumber: string }>(
      ({ originalNumber }) => {
        editSpot.send({
          originalNumber,
          spotNumber: editSpotNum.get(),
          label: editSpotLabel.get(),
          notes: editSpotNotes.get(),
          active: editSpotActive.get(),
        });
      },
    );

    const initiateRemoveSpot = action<{ spotNumber: string }>(
      ({ spotNumber: spotNumArg5 }) => {
        removeSpotConfirmTarget.set(spotNumArg5);
      },
    );

    const cancelRemoveSpot = action(() => removeSpotConfirmTarget.set(null));

    const openGridOverride = action<{ spotNumber: string; date: string }>(
      ({ spotNumber, date }) => {
        gridOverrideSpot.set(spotNumber);
        gridOverrideDate.set(date);
        overridePersonName.set(people.get()[0]?.name ?? "");
      },
    );

    const cancelOverride = action(() => {
      gridOverrideSpot.set("");
      gridOverrideDate.set("");
    });

    const submitAddPerson = action(() => {
      addPerson.send({
        name: newPersonName.get(),
        email: newPersonEmail.get(),
        commuteMode: newPersonCommuteMode.get(),
        priorityRank: parseInt(newPersonPriority.get()) || 1,
        defaultSpot: newPersonDefaultSpot.get(),
        preferences: newPersonPreferences.get(),
      });
    });

    const submitAddSpot = action(() => {
      addSpot.send({
        spotNumber: newSpotNumber.get(),
        label: newSpotLabel.get(),
        notes: newSpotNotes.get(),
      });
    });

    const toggleAddPersonForm = action(() =>
      addPersonFormOpen.set(!addPersonFormOpen.get())
    );
    const toggleAddSpotForm = action(() =>
      addSpotFormOpen.set(!addSpotFormOpen.get())
    );

    // --------------------------------------------------------
    // Helper computeds for UI (keep action closures using .get())
    // --------------------------------------------------------

    const _isDateInPast = computed(() => requestDate.get() < todayStr);

    const spotDeactivateWarning = computed(() => {
      const editNum = editingSpotNumber.get();
      if (!editNum || editSpotActive.get()) return false;
      return requests.get().some(
        (r) =>
          r.assignedSpot === editNum && r.status === "allocated" &&
          r.date >= todayStr,
      );
    });

    const noPeople = computed(() => people.get().length === 0);

    const personSelectItems = computed(() =>
      people.get().map((p) => ({ label: p.name, value: p.name }))
    );

    const requestDisabled = computed(() =>
      !selectedPersonName.get() || !requestDate.get() ||
      requestDate.get() < todayStr || people.get().length === 0
    );

    const addPersonDisabled = computed(() =>
      !newPersonName.get() || !newPersonEmail.get() || !newPersonPriority.get()
    );

    const addSpotDisabled = computed(() => !newSpotNumber.get());

    const commuteModeOptions = [
      { label: "🚗 Drive", value: "drive" },
      { label: "🚌 Transit", value: "transit" },
      { label: "🚲 Bike", value: "bike" },
      { label: "🏠 WFH", value: "wfh" },
      { label: "• Other", value: "other" },
    ];

    const todayFormatted = computed(() => formatDateDisplay(todayStr));

    // Compute week month boundary info once (string or null)
    const weekMonthInfo = computed(() => {
      const firstMonth = new Date(weekDatesArr[0] + "T00:00:00").getMonth();
      const lastMonth = new Date(weekDatesArr[6] + "T00:00:00").getMonth();
      if (firstMonth !== lastMonth) {
        return `${MONTH_NAMES[firstMonth]} / ${MONTH_NAMES[lastMonth]}`;
      }
      return null;
    });

    // Pre-compute week grid cell data to avoid OpaqueCell closure issues.
    // Returns: Array of spot rows, each with an array of cell data per date.
    // Accessing OpaqueCell values (spot.number, req.id etc.) inside this
    // single computed() is safe — the closure is at top-level, not nested.
    const weekGridData = computed(() => {
      const allSpots = spots.get().filter((s) => s != null && s.active);
      const allRequests = requests.get();
      const currentPerson = selectedPersonName.get();
      const overrideSpot = gridOverrideSpot.get();
      const overrideDate = gridOverrideDate.get();
      const overridePerson = overridePersonName.get();
      const weekGridShowAdmin = adminMode.get();

      return allSpots.map((spot) => {
        const spotNum = spot.spotNumber;
        const cells = weekDatesArr.map((dateStr) => {
          const req = allRequests.find(
            (r) =>
              r.date === dateStr && r.status === "allocated" &&
              r.assignedSpot === spotNum,
          ) ?? null;
          const isAllocated = req !== null;
          const isOwn = req !== null && req.personName === currentPerson;
          const isManual = req !== null && req.autoAllocated === false;
          const isOverride = overrideSpot === spotNum &&
            overrideDate === dateStr;
          const conflictName = req && req.personName !== overridePerson
            ? req.personName
            : null;
          const isToday = dateStr === todayStr;
          const bgColor = isAllocated
            ? (isToday ? "#dbeafe" : "#eff6ff")
            : (isToday ? "#fef9c3" : "#f0fdf4");

          return {
            spotNumber: spotNum,
            dateStr,
            isToday,
            req: req ? { ...req } : null,
            isAllocated,
            isOwn,
            isManual,
            isOverride,
            conflictName,
            showAdmin: weekGridShowAdmin,
            bgColor,
          };
        });
        return { spotNumber: spotNum, spotLabel: spot.label, cells };
      });
    });

    // Pre-compute today strip cell data for each active spot
    const todayStripData = computed(() => {
      const allSpots = spots.get().filter((s) => s != null && s.active);
      const allRequests = requests.get();
      const currentPerson = selectedPersonName.get();
      const todayStripShowAdmin = adminMode.get();

      return allSpots.map((spot) => {
        const req = allRequests.find(
          (r) =>
            r.date === todayStr && r.status === "allocated" &&
            r.assignedSpot === spot.spotNumber,
        ) ?? null;
        return {
          spotNumber: spot.spotNumber,
          spotLabel: spot.label,
          req: req ? { ...req } : null,
          isAvailable: req === null,
          isOwn: req !== null && req.personName === currentPerson,
          showAdmin: todayStripShowAdmin,
        };
      });
    });

    // Pre-compute sorted people list for admin panel
    const adminPeopleData = computed(() => {
      const sorted = [...people.get()].sort((a, b) =>
        a.priorityRank - b.priorityRank
      );
      return sorted.map((p, idx) => ({
        name: p.name,
        email: p.email,
        commuteMode: p.commuteMode,
        priorityRank: p.priorityRank,
        defaultSpot: p.defaultSpot,
        spotPreferences: [...p.spotPreferences],
        isFirst: idx === 0,
        isLast: idx === sorted.length - 1,
      }));
    });

    // Pre-compute sorted spots list for admin panel
    const adminSpotsData = computed(() =>
      [...spots.get()].map((s) => ({
        spotNumber: s.spotNumber,
        label: s.label,
        notes: s.notes,
        active: s.active,
      }))
    );

    // --------------------------------------------------------
    // UI
    // --------------------------------------------------------

    return {
      [NAME]: "Parking Coordinator",
      [UI]: (
        <ct-screen>
          {/* Header */}
          <div
            slot="header"
            style="padding: 0.75rem 1rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--ct-color-gray-200);"
          >
            <ct-heading level={4}>Parking</ct-heading>
            <div style="display: flex; align-items: center; gap: 0.75rem;">
              <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
                {todayFormatted}
              </span>
              <ct-button
                variant={computed(() =>
                  adminMode.get() ? "primary" : "secondary"
                )}
                size="sm"
                onClick={() => toggleAdminMode.send()}
              >
                {computed(() => `Admin: ${adminMode.get() ? "ON" : "OFF"}`)}
              </ct-button>
            </div>
          </div>

          <ct-vscroll flex showScrollbar>
            <ct-vstack gap="3" style="padding: 1rem;">
              {/* === Section A: Today Strip === */}
              <ct-vstack gap="1">
                <ct-heading level={6}>Today — {todayFormatted}</ct-heading>

                {noPeople
                  ? (
                    <ct-card>
                      <span style="color: var(--ct-color-gray-500); font-size: 0.875rem;">
                        No team members yet — ask your admin to add people.
                      </span>
                    </ct-card>
                  )
                  : null}

                {todayStripData.map((stripCell) => {
                  const stripSpotNumber = stripCell.spotNumber;
                  const stripSpotLabel = stripCell.spotLabel;
                  const stripReq = stripCell.req;
                  const stripIsAvailable = stripCell.isAvailable;
                  const stripIsOwn = stripCell.isOwn;
                  const stripShowAdmin = stripCell.showAdmin;
                  return (
                    <ct-card
                      style={`padding: 0.625rem 0.875rem; border-left: 3px solid ${
                        stripIsAvailable ? "#22c55e" : "#93c5fd"
                      };`}
                    >
                      <ct-hstack justify="between" align="center" gap="2" wrap>
                        <ct-hstack gap="2" align="center">
                          <span style="font-weight: 600; font-size: 0.875rem; min-width: 2rem;">
                            #{stripSpotNumber}
                          </span>
                          {stripSpotLabel
                            ? (
                              <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                                {stripSpotLabel}
                              </span>
                            )
                            : null}
                        </ct-hstack>

                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 10px",
                            borderRadius: "9999px",
                            backgroundColor: stripIsAvailable
                              ? "#dcfce7"
                              : "#dbeafe",
                            color: stripIsAvailable ? "#166534" : "#1e40af",
                            fontSize: "0.75rem",
                            fontWeight: "500",
                          }}
                        >
                          {stripReq ? stripReq.personName : "Available"}
                        </span>

                        <ct-hstack gap="1">
                          {stripReq && stripIsOwn
                            ? (
                              <ct-button
                                variant="secondary"
                                size="sm"
                                onClick={() =>
                                  cancelRequest.send({
                                    requestId: stripReq.id,
                                  })}
                              >
                                Cancel
                              </ct-button>
                            )
                            : null}

                          {stripShowAdmin
                            ? (
                              <ct-button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  openGridOverride.send({
                                    spotNumber: stripSpotNumber,
                                    date: todayStr,
                                  })}
                              >
                                Assign
                              </ct-button>
                            )
                            : null}
                        </ct-hstack>
                      </ct-hstack>
                    </ct-card>
                  );
                })}
              </ct-vstack>

              {/* === Section B: Request Form === */}
              <ct-card>
                <ct-vstack gap="2">
                  <ct-heading level={6}>Request a Spot</ct-heading>

                  <ct-hstack gap="2" align="end" wrap>
                    <ct-vstack gap="1" style="flex: 1; min-width: 140px;">
                      <span style="font-size: 0.75rem; font-weight: 500;">
                        Person
                      </span>
                      {noPeople
                        ? (
                          <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
                            No team members yet — ask your admin to add people.
                          </span>
                        )
                        : (
                          <ct-select
                            $value={selectedPersonName}
                            items={personSelectItems}
                            style="width: 100%;"
                          />
                        )}
                    </ct-vstack>

                    <ct-vstack gap="1" style="min-width: 140px;">
                      <span style="font-size: 0.75rem; font-weight: 500;">
                        Date
                      </span>
                      <ct-input
                        $value={requestDate}
                        type="date"
                        style="width: 100%;"
                      />
                    </ct-vstack>

                    <ct-button
                      variant="primary"
                      disabled={requestDisabled}
                      onClick={() =>
                        submitRequest.send({
                          personName: selectedPersonName.get(),
                          date: requestDate.get(),
                        })}
                    >
                      Request Spot
                    </ct-button>
                  </ct-hstack>

                  {computed(() => {
                    if (!(requestDate.get() < todayStr)) return null;
                    return (
                      <span style="font-size: 0.75rem; color: #92400e; background-color: #fef3c7; padding: 0.375rem 0.625rem; border-radius: 6px; display: block;">
                        Please select today or a future date.
                      </span>
                    );
                  })}

                  {computed(() => {
                    const result = requestResult.get();
                    if (!result) return null;
                    const isSuccess = result.startsWith("Spot #");
                    const color = isSuccess ? "#166534" : "#991b1b";
                    const bg = isSuccess ? "#dcfce7" : "#fee2e2";
                    return (
                      <span
                        style={`font-size: 0.875rem; color: ${color}; background-color: ${bg}; padding: 0.5rem 0.75rem; border-radius: 6px; display: block;`}
                      >
                        {result}
                      </span>
                    );
                  })}
                </ct-vstack>
              </ct-card>

              {/* === Section C: Week-Ahead Grid === */}
              <ct-vstack gap="1">
                <ct-heading level={6}>This Week</ct-heading>

                {weekMonthInfo
                  ? (
                    <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                      {weekMonthInfo}
                    </span>
                  )
                  : null}

                <div style="display: grid; grid-template-columns: 5rem repeat(7, 1fr); gap: 2px; overflow-x: auto;">
                  {/* Corner spacer */}
                  <div />

                  {/* Date headers */}
                  {weekDatesArr.map((dateStr) => {
                    const shortName = computed(() =>
                      formatDateShort(dateStr).shortName
                    );
                    const dayNum = computed(() =>
                      formatDateShort(dateStr).dayNum
                    );
                    const isToday = computed(() => dateStr === todayStr);
                    return (
                      <div
                        style={{
                          textAlign: "center",
                          padding: "0.25rem",
                          fontSize: "0.75rem",
                          fontWeight: isToday ? "700" : "400",
                          backgroundColor: isToday ? "#fef9c3" : "transparent",
                          borderRadius: "4px 4px 0 0",
                          color: isToday
                            ? "#92400e"
                            : "var(--ct-color-gray-600)",
                        }}
                      >
                        <span style="display: block;">{shortName}</span>
                        <span style="display: block;">{dayNum}</span>
                      </div>
                    );
                  })}

                  {/* Spot rows — uses pre-computed weekGridData to avoid OpaqueCell closure issues */}
                  {weekGridData.map((spotRow) => (
                    <>
                      <div
                        style={{
                          padding: "0.25rem 0.5rem",
                          fontSize: "0.75rem",
                          fontWeight: "600",
                          color: "var(--ct-color-gray-700)",
                          display: "flex",
                          alignItems: "center",
                        }}
                      >
                        #{spotRow.spotNumber}
                      </div>

                      {spotRow.cells.map((gridCell) => {
                        const gridReq = gridCell.req;
                        const gridIsAllocated = gridCell.isAllocated;
                        const gridIsOwn = gridCell.isOwn;
                        const gridIsManual = gridCell.isManual;
                        const gridIsOverride = gridCell.isOverride;
                        const gridConflictName = gridCell.conflictName;
                        const gridShowAdmin = gridCell.showAdmin;
                        const gridBgColor = gridCell.bgColor;
                        const gridIsToday = gridCell.isToday;
                        const gridSpotNumber = gridCell.spotNumber;
                        const gridDateStr = gridCell.dateStr;
                        return (
                          <div
                            style={{
                              padding: "0.25rem 0.375rem",
                              minHeight: "2rem",
                              borderRadius: "4px",
                              fontSize: "0.6875rem",
                              display: "flex",
                              flexDirection: "column",
                              justifyContent: "center",
                              position: "relative",
                              backgroundColor: gridBgColor,
                            }}
                          >
                            {gridIsOverride
                              ? (
                                <ct-vstack
                                  gap="1"
                                  style="background: white; border: 1px solid #e5e7eb; border-radius: 4px; padding: 0.375rem;"
                                >
                                  <ct-select
                                    $value={overridePersonName}
                                    items={computed(() =>
                                      people.get().map((p) => ({
                                        label: p.name,
                                        value: p.name,
                                      }))
                                    )}
                                    style="font-size: 0.6875rem;"
                                  />
                                  {gridConflictName
                                    ? (
                                      <span style="font-size: 0.625rem; color: var(--ct-color-red-600);">
                                        Already assigned to{" "}
                                        {gridConflictName}. Overwrite?
                                      </span>
                                    )
                                    : null}
                                  <ct-hstack gap="1">
                                    <ct-button
                                      variant="primary"
                                      size="sm"
                                      onClick={() =>
                                        adminOverride.send({
                                          spotNumber: gridSpotNumber,
                                          date: gridDateStr,
                                          personName: overridePersonName.get(),
                                        })}
                                    >
                                      OK
                                    </ct-button>
                                    <ct-button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => cancelOverride.send()}
                                    >
                                      ×
                                    </ct-button>
                                  </ct-hstack>
                                </ct-vstack>
                              )
                              : gridIsAllocated && gridReq
                              ? (
                                <>
                                  <span
                                    style={{
                                      fontSize: "0.6875rem",
                                      fontWeight: "500",
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                      display: "block",
                                      color: "#1d4ed8",
                                    }}
                                  >
                                    {gridReq.personName}
                                  </span>
                                  {gridIsOwn
                                    ? (
                                      <ct-button
                                        variant="ghost"
                                        size="sm"
                                        style="padding: 0; font-size: 0.625rem; line-height: 1; min-height: unset; color: var(--ct-color-red-500);"
                                        onClick={() =>
                                          cancelRequest.send({
                                            requestId: gridReq.id,
                                          })}
                                      >
                                        ×
                                      </ct-button>
                                    )
                                    : null}
                                  {gridIsManual
                                    ? (
                                      <span style="position: absolute; top: 2px; right: 3px; font-size: 0.5rem; color: var(--ct-color-gray-400); font-weight: 700;">
                                        M
                                      </span>
                                    )
                                    : null}
                                </>
                              )
                              : (
                                <>
                                  <span
                                    style={`color: ${
                                      gridIsToday
                                        ? "#92400e"
                                        : "var(--ct-color-green-500)"
                                    }; font-size: 0.625rem;`}
                                  >
                                    Free
                                  </span>
                                  {gridShowAdmin
                                    ? (
                                      <ct-button
                                        variant="ghost"
                                        size="sm"
                                        style="font-size: 0.625rem; opacity: 0.6; padding: 0;"
                                        onClick={() =>
                                          openGridOverride.send({
                                            spotNumber: gridSpotNumber,
                                            date: gridDateStr,
                                          })}
                                      >
                                        +
                                      </ct-button>
                                    )
                                    : null}
                                </>
                              )}
                          </div>
                        );
                      })}
                    </>
                  ))}
                </div>
              </ct-vstack>

              {/* === Section D: Admin (admin mode only) === */}
              {adminMode
                ? (
                  <>
                    {/* People */}
                    <ct-vstack gap="2">
                      <ct-hstack justify="between" align="center">
                        <ct-heading level={6}>People</ct-heading>
                        <ct-button
                          variant="primary"
                          size="sm"
                          onClick={() => toggleAddPersonForm.send()}
                        >
                          + Add Person
                        </ct-button>
                      </ct-hstack>

                      {people.get().length === 0
                        ? (
                          <ct-card style="text-align: center; padding: 1.5rem;">
                            <ct-vstack gap="2" align="center">
                              <span style="font-size: 2rem;">👥</span>
                              <span style="color: var(--ct-color-gray-500); font-size: 0.875rem;">
                                No team members yet. Add the first person below.
                              </span>
                            </ct-vstack>
                          </ct-card>
                        )
                        : null}

                      {adminPeopleData.map((person) => {
                        const {
                          name: personName,
                          email,
                          commuteMode,
                          priorityRank,
                          defaultSpot,
                          spotPreferences,
                          isFirst,
                          isLast,
                        } = person;
                        const isEditing = computed(() =>
                          editingPersonName.get() === personName
                        );
                        const isRemoveConfirm = computed(() =>
                          removePersonConfirmTarget.get() === personName
                        );
                        const activeSpotOpts = computed(() =>
                          spots.get()
                            .filter((s) => s.active)
                            .map((s) => ({
                              label: `#${s.spotNumber}${
                                s.label ? " — " + s.label : ""
                              }`,
                              value: s.spotNumber,
                            }))
                        );
                        const editSpotItems = computed(
                          () => [
                            { label: "None", value: "" },
                            ...activeSpotOpts,
                          ],
                        );

                        return (
                          <ct-card
                            style={computed(() =>
                              isEditing
                                ? "border: 2px solid var(--ct-color-blue-300);"
                                : ""
                            )}
                          >
                            {isEditing
                              ? (
                                <ct-vstack gap="2">
                                  <ct-hstack gap="2" wrap>
                                    <ct-vstack
                                      gap="1"
                                      style="flex: 1; min-width: 120px;"
                                    >
                                      <span style="font-size: 0.75rem; font-weight: 500;">
                                        Name *
                                      </span>
                                      <ct-input
                                        $value={editName}
                                        placeholder="Full name"
                                        style="width: 100%;"
                                      />
                                    </ct-vstack>
                                    <ct-vstack
                                      gap="1"
                                      style="flex: 1; min-width: 120px;"
                                    >
                                      <span style="font-size: 0.75rem; font-weight: 500;">
                                        Email *
                                      </span>
                                      <ct-input
                                        $value={editEmail}
                                        placeholder="email@company.com"
                                        style="width: 100%;"
                                      />
                                    </ct-vstack>
                                  </ct-hstack>
                                  <ct-hstack gap="2" wrap>
                                    <ct-vstack
                                      gap="1"
                                      style="min-width: 100px;"
                                    >
                                      <span style="font-size: 0.75rem; font-weight: 500;">
                                        Commute
                                      </span>
                                      <ct-select
                                        $value={editCommuteMode}
                                        items={commuteModeOptions}
                                        style="width: 100%;"
                                      />
                                    </ct-vstack>
                                    <ct-vstack gap="1" style="min-width: 80px;">
                                      <span style="font-size: 0.75rem; font-weight: 500;">
                                        Priority *
                                      </span>
                                      <ct-input
                                        $value={editPriorityRank}
                                        type="number"
                                        style="width: 5rem;"
                                      />
                                    </ct-vstack>
                                    <ct-vstack
                                      gap="1"
                                      style="min-width: 100px;"
                                    >
                                      <span style="font-size: 0.75rem; font-weight: 500;">
                                        Default Spot
                                      </span>
                                      <ct-select
                                        $value={editDefaultSpot}
                                        items={editSpotItems}
                                        style="width: 100%;"
                                      />
                                    </ct-vstack>
                                  </ct-hstack>
                                  <ct-vstack gap="1">
                                    <span style="font-size: 0.75rem; font-weight: 500;">
                                      Preferences (comma-separated spot numbers)
                                    </span>
                                    <ct-input
                                      $value={editPreferences}
                                      placeholder="e.g. 1, 5, 12"
                                      style="width: 100%;"
                                    />
                                  </ct-vstack>
                                  <ct-hstack gap="2">
                                    <ct-button
                                      variant="primary"
                                      size="sm"
                                      onClick={() =>
                                        saveEditPerson.send({
                                          originalName: personName,
                                        })}
                                    >
                                      Save
                                    </ct-button>
                                    <ct-button
                                      variant="secondary"
                                      size="sm"
                                      onClick={() => cancelEditPerson.send()}
                                    >
                                      Cancel
                                    </ct-button>
                                  </ct-hstack>
                                </ct-vstack>
                              )
                              : (
                                <ct-vstack gap="1">
                                  <ct-hstack
                                    justify="between"
                                    align="start"
                                    gap="2"
                                    wrap
                                  >
                                    <ct-vstack gap="0">
                                      <ct-hstack gap="2" align="center" wrap>
                                        <span style="font-weight: 600;">
                                          {personName}
                                        </span>
                                        <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                                          #{priorityRank}
                                        </span>
                                        {defaultSpot
                                          ? (
                                            <span style="font-size: 0.6875rem; background-color: #eff6ff; color: #1d4ed8; padding: 1px 6px; border-radius: 9999px;">
                                              Spot #{defaultSpot}
                                            </span>
                                          )
                                          : null}
                                      </ct-hstack>
                                      <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                                        {email}
                                      </span>
                                      <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                                        {commuteIcon(commuteMode)} {commuteMode}
                                      </span>
                                    </ct-vstack>

                                    <ct-hstack gap="1" align="center">
                                      <ct-button
                                        variant="ghost"
                                        size="sm"
                                        disabled={isFirst}
                                        onClick={() =>
                                          movePersonUp.send({
                                            name: personName,
                                          })}
                                      >
                                        ↑
                                      </ct-button>
                                      <ct-button
                                        variant="ghost"
                                        size="sm"
                                        disabled={isLast}
                                        onClick={() =>
                                          movePersonDown.send({
                                            name: personName,
                                          })}
                                      >
                                        ↓
                                      </ct-button>
                                      <ct-button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          startEditPerson.send({
                                            name: personName,
                                          })}
                                      >
                                        Edit
                                      </ct-button>
                                      <ct-button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          initiateRemovePerson.send({
                                            name: personName,
                                          })}
                                      >
                                        Remove
                                      </ct-button>
                                    </ct-hstack>
                                  </ct-hstack>

                                  {spotPreferences.length > 0
                                    ? (
                                      <span style="font-size: 0.75rem; color: var(--ct-color-gray-400);">
                                        Prefers: {spotPreferences.map((n) =>
                                          "#" + n
                                        ).join(", ")}
                                      </span>
                                    )
                                    : null}

                                  {isRemoveConfirm
                                    ? (
                                      <ct-card style="background: #fef2f2; border: 1px solid #fecaca;">
                                        <ct-vstack gap="1">
                                          <span style="font-size: 0.75rem; color: var(--ct-color-red-700);">
                                            This person has upcoming requests.
                                            They will be preserved. Remove
                                            anyway?
                                          </span>
                                          <ct-hstack gap="2">
                                            <ct-button
                                              variant="primary"
                                              size="sm"
                                              onClick={() =>
                                                removePerson.send({
                                                  name: personName,
                                                })}
                                            >
                                              Remove
                                            </ct-button>
                                            <ct-button
                                              variant="ghost"
                                              size="sm"
                                              onClick={() =>
                                                cancelRemovePerson.send()}
                                            >
                                              Cancel
                                            </ct-button>
                                          </ct-hstack>
                                        </ct-vstack>
                                      </ct-card>
                                    )
                                    : null}
                                </ct-vstack>
                              )}
                          </ct-card>
                        );
                      })}

                      {addPersonFormOpen
                        ? (
                          <ct-card style="border: 2px dashed var(--ct-color-gray-200);">
                            <ct-vstack gap="2">
                              <ct-heading level={6}>Add Person</ct-heading>
                              <ct-hstack gap="2" wrap>
                                <ct-vstack
                                  gap="1"
                                  style="flex: 1; min-width: 120px;"
                                >
                                  <span style="font-size: 0.75rem; font-weight: 500;">
                                    Name *
                                  </span>
                                  <ct-input
                                    $value={newPersonName}
                                    placeholder="Full name"
                                    style="width: 100%;"
                                  />
                                </ct-vstack>
                                <ct-vstack
                                  gap="1"
                                  style="flex: 1; min-width: 120px;"
                                >
                                  <span style="font-size: 0.75rem; font-weight: 500;">
                                    Email *
                                  </span>
                                  <ct-input
                                    $value={newPersonEmail}
                                    placeholder="email@company.com"
                                    style="width: 100%;"
                                  />
                                </ct-vstack>
                              </ct-hstack>
                              <ct-hstack gap="2" wrap>
                                <ct-vstack gap="1" style="min-width: 100px;">
                                  <span style="font-size: 0.75rem; font-weight: 500;">
                                    Commute
                                  </span>
                                  <ct-select
                                    $value={newPersonCommuteMode}
                                    items={commuteModeOptions}
                                    style="width: 100%;"
                                  />
                                </ct-vstack>
                                <ct-vstack gap="1" style="min-width: 80px;">
                                  <span style="font-size: 0.75rem; font-weight: 500;">
                                    Priority *
                                  </span>
                                  <ct-input
                                    $value={newPersonPriority}
                                    type="number"
                                    placeholder="1"
                                    style="width: 5rem;"
                                  />
                                </ct-vstack>
                                <ct-vstack gap="1" style="min-width: 100px;">
                                  <span style="font-size: 0.75rem; font-weight: 500;">
                                    Default Spot
                                  </span>
                                  <ct-select
                                    $value={newPersonDefaultSpot}
                                    items={computed(() => [
                                      { label: "None", value: "" },
                                      ...spots.get()
                                        .filter((s) => s.active)
                                        .map((s) => ({
                                          label: `#${s.spotNumber}`,
                                          value: s.spotNumber,
                                        })),
                                    ])}
                                    style="width: 100%;"
                                  />
                                </ct-vstack>
                              </ct-hstack>
                              <ct-vstack gap="1">
                                <span style="font-size: 0.75rem; font-weight: 500;">
                                  Preferences (comma-separated)
                                </span>
                                <ct-input
                                  $value={newPersonPreferences}
                                  placeholder="e.g. 1, 5"
                                  style="width: 100%;"
                                />
                              </ct-vstack>
                              {computed(() => {
                                const err = addPersonError.get();
                                if (!err) return null;
                                return (
                                  <span style="font-size: 0.75rem; color: var(--ct-color-red-600);">
                                    {err}
                                  </span>
                                );
                              })}
                              <ct-hstack gap="2">
                                <ct-button
                                  variant="primary"
                                  size="sm"
                                  disabled={addPersonDisabled}
                                  onClick={() => submitAddPerson.send()}
                                >
                                  Add Person
                                </ct-button>
                                <ct-button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => toggleAddPersonForm.send()}
                                >
                                  Cancel
                                </ct-button>
                              </ct-hstack>
                            </ct-vstack>
                          </ct-card>
                        )
                        : null}
                    </ct-vstack>

                    {/* Parking Spots */}
                    <ct-vstack gap="2">
                      <ct-hstack justify="between" align="center">
                        <ct-heading level={6}>Parking Spots</ct-heading>
                        <ct-button
                          variant="primary"
                          size="sm"
                          onClick={() => toggleAddSpotForm.send()}
                        >
                          + Add Spot
                        </ct-button>
                      </ct-hstack>

                      {adminSpotsData.map((spot) => {
                        const spotNum2 = spot.spotNumber;
                        const spotLabel2 = spot.label;
                        const spotNotes2 = spot.notes;
                        const spotActive2 = spot.active;
                        const isEditingSpot = computed(() =>
                          editingSpotNumber.get() === spotNum2
                        );
                        const isRemoveSpotConfirm = computed(() =>
                          removeSpotConfirmTarget.get() === spotNum2
                        );

                        return (
                          <ct-card style={spotActive2 ? "" : "opacity: 0.65;"}>
                            {isEditingSpot
                              ? (
                                <ct-vstack gap="2">
                                  <ct-hstack gap="2" wrap>
                                    <ct-vstack gap="1" style="min-width: 60px;">
                                      <span style="font-size: 0.75rem; font-weight: 500;">
                                        Number *
                                      </span>
                                      <ct-input
                                        $value={editSpotNum}
                                        placeholder="e.g. 12"
                                        style="width: 4rem;"
                                      />
                                    </ct-vstack>
                                    <ct-vstack gap="1" style="flex: 1;">
                                      <span style="font-size: 0.75rem; font-weight: 500;">
                                        Label
                                      </span>
                                      <ct-input
                                        $value={editSpotLabel}
                                        placeholder="e.g. Near entrance"
                                        style="width: 100%;"
                                      />
                                    </ct-vstack>
                                  </ct-hstack>
                                  <ct-vstack gap="1">
                                    <span style="font-size: 0.75rem; font-weight: 500;">
                                      Notes
                                    </span>
                                    <ct-input
                                      $value={editSpotNotes}
                                      placeholder="e.g. Tight, no large vehicles"
                                      style="width: 100%;"
                                    />
                                  </ct-vstack>
                                  <ct-hstack gap="2" align="center">
                                    <ct-checkbox $checked={editSpotActive}>
                                      Active
                                    </ct-checkbox>
                                    {spotDeactivateWarning
                                      ? (
                                        <span style="font-size: 0.75rem; color: var(--ct-color-amber-600);">
                                          Has upcoming allocations — they will
                                          remain.
                                        </span>
                                      )
                                      : null}
                                  </ct-hstack>
                                  <ct-hstack gap="2">
                                    <ct-button
                                      variant="primary"
                                      size="sm"
                                      onClick={() =>
                                        saveEditSpot.send({
                                          originalNumber: spotNum2,
                                        })}
                                    >
                                      Save
                                    </ct-button>
                                    <ct-button
                                      variant="secondary"
                                      size="sm"
                                      onClick={() => cancelEditSpot.send()}
                                    >
                                      Cancel
                                    </ct-button>
                                  </ct-hstack>
                                </ct-vstack>
                              )
                              : (
                                <>
                                  <ct-hstack
                                    justify="between"
                                    align="center"
                                    gap="2"
                                    wrap
                                  >
                                    <ct-hstack gap="2" align="center" wrap>
                                      <span
                                        style={`font-weight: 700; font-size: 1rem; color: ${
                                          spotActive2
                                            ? "var(--ct-color-gray-800)"
                                            : "var(--ct-color-gray-400)"
                                        };`}
                                      >
                                        #{spotNum2}
                                      </span>
                                      <ct-vstack gap="0">
                                        <span
                                          style={`font-size: 0.875rem; color: ${
                                            spotActive2
                                              ? "var(--ct-color-gray-700)"
                                              : "var(--ct-color-gray-400)"
                                          }; text-decoration: ${
                                            spotActive2
                                              ? "none"
                                              : "line-through"
                                          };`}
                                        >
                                          {spotLabel2 || "(no label)"}
                                        </span>
                                        {spotNotes2
                                          ? (
                                            <span style="font-size: 0.75rem; color: var(--ct-color-gray-400);">
                                              {spotNotes2}
                                            </span>
                                          )
                                          : null}
                                      </ct-vstack>
                                      {!spotActive2
                                        ? (
                                          <span style="font-size: 0.6875rem; background-color: #f3f4f6; color: #6b7280; padding: 1px 6px; border-radius: 9999px;">
                                            Inactive
                                          </span>
                                        )
                                        : null}
                                    </ct-hstack>
                                    <ct-hstack gap="1">
                                      <ct-button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          startEditSpot.send({
                                            spotNumber: spotNum2,
                                          })}
                                      >
                                        Edit
                                      </ct-button>
                                      <ct-button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          initiateRemoveSpot.send({
                                            spotNumber: spotNum2,
                                          })}
                                      >
                                        Remove
                                      </ct-button>
                                    </ct-hstack>
                                  </ct-hstack>
                                  {isRemoveSpotConfirm
                                    ? (
                                      <ct-card style="background: #fef2f2; border: 1px solid #fecaca; margin-top: 0.5rem;">
                                        <ct-vstack gap="1">
                                          <span style="font-size: 0.75rem; color: var(--ct-color-red-700);">
                                            Spot #{spotNum2}{" "}
                                            has upcoming allocations. They will
                                            be preserved. Remove anyway?
                                          </span>
                                          <ct-hstack gap="2">
                                            <ct-button
                                              variant="primary"
                                              size="sm"
                                              onClick={() =>
                                                removeSpot.send({
                                                  spotNumber: spotNum2,
                                                })}
                                            >
                                              Remove
                                            </ct-button>
                                            <ct-button
                                              variant="ghost"
                                              size="sm"
                                              onClick={() =>
                                                cancelRemoveSpot.send()}
                                            >
                                              Cancel
                                            </ct-button>
                                          </ct-hstack>
                                        </ct-vstack>
                                      </ct-card>
                                    )
                                    : null}
                                </>
                              )}
                          </ct-card>
                        );
                      })}

                      {addSpotFormOpen
                        ? (
                          <ct-card style="border: 2px dashed var(--ct-color-gray-200);">
                            <ct-vstack gap="2">
                              <ct-heading level={6}>Add Spot</ct-heading>
                              <ct-hstack gap="2" wrap>
                                <ct-vstack gap="1" style="min-width: 60px;">
                                  <span style="font-size: 0.75rem; font-weight: 500;">
                                    Number *
                                  </span>
                                  <ct-input
                                    $value={newSpotNumber}
                                    placeholder="e.g. 12"
                                    style="width: 4rem;"
                                  />
                                </ct-vstack>
                                <ct-vstack gap="1" style="flex: 1;">
                                  <span style="font-size: 0.75rem; font-weight: 500;">
                                    Label
                                  </span>
                                  <ct-input
                                    $value={newSpotLabel}
                                    placeholder="e.g. Near entrance"
                                    style="width: 100%;"
                                  />
                                </ct-vstack>
                              </ct-hstack>
                              <ct-vstack gap="1">
                                <span style="font-size: 0.75rem; font-weight: 500;">
                                  Notes
                                </span>
                                <ct-input
                                  $value={newSpotNotes}
                                  placeholder="e.g. Compact only"
                                  style="width: 100%;"
                                />
                              </ct-vstack>
                              {computed(() => {
                                const err = addSpotError.get();
                                if (!err) return null;
                                return (
                                  <span style="font-size: 0.75rem; color: var(--ct-color-red-600);">
                                    {err}
                                  </span>
                                );
                              })}
                              <ct-hstack gap="2">
                                <ct-button
                                  variant="primary"
                                  size="sm"
                                  disabled={addSpotDisabled}
                                  onClick={() => submitAddSpot.send()}
                                >
                                  Add Spot
                                </ct-button>
                                <ct-button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => toggleAddSpotForm.send()}
                                >
                                  Cancel
                                </ct-button>
                              </ct-hstack>
                            </ct-vstack>
                          </ct-card>
                        )
                        : null}
                    </ct-vstack>
                  </>
                )
                : null}
            </ct-vstack>
          </ct-vscroll>
        </ct-screen>
      ),

      // Exposed state (Writables auto-unwrap to their T type)
      spots,
      people,
      requests,
      adminMode,
      selectedPersonName,
      requestDate,
      requestResult,

      // Exposed actions
      toggleAdminMode,
      submitRequest,
      cancelRequest,
      addPerson,
      editPerson,
      removePerson,
      movePersonUp,
      movePersonDown,
      addSpot,
      editSpot,
      removeSpot,
      adminOverride,
    };
  },
);
