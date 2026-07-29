import {
  action,
  type AddIntegrity,
  computed,
  Default,
  handler,
  NAME,
  pattern,
  type PerSpace,
  type RequiresIntegrity,
  resultOf,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import {
  type AdminManagerCredential,
  adminManagerCredentialIsActive,
  adminRegistryEntries,
  type EmptyAdminRegistryValue,
} from "../../cfc/admin/mod.ts";
import {
  formatVehicle,
  modelsForMake,
  normalizeVehicle,
  normalizeVehicles,
  US_STATES,
  type Vehicle,
  VEHICLE_COLORS,
  VEHICLE_MAKES,
} from "../../vehicles.ts";

export type { Vehicle };

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
  vehicles?: Vehicle[];
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

export const PARKING_ADMIN_INTEGRITY = "parking-admin" as const;
export const PARKING_ADMIN_MANAGER_INTEGRITY = "parking-admin-manager" as const;

export interface ParkingAdminSubject {
  personName: string;
}

export interface ParkingAdminRoleAssignment {
  subject: ParkingAdminSubject;
  displayName: string;
}

export type ParkingAdminRole = AddIntegrity<
  ParkingAdminRoleAssignment,
  readonly [typeof PARKING_ADMIN_INTEGRITY]
>;

export type ParkingAdminManagerCredential = AdminManagerCredential<
  typeof PARKING_ADMIN_MANAGER_INTEGRITY
>;

export type ParkingAdminList = RequiresIntegrity<
  ParkingAdminRole[],
  readonly [typeof PARKING_ADMIN_MANAGER_INTEGRITY]
>;

export interface ParkingAdminRegistryStoredValue {
  admins?: ParkingAdminList;
}

export type ParkingAdminRegistryValue =
  | ParkingAdminRegistryStoredValue
  | Default<EmptyAdminRegistryValue>;
export type ParkingAdminRegistryCell = Writable<ParkingAdminRegistryValue>;
export type ParkingAdminManagerCredentialCell = Writable<
  ParkingAdminManagerCredential | null
>;

export type ParkingSpotList = RequiresIntegrity<
  ParkingSpot[],
  readonly [typeof PARKING_ADMIN_INTEGRITY]
>;

type SpotsCell = Writable<
  | ParkingSpotList
  | Default<[
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
type PeopleCell = Writable<Person[] | Default<[]>>;
type RequestsCell = Writable<SpotRequest[] | Default<[]>>;

// ============================================================
// Pattern I/O Types
// ============================================================

export interface ParkingCoordinatorInput {
  spots?: PerSpace<SpotsCell>;
  people?: PerSpace<PeopleCell>;
  requests?: PerSpace<RequestsCell>;
  adminRegistry?: PerSpace<ParkingAdminRegistryCell>;
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
  adminRegistry: PerSpace<ParkingAdminRegistryCell>;
  currentPersonIsAdmin: boolean;
  currentUserCanManageAdmins: boolean;
  enableAdminManager: Stream<void>;
  togglePersonAdmin: Stream<{ name: string }>;
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
    vehicles?: Vehicle[];
  }>;
  editPerson: Stream<{
    originalName: string;
    name: string;
    email: string;
    commuteMode: CommuteMode;
    priorityRank: number;
    defaultSpot: string;
    preferences: string;
    vehicles?: Vehicle[];
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

const genId = (): string =>
  `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const parsePreferences = (s: string | null | undefined): string[] =>
  (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

// Make→model cascade: when a make select changes, clear the dependent model so a
// stale value (e.g. make=Honda, model=Camry) can't linger. `$value` keeps the
// make cell in sync; this handler only resets the model. cf-select event props
// bind to a handler() object, which must be defined at module scope.
const resetModelOnMakeChange = handler<
  { detail?: { value?: string } },
  { model: Writable<string> }
>((_event, { model }) => {
  model.set("");
});

const parkingAdminSubject = (personName: string): ParkingAdminSubject => ({
  personName,
});

const parkingAdminRolesValue = (
  registry: ParkingAdminRegistryCell,
): ParkingAdminRole[] => adminRegistryEntries<ParkingAdminRole>(registry);

const parkingAdminRoleForPerson = (
  registry: ParkingAdminRegistryCell,
  personName: string | undefined,
): ParkingAdminRole | undefined => {
  const trimmedName = (personName ?? "").trim();
  return trimmedName === ""
    ? undefined
    : parkingAdminRolesValue(registry).find((role) =>
      role.subject.personName === trimmedName
    );
};

const personIsParkingAdmin = (
  registry: ParkingAdminRegistryCell,
  personName: string | undefined,
): boolean => parkingAdminRoleForPerson(registry, personName) !== undefined;

// Demo-only identity model: the selected person name stands in for the actor.
// Do not copy this for production authorization; use a stable user/profile cell.
const currentActorName = (
  selectedPersonName: Writable<string>,
  people: PeopleCell,
): string => selectedPersonName.get() || (people.get() ?? [])[0]?.name || "";

const currentParkingAdminRole = (
  registry: ParkingAdminRegistryCell,
  selectedPersonName: Writable<string>,
  people: PeopleCell,
): ParkingAdminRole | undefined =>
  parkingAdminRoleForPerson(
    registry,
    currentActorName(selectedPersonName, people),
  );

const currentUserCanManageParkingAdmins = (
  credential: ParkingAdminManagerCredentialCell,
): boolean => adminManagerCredentialIsActive(credential.get());

const prepareParkingAdminToggle = (
  credential: ParkingAdminManagerCredential | null | undefined,
  registry: ParkingAdminRegistryCell,
  rawName: string,
): ParkingAdminRole[] | null => {
  const personName = rawName.trim();
  if (!adminManagerCredentialIsActive(credential) || personName === "") {
    return null;
  }

  const adminRoles = parkingAdminRolesValue(registry);
  const nextRoles = adminRoles.filter((role) =>
    role.subject.personName !== personName
  );
  if (nextRoles.length !== adminRoles.length) {
    return nextRoles;
  }

  return [
    ...nextRoles,
    {
      subject: parkingAdminSubject(personName),
      displayName: personName,
    } as ParkingAdminRole,
  ];
};

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
  (
    {
      spots: inputSpots,
      people: inputPeople,
      requests: inputRequests,
      adminRegistry: inputAdminRegistry,
    },
  ) => {
    const spots = inputSpots ?? Writable.perSpace.of(DEFAULT_SPOTS);
    const people = inputPeople ?? Writable.perSpace.of<Person[]>([]);
    const requests = inputRequests ?? Writable.perSpace.of<SpotRequest[]>([]);
    const defaultAdminRegistry = new Writable.perSpace<
      ParkingAdminRegistryValue
    >(
      {} as ParkingAdminRegistryValue,
    );
    const adminRegistry: ParkingAdminRegistryCell = inputAdminRegistry ??
      defaultAdminRegistry;
    const adminManagerCredential = new Writable.perUser<
      ParkingAdminManagerCredential | null
    >(null);

    const nowRequest = wish<number>({ query: "#now" });
    const nowValue = resultOf(nowRequest.result);
    const todayStr = computed(() => toLocalDateStr(nowValue));
    const weekDatesArr = computed(() => getWeekDates(todayStr));

    // User/session UI state
    const selectedPersonName = new Writable.perUser("");
    const adminMode = new Writable.perSession(false);
    // Seed empty and fill from #now once it resolves, so the request-date input
    // defaults to today without reading the ambient clock at pattern body.
    const requestDate = new Writable.perSession("");
    computed(() => {
      const today = todayStr;
      if (today !== "" && requestDate.get() === "") {
        requestDate.set(today);
      }
    });
    const requestResult = new Writable.perSession("");

    // Admin form state
    const addPersonFormOpen = new Writable.perSession(false);
    const addSpotFormOpen = new Writable.perSession(false);
    const editingPersonName = new Writable.perSession<string | null>(null);
    const editingSpotNumber = new Writable.perSession<string | null>(null);
    const removePersonConfirmTarget = new Writable.perSession<string | null>(
      null,
    );
    const removeSpotConfirmTarget = new Writable.perSession<string | null>(
      null,
    );

    // Add person form fields
    const newPersonName = new Writable.perSession("");
    const newPersonEmail = new Writable.perSession("");
    const newPersonCommuteMode = new Writable.perSession<CommuteMode>("drive");
    const newPersonPriority = new Writable.perSession("1");
    const newPersonDefaultSpot = new Writable.perSession("");
    const newPersonPreferences = new Writable.perSession("");
    const addPersonError = new Writable.perSession("");

    // Add spot form fields
    const newSpotNumber = new Writable.perSession("");
    const newSpotLabel = new Writable.perSession("");
    const newSpotNotes = new Writable.perSession("");
    const addSpotError = new Writable.perSession("");

    // Edit person form fields
    const editName = new Writable.perSession("");
    const editEmail = new Writable.perSession("");
    const editCommuteMode = new Writable.perSession<CommuteMode>("drive");
    const editPriorityRank = new Writable.perSession("1");
    const editDefaultSpot = new Writable.perSession("");
    const editPreferences = new Writable.perSession("");

    // Edit spot form fields
    const editSpotNum = new Writable.perSession("");
    const editSpotLabel = new Writable.perSession("");
    const editSpotNotes = new Writable.perSession("");
    const editSpotActive = new Writable.perSession(true);

    // Add person — vehicle draft state
    const pendingVehicles = new Writable.perSession<Vehicle[]>([]);
    const draftPlateId = new Writable.perSession("");
    const draftPlateState = new Writable.perSession("CA");
    const draftColor = new Writable.perSession("");
    const draftMake = new Writable.perSession("");
    const draftModel = new Writable.perSession("");

    // Edit person — vehicle draft state
    const editVehicles = new Writable.perSession<Vehicle[]>([]);
    const editDraftPlateId = new Writable.perSession("");
    const editDraftPlateState = new Writable.perSession("CA");
    const editDraftColor = new Writable.perSession("");
    const editDraftMake = new Writable.perSession("");
    const editDraftModel = new Writable.perSession("");

    // Vehicle draft error cells
    const draftVehicleError = new Writable.perSession("");
    const editDraftVehicleError = new Writable.perSession("");

    // Override state
    const gridOverrideSpot = new Writable.perSession("");
    const gridOverrideDate = new Writable.perSession("");
    const overridePersonName = new Writable.perSession("");
    const activeRequestDate = computed(() => requestDate.get() || todayStr);

    // --------------------------------------------------------
    // Actions
    // --------------------------------------------------------

    const enableAdminManager = action(() => {
      adminManagerCredential.set({
        canManageAdmins: true,
      } as ParkingAdminManagerCredential);
    });

    const togglePersonAdmin = action<{ name: string }>(({ name }) => {
      const nextAdmins = prepareParkingAdminToggle(
        adminManagerCredential.get(),
        adminRegistry,
        name,
      );
      if (nextAdmins === null) {
        return;
      }
      adminRegistry.set({ admins: nextAdmins as ParkingAdminList });
    });

    const toggleAdminMode = action(() => {
      if (
        !currentParkingAdminRole(adminRegistry, selectedPersonName, people)
      ) {
        adminMode.set(false);
        return;
      }
      adminMode.set(!adminMode.get());
    });

    const submitRequest = action<{ personName: string; date: string }>(
      ({ personName: pNameArg, date: dateArg }) => {
        // Use provided args, or fall back to form state
        const pName = pNameArg || selectedPersonName.get() || "";
        const date = dateArg || activeRequestDate || todayStr;

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
        vehicles?: Vehicle[];
      }
    >((event) => {
      const {
        name = newPersonName.get() ?? "",
        email = newPersonEmail.get() ?? "",
        commuteMode = newPersonCommuteMode.get() ?? "drive",
        priorityRank = parseInt(newPersonPriority.get() ?? "") || 1,
        defaultSpot = newPersonDefaultSpot.get() ?? "",
        preferences = newPersonPreferences.get() ?? "",
        vehicles: vehiclesArg,
      } = event ?? {};
      const trimName = name.trim();
      const trimEmail = email.trim();
      if (!trimName || !trimEmail) return;

      const current = people.get();
      if (current.some((p) => p.name === trimName)) {
        addPersonError.set(`A person named "${trimName}" already exists.`);
        return;
      }
      addPersonError.set("");

      // The staged vehicles array does not survive the intra-pattern
      // action→action stream send (it arrives `undefined` at the handler),
      // so fall back to reading the staged perSession cell directly — the
      // same way the other fields default to their form cells above.
      const normalizedVehicles = normalizeVehicles(
        vehiclesArg ?? pendingVehicles.get(),
      );

      const newPerson: Person = {
        name: trimName,
        email: trimEmail,
        commuteMode,
        priorityRank: priorityRank || 1,
        defaultSpot: defaultSpot || "",
        spotPreferences: parsePreferences(preferences),
        vehicles: normalizedVehicles,
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
      pendingVehicles.set([]);
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
        vehicles?: Vehicle[];
      }
    >((event) => {
      const {
        originalName = editingPersonName.get() ?? "",
        name: editPersonNameArg = editName.get() ?? "",
        email: editPersonEmailArg = editEmail.get() ?? "",
        commuteMode: editPersonCommuteModeArg = editCommuteMode.get() ??
          "drive",
        priorityRank: editPersonPriorityArg =
          parseInt(editPriorityRank.get() ?? "") || 1,
        defaultSpot: editPersonDefaultSpotArg = editDefaultSpot.get() ?? "",
        preferences: editPersonPreferencesArg = editPreferences.get() ?? "",
        vehicles: vehiclesArg,
      } = event ?? {};
      const trimName = editPersonNameArg.trim();
      const trimEmail = editPersonEmailArg.trim();
      if (!trimName || !trimEmail) return;

      const current = people.get();
      if (
        trimName !== originalName && current.some((p) => p.name === trimName)
      ) return;

      people.set(current.map((p) => {
        if (p.name !== originalName) return p;

        // When vehicles omitted, preserve existing; when provided, normalize
        const nextVehicles: Vehicle[] = vehiclesArg === undefined
          ? (p.vehicles ?? [])
          : normalizeVehicles(vehiclesArg);

        return {
          ...p,
          name: trimName,
          email: trimEmail,
          commuteMode: editPersonCommuteModeArg,
          priorityRank: editPersonPriorityArg || p.priorityRank,
          defaultSpot: editPersonDefaultSpotArg || "",
          spotPreferences: parsePreferences(editPersonPreferencesArg),
          vehicles: nextVehicles,
        };
      }));

      if (selectedPersonName.get() === originalName) {
        selectedPersonName.set(trimName);
      }

      if (trimName !== originalName) {
        requests.set(
          requests.get().map((r) =>
            r.personName === originalName ? { ...r, personName: trimName } : r
          ),
        );
        if (adminManagerCredentialIsActive(adminManagerCredential.get())) {
          adminRegistry.set({
            admins: parkingAdminRolesValue(adminRegistry).map((role) =>
              role.subject.personName === originalName
                ? {
                  subject: parkingAdminSubject(trimName),
                  displayName: trimName,
                } as ParkingAdminRole
                : role
            ) as ParkingAdminList,
          });
        }
      }

      editingPersonName.set(null);
    });

    const removePerson = action<{ name: string }>(({ name }) => {
      people.set(people.get().filter((p) => p.name !== name));
      if (adminManagerCredentialIsActive(adminManagerCredential.get())) {
        adminRegistry.set({
          admins: parkingAdminRolesValue(adminRegistry).filter((role) =>
            role.subject.personName !== name
          ) as ParkingAdminList,
        });
      }
      if (selectedPersonName.get() === name) {
        const remaining = people.get();
        selectedPersonName.set(remaining[0]?.name ?? "");
      }
      removePersonConfirmTarget.set(null);
    });

    const movePersonUp = action<{ name: string }>(({ name }) => {
      const sorted = [...(people.get() ?? [])].sort((a, b) =>
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
      const sorted = [...(people.get() ?? [])].sort((a, b) =>
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
    >((event) => {
      if (
        !currentParkingAdminRole(adminRegistry, selectedPersonName, people)
      ) {
        return;
      }
      const {
        spotNumber: spotNumArg = newSpotNumber.get() ?? "",
        label = newSpotLabel.get() ?? "",
        notes = newSpotNotes.get() ?? "",
      } = event ?? {};
      const trimNum = spotNumArg.trim();
      if (!trimNum) return;
      const current = spots.get();
      if (current.some((s) => s.spotNumber === trimNum)) {
        addSpotError.set(`Spot #${trimNum} already exists.`);
        return;
      }
      addSpotError.set("");
      spots.set([
        ...current,
        {
          spotNumber: trimNum,
          label: label.trim(),
          notes: notes.trim(),
          active: true,
        },
      ] as ParkingSpotList);
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
    >((event) => {
      if (
        !currentParkingAdminRole(adminRegistry, selectedPersonName, people)
      ) {
        return;
      }
      const {
        originalNumber = editingSpotNumber.get() ?? "",
        spotNumber: spotNumArg2 = editSpotNum.get() ?? "",
        label: editSpotLabelArg = editSpotLabel.get() ?? "",
        notes: editSpotNotesArg = editSpotNotes.get() ?? "",
        active: editSpotActiveArg = editSpotActive.get() ?? true,
      } = event ?? {};
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
              label: editSpotLabelArg.trim(),
              notes: editSpotNotesArg.trim(),
              active: editSpotActiveArg,
            }
            : s
        ) as ParkingSpotList,
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
        if (
          !currentParkingAdminRole(adminRegistry, selectedPersonName, people)
        ) {
          return;
        }
        spots.set(
          spots.get().filter((s) =>
            s.spotNumber !== spotNumArg3
          ) as ParkingSpotList,
        );
        removeSpotConfirmTarget.set(null);
      },
    );

    const adminOverride = action<
      { spotNumber: string; date: string; personName: string }
    >(({ spotNumber, date, personName }) => {
      if (
        !currentParkingAdminRole(adminRegistry, selectedPersonName, people)
      ) {
        return;
      }
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
      editVehicles.set([...(p.vehicles ?? [])]);
      editDraftPlateId.set("");
      editDraftPlateState.set("CA");
      editDraftColor.set("");
      editDraftMake.set("");
      editDraftModel.set("");
      editDraftVehicleError.set("");
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
          // Materialize plain objects: spreading the cell's array yields
          // query-result proxies whose fields read empty across the send()
          // boundary, so vehicles would silently drop. Rebuild them here.
          vehicles: editVehicles.get().map((v) => ({
            plateId: v.plateId,
            plateState: v.plateState,
            color: v.color,
            make: v.make,
            model: v.model,
          })),
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
        overridePersonName.set((people.get() ?? [])[0]?.name ?? "");
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
        // Materialize plain objects: spreading the cell's array yields
        // query-result proxies whose fields read empty across the send()
        // boundary, so vehicles would silently drop. Rebuild them here.
        vehicles: pendingVehicles.get().map((v) => ({
          plateId: v.plateId,
          plateState: v.plateState,
          color: v.color,
          make: v.make,
          model: v.model,
        })),
      });
    });

    const submitAddSpot = action(() => {
      addSpot.send({
        spotNumber: newSpotNumber.get(),
        label: newSpotLabel.get(),
        notes: newSpotNotes.get(),
      });
    });

    // Vehicle actions — add/remove for pending (add-person form)
    const addPendingVehicle = action(() => {
      const candidate = normalizeVehicle({
        plateId: draftPlateId.get(),
        plateState: draftPlateState.get(),
        color: draftColor.get(),
        make: draftMake.get(),
        model: draftModel.get(),
      });
      if (!candidate.plateId) {
        draftVehicleError.set("Plate ID is required.");
        return;
      }
      const existing = pendingVehicles.get();
      const key = `${candidate.plateId}|${candidate.plateState}`;
      if (existing.some((v) => `${v.plateId}|${v.plateState}` === key)) {
        draftVehicleError.set("That plate is already listed.");
        return;
      }
      draftVehicleError.set("");
      pendingVehicles.set([...existing, candidate]);
      draftPlateId.set("");
      draftPlateState.set("CA");
      draftColor.set("");
      draftMake.set("");
      draftModel.set("");
    });

    const removePendingVehicle = action<{ index: number }>(({ index }) => {
      const current = [...pendingVehicles.get()];
      current.splice(index, 1);
      pendingVehicles.set(current);
    });

    // Vehicle actions — add/remove for editVehicles (edit-person form)
    const addEditVehicle = action(() => {
      const candidate = normalizeVehicle({
        plateId: editDraftPlateId.get(),
        plateState: editDraftPlateState.get(),
        color: editDraftColor.get(),
        make: editDraftMake.get(),
        model: editDraftModel.get(),
      });
      if (!candidate.plateId) {
        editDraftVehicleError.set("Plate ID is required.");
        return;
      }
      const existing = editVehicles.get();
      const key = `${candidate.plateId}|${candidate.plateState}`;
      if (existing.some((v) => `${v.plateId}|${v.plateState}` === key)) {
        editDraftVehicleError.set("That plate is already listed.");
        return;
      }
      editDraftVehicleError.set("");
      editVehicles.set([...existing, candidate]);
      editDraftPlateId.set("");
      editDraftPlateState.set("CA");
      editDraftColor.set("");
      editDraftMake.set("");
      editDraftModel.set("");
    });

    const removeEditVehicle = action<{ index: number }>(({ index }) => {
      const current = [...editVehicles.get()];
      current.splice(index, 1);
      editVehicles.set(current);
    });

    const toggleAddPersonForm = action(() => {
      addPersonFormOpen.set(!addPersonFormOpen.get());
      draftVehicleError.set("");
    });
    const toggleAddSpotForm = action(() =>
      addSpotFormOpen.set(!addSpotFormOpen.get())
    );

    // --------------------------------------------------------
    // Helper computeds for UI (keep action closures using .get())
    // --------------------------------------------------------

    const _isDateInPast = computed(() => activeRequestDate < todayStr);

    const spotDeactivateWarning = computed(() => {
      const editNum = editingSpotNumber.get();
      if (!editNum || (editSpotActive.get() ?? true)) return false;
      return (requests.get() ?? []).some(
        (r) =>
          r.assignedSpot === editNum && r.status === "allocated" &&
          r.date >= todayStr,
      );
    });

    const noPeople = computed(() => (people.get() ?? []).length === 0);

    const personSelectItems = computed(() =>
      (people.get() ?? []).map((p) => ({ label: p.name, value: p.name }))
    );

    const requestDisabled = computed(() =>
      !selectedPersonName.get() ||
      activeRequestDate < todayStr || (people.get() ?? []).length === 0
    );

    const currentPersonIsAdmin = computed(() =>
      currentParkingAdminRole(adminRegistry, selectedPersonName, people) !==
        undefined
    );

    const adminModeEnabled = computed(() =>
      adminMode.get() ? currentPersonIsAdmin : false
    );

    const currentUserCanManageAdmins = computed(() =>
      currentUserCanManageParkingAdmins(adminManagerCredential)
    );
    const canBootstrapPeople = computed(() =>
      (people.get() ?? []).length === 0 &&
      currentUserCanManageParkingAdmins(adminManagerCredential)
    );
    const showAdminPeopleSection = computed(() =>
      adminModeEnabled === true || canBootstrapPeople === true
    );

    const adminAccessRows = computed(() =>
      (people.get() ?? []).map((person) => ({
        name: person.name,
        email: person.email,
        isAdmin: personIsParkingAdmin(adminRegistry, person.name),
        canManageAdmins: currentUserCanManageAdmins === true,
      }))
    );

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
      const allSpots = (spots.get() ?? []).filter((s) => s != null && s.active);
      const allRequests = requests.get() ?? [];
      const currentPerson = selectedPersonName.get();
      const overrideSpot = gridOverrideSpot.get();
      const overrideDate = gridOverrideDate.get();
      const overridePerson = overridePersonName.get();
      const weekGridShowAdmin = adminModeEnabled === true;

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
      const allSpots = (spots.get() ?? []).filter((s) => s != null && s.active);
      const allRequests = requests.get() ?? [];
      const currentPerson = selectedPersonName.get();
      const todayStripShowAdmin = adminModeEnabled === true;

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
      // Read the perSession edit/remove-confirm targets HERE, at the top of
      // this computed, and emit `isEditing`/`isRemoveConfirm` per person.
      // Reading these perSession cells from a `computed()` nested inside the
      // `.map()` render below silently returns nothing (a narrower perSession
      // cell can't be followed from that space-scoped render context), so the
      // inline edit form / remove-confirm prompt never opened.
      const editingName = editingPersonName.get();
      const removeConfirmName = removePersonConfirmTarget.get();
      const sorted = [...(people.get() ?? [])].sort((a, b) =>
        a.priorityRank - b.priorityRank
      );
      return sorted.map((p, idx) => ({
        name: p.name,
        email: p.email,
        commuteMode: p.commuteMode,
        priorityRank: p.priorityRank,
        defaultSpot: p.defaultSpot,
        spotPreferences: [...p.spotPreferences],
        vehicles: [...(p.vehicles ?? [])].map((v) => ({
          formatted: formatVehicle(v),
        })),
        isFirst: idx === 0,
        isLast: idx === sorted.length - 1,
        isEditing: editingName === p.name,
        isRemoveConfirm: removeConfirmName === p.name,
      }));
    });

    // Pre-compute vehicle select options for draft forms (cascade make→model)
    const draftModelItems = computed(() => {
      const make = draftMake.get();
      const models = modelsForMake(make);
      return [
        { label: "—", value: "" },
        ...models.map((m) => ({ label: m, value: m })),
      ];
    });

    const editDraftModelItems = computed(() => {
      const make = editDraftMake.get();
      const models = modelsForMake(make);
      return [
        { label: "—", value: "" },
        ...models.map((m) => ({ label: m, value: m })),
      ];
    });

    const colorSelectItems = [
      { label: "—", value: "" },
      ...VEHICLE_COLORS.map((c) => ({ label: c, value: c })),
    ];

    const makeSelectItems = [
      { label: "—", value: "" },
      ...VEHICLE_MAKES.map((m) => ({ label: m, value: m })),
    ];

    const stateSelectItems = US_STATES.map((s) => ({ label: s, value: s }));

    // Pre-compute vehicle row display data to avoid OpaqueCell closure issues.
    // Accessing Vehicle fields inside these single top-level computeds is safe.
    const pendingVehicleRows = computed(() =>
      (pendingVehicles.get() ?? []).map((v, idx) => ({
        idx,
        formatted: formatVehicle(v),
      }))
    );

    const editVehicleRows = computed(() =>
      (editVehicles.get() ?? []).map((v, idx) => ({
        idx,
        formatted: formatVehicle(v),
      }))
    );

    // Pre-compute disabled flags for model selects (avoids .get() in JSX prop)
    const draftMakeSelected = computed(() => !!draftMake.get());
    const editDraftMakeSelected = computed(() => !!editDraftMake.get());

    // Pre-compute sorted spots list for admin panel
    const adminSpotsData = computed(() => {
      // Read the perSession edit/remove-confirm targets HERE (see the matching
      // note on `adminPeopleData`): a `computed()` nested in the `.map()` render
      // can't follow these narrower perSession cells from its space-scoped
      // context, so the inline spot edit/remove prompts never opened.
      const editingNum = editingSpotNumber.get();
      const removeConfirmNum = removeSpotConfirmTarget.get();
      return [...(spots.get() ?? [])].map((s) => ({
        spotNumber: s.spotNumber,
        label: s.label,
        notes: s.notes,
        active: s.active,
        isEditingSpot: editingNum === s.spotNumber,
        isRemoveSpotConfirm: removeConfirmNum === s.spotNumber,
      }));
    });

    // --------------------------------------------------------
    // UI
    // --------------------------------------------------------

    return {
      [NAME]: "Parking Coordinator",
      [UI]: (
        <cf-screen>
          {/* Header */}
          <div
            slot="header"
            style="padding: 0.75rem 1rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--cf-colors-gray-200);"
          >
            <cf-heading level={4}>Parking</cf-heading>
            <div style="display: flex; align-items: center; gap: 0.75rem;">
              <span style="font-size: 0.875rem; color: var(--cf-colors-gray-500);">
                {todayFormatted}
              </span>
              <cf-button
                id="parking-admin-mode-toggle"
                variant={adminModeEnabled ? "primary" : "secondary"}
                size="sm"
                disabled={!currentPersonIsAdmin}
                onClick={() => toggleAdminMode.send()}
              >
                {adminModeEnabled ? "Admin: ON" : "Admin: OFF"}
              </cf-button>
              <cf-chip
                label={currentPersonIsAdmin
                  ? "Current person is admin"
                  : "Member"}
              />
            </div>
          </div>

          <cf-vscroll flex showScrollbar>
            <cf-vstack gap="3" style="padding: 1rem;">
              {/* === Section A: Today Strip === */}
              <cf-vstack gap="1">
                <cf-heading level={6}>Today — {todayFormatted}</cf-heading>

                {noPeople
                  ? (
                    <cf-card>
                      <span style="color: var(--cf-colors-gray-500); font-size: 0.875rem;">
                        No team members yet — ask your admin to add people.
                      </span>
                    </cf-card>
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
                    <cf-card
                      style={`padding: 0.625rem 0.875rem; border-left: 3px solid ${
                        stripIsAvailable ? "#22c55e" : "#93c5fd"
                      };`}
                    >
                      <cf-hstack justify="between" align="center" gap="2" wrap>
                        <cf-hstack gap="2" align="center">
                          <span style="font-weight: 600; font-size: 0.875rem; min-width: 2rem;">
                            #{stripSpotNumber}
                          </span>
                          {stripSpotLabel
                            ? (
                              <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                                {stripSpotLabel}
                              </span>
                            )
                            : null}
                        </cf-hstack>

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

                        <cf-hstack gap="1">
                          {stripReq && stripIsOwn
                            ? (
                              <cf-button
                                variant="secondary"
                                size="sm"
                                onClick={() =>
                                  cancelRequest.send({
                                    requestId: stripReq.id,
                                  })}
                              >
                                Cancel
                              </cf-button>
                            )
                            : null}

                          {stripShowAdmin
                            ? (
                              <cf-button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  openGridOverride.send({
                                    spotNumber: stripSpotNumber,
                                    date: todayStr,
                                  })}
                              >
                                Assign
                              </cf-button>
                            )
                            : null}
                        </cf-hstack>
                      </cf-hstack>
                    </cf-card>
                  );
                })}
              </cf-vstack>

              {/* === Section B: Request Form === */}
              <cf-card>
                <cf-vstack gap="2">
                  <cf-heading level={6}>Request a Spot</cf-heading>

                  <cf-hstack gap="2" align="end" wrap>
                    <cf-vstack gap="1" style="flex: 1; min-width: 140px;">
                      <span style="font-size: 0.75rem; font-weight: 500;">
                        Person
                      </span>
                      {noPeople
                        ? (
                          <span style="font-size: 0.875rem; color: var(--cf-colors-gray-500);">
                            No team members yet — ask your admin to add people.
                          </span>
                        )
                        : (
                          <cf-select
                            $value={selectedPersonName}
                            items={personSelectItems}
                            style="width: 100%;"
                          />
                        )}
                    </cf-vstack>

                    <cf-vstack gap="1" style="min-width: 140px;">
                      <span style="font-size: 0.75rem; font-weight: 500;">
                        Date
                      </span>
                      <cf-input
                        $value={requestDate}
                        type="date"
                        style="width: 100%;"
                      />
                    </cf-vstack>

                    <cf-button
                      variant="primary"
                      disabled={requestDisabled}
                      onClick={() =>
                        submitRequest.send({
                          personName: selectedPersonName.get(),
                          date: activeRequestDate,
                        })}
                    >
                      Request Spot
                    </cf-button>
                  </cf-hstack>

                  {computed(() => {
                    if (!(activeRequestDate < todayStr)) return null;
                    return (
                      <span style="font-size: 0.75rem; color: #92400e; background-color: #fef3c7; padding: 0.375rem 0.625rem; border-radius: 6px; display: block;">
                        Please select today or a future date.
                      </span>
                    );
                  })}

                  {computed(() => {
                    const result = requestResult.get() ?? "";
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
                </cf-vstack>
              </cf-card>

              {/* === Section C: Admin Access === */}
              <cf-card id="parking-admin-access">
                <cf-vstack gap="2">
                  <cf-hstack justify="between" align="center" wrap gap="2">
                    <cf-vstack gap="1">
                      <cf-heading level={6}>Admin Access</cf-heading>
                      <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                        Demo manager access lets any user change who can manage
                        parking spots.
                      </span>
                    </cf-vstack>
                    <cf-chip
                      label={currentUserCanManageAdmins
                        ? "Can manage admins"
                        : "Cannot manage admins"}
                    />
                    <cf-button
                      id="parking-enable-admin-manager"
                      size="sm"
                      disabled={currentUserCanManageAdmins}
                      onClick={() => enableAdminManager.send()}
                    >
                      Enable manager demo
                    </cf-button>
                  </cf-hstack>

                  {noPeople
                    ? (
                      <span style="font-size: 0.875rem; color: var(--cf-colors-gray-500);">
                        Add people before assigning admins.
                      </span>
                    )
                    : null}

                  {adminAccessRows.map((row) => {
                    const rowName = row.name;
                    const rowEmail = row.email;
                    const rowIsAdmin = row.isAdmin;
                    const rowCanManageAdmins = row.canManageAdmins;
                    return (
                      <cf-hstack
                        data-parking-admin-row={rowName}
                        justify="between"
                        align="center"
                        gap="2"
                        wrap
                        style="padding: 0.5rem 0.75rem; border: 1px solid var(--cf-colors-gray-200); border-radius: 0.75rem;"
                      >
                        <cf-vstack gap="0">
                          <cf-hstack gap="2" align="center" wrap>
                            <span style="font-weight: 600;">{rowName}</span>
                            <cf-chip
                              label={rowIsAdmin ? "Admin" : "Member"}
                              variant={rowIsAdmin ? "accent" : "default"}
                            />
                          </cf-hstack>
                          <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                            {rowEmail}
                          </span>
                        </cf-vstack>
                        <cf-button
                          data-parking-admin-toggle={rowName}
                          size="sm"
                          disabled={!rowCanManageAdmins}
                          onClick={() =>
                            togglePersonAdmin.send({
                              name: rowName,
                            })}
                        >
                          {rowIsAdmin ? "Remove admin" : "Make admin"}
                        </cf-button>
                      </cf-hstack>
                    );
                  })}
                </cf-vstack>
              </cf-card>

              {/* === Section D: Week-Ahead Grid === */}
              <cf-vstack gap="1">
                <cf-heading level={6}>This Week</cf-heading>

                {weekMonthInfo
                  ? (
                    <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
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
                            : "var(--cf-colors-gray-600)",
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
                          color: "var(--cf-colors-gray-700)",
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
                                <cf-vstack
                                  gap="1"
                                  style="background: white; border: 1px solid #e5e7eb; border-radius: 4px; padding: 0.375rem;"
                                >
                                  <cf-select
                                    $value={overridePersonName}
                                    items={computed(() =>
                                      (people.get() ?? []).map((p) => ({
                                        label: p.name,
                                        value: p.name,
                                      }))
                                    )}
                                    style="font-size: 0.6875rem;"
                                  />
                                  {gridConflictName
                                    ? (
                                      <span style="font-size: 0.625rem; color: var(--cf-colors-red-600);">
                                        Already assigned to{" "}
                                        {gridConflictName}. Overwrite?
                                      </span>
                                    )
                                    : null}
                                  <cf-hstack gap="1">
                                    <cf-button
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
                                    </cf-button>
                                    <cf-button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => cancelOverride.send()}
                                    >
                                      ×
                                    </cf-button>
                                  </cf-hstack>
                                </cf-vstack>
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
                                      <cf-button
                                        variant="ghost"
                                        size="sm"
                                        style="padding: 0; font-size: 0.625rem; line-height: 1; min-height: unset; color: var(--cf-colors-red-500);"
                                        onClick={() =>
                                          cancelRequest.send({
                                            requestId: gridReq.id,
                                          })}
                                      >
                                        ×
                                      </cf-button>
                                    )
                                    : null}
                                  {gridIsManual
                                    ? (
                                      <span style="position: absolute; top: 2px; right: 3px; font-size: 0.5rem; color: var(--cf-colors-gray-400); font-weight: 700;">
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
                                        : "var(--cf-colors-green-500)"
                                    }; font-size: 0.625rem;`}
                                  >
                                    Free
                                  </span>
                                  {gridShowAdmin
                                    ? (
                                      <cf-button
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
                                      </cf-button>
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
              </cf-vstack>

              {/* === Section E: Admin / bootstrap people management === */}
              {showAdminPeopleSection
                ? (
                  <>
                    {/* People */}
                    <cf-vstack id="parking-admin-people-section" gap="2">
                      <cf-hstack justify="between" align="center">
                        <cf-heading level={6}>People</cf-heading>
                        <cf-button
                          id="parking-admin-add-person-open"
                          variant="primary"
                          size="sm"
                          onClick={() => toggleAddPersonForm.send()}
                        >
                          + Add Person
                        </cf-button>
                      </cf-hstack>

                      {(people.get() ?? []).length === 0
                        ? (
                          <cf-card style="text-align: center; padding: 1.5rem;">
                            <cf-vstack gap="2" align="center">
                              <span style="font-size: 2rem;">👥</span>
                              <span style="color: var(--cf-colors-gray-500); font-size: 0.875rem;">
                                No team members yet. Add the first person below.
                              </span>
                            </cf-vstack>
                          </cf-card>
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
                          vehicles: personVehicles,
                          isFirst,
                          isLast,
                        } = person;
                        // Derived in `adminPeopleData` (see note there) — a
                        // `computed()` nested here that reads the perSession
                        // target cells does not re-render.
                        const isEditing = person.isEditing;
                        const isRemoveConfirm = person.isRemoveConfirm;
                        const activeSpotOpts = computed(() =>
                          (spots.get() ?? [])
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
                          <cf-card
                            style={computed(() =>
                              isEditing
                                ? "border: 2px solid var(--cf-colors-blue-500);"
                                : ""
                            )}
                          >
                            {isEditing
                              ? (
                                <cf-vstack gap="2">
                                  <cf-hstack gap="2" wrap>
                                    <cf-vstack
                                      gap="1"
                                      style="flex: 1; min-width: 120px;"
                                    >
                                      <span style="font-size: 0.75rem; font-weight: 500;">
                                        Name *
                                      </span>
                                      <cf-input
                                        $value={editName}
                                        placeholder="Full name"
                                        style="width: 100%;"
                                      />
                                    </cf-vstack>
                                    <cf-vstack
                                      gap="1"
                                      style="flex: 1; min-width: 120px;"
                                    >
                                      <span style="font-size: 0.75rem; font-weight: 500;">
                                        Email *
                                      </span>
                                      <cf-input
                                        $value={editEmail}
                                        placeholder="email@company.com"
                                        style="width: 100%;"
                                      />
                                    </cf-vstack>
                                  </cf-hstack>
                                  <cf-hstack gap="2" wrap>
                                    <cf-vstack
                                      gap="1"
                                      style="min-width: 100px;"
                                    >
                                      <span style="font-size: 0.75rem; font-weight: 500;">
                                        Commute
                                      </span>
                                      <cf-select
                                        $value={editCommuteMode}
                                        items={commuteModeOptions}
                                        style="width: 100%;"
                                      />
                                    </cf-vstack>
                                    <cf-vstack gap="1" style="min-width: 80px;">
                                      <span style="font-size: 0.75rem; font-weight: 500;">
                                        Priority *
                                      </span>
                                      <cf-input
                                        $value={editPriorityRank}
                                        type="number"
                                        style="width: 5rem;"
                                      />
                                    </cf-vstack>
                                    <cf-vstack
                                      gap="1"
                                      style="min-width: 100px;"
                                    >
                                      <span style="font-size: 0.75rem; font-weight: 500;">
                                        Default Spot
                                      </span>
                                      <cf-select
                                        $value={editDefaultSpot}
                                        items={editSpotItems}
                                        style="width: 100%;"
                                      />
                                    </cf-vstack>
                                  </cf-hstack>
                                  <cf-vstack gap="1">
                                    <span style="font-size: 0.75rem; font-weight: 500;">
                                      Preferences (comma-separated spot numbers)
                                    </span>
                                    <cf-input
                                      $value={editPreferences}
                                      placeholder="e.g. 1, 5, 12"
                                      style="width: 100%;"
                                    />
                                  </cf-vstack>

                                  {/* Edit form — Vehicles subsection */}
                                  <cf-vstack gap="1">
                                    <span style="font-size: 0.75rem; font-weight: 500;">
                                      Vehicles
                                    </span>
                                    {editVehicleRows.map((evRow) => (
                                      <cf-hstack gap="1" align="center">
                                        <span style="font-size: 0.75rem; flex: 1;">
                                          {evRow.formatted}
                                        </span>
                                        <cf-button
                                          variant="ghost"
                                          size="sm"
                                          onClick={() =>
                                            removeEditVehicle.send({
                                              index: evRow.idx,
                                            })}
                                        >
                                          ×
                                        </cf-button>
                                      </cf-hstack>
                                    ))}
                                    <cf-hstack gap="1" wrap align="end">
                                      <cf-vstack
                                        gap="0"
                                        style="min-width: 80px;"
                                      >
                                        <span style="font-size: 0.6875rem;">
                                          Plate *
                                        </span>
                                        <cf-input
                                          $value={editDraftPlateId}
                                          placeholder="e.g. 7ABC123"
                                          timingStrategy="immediate"
                                          style="width: 100%;"
                                        />
                                      </cf-vstack>
                                      <cf-vstack
                                        gap="0"
                                        style="min-width: 60px;"
                                      >
                                        <span style="font-size: 0.6875rem;">
                                          State
                                        </span>
                                        <cf-select
                                          $value={editDraftPlateState}
                                          items={stateSelectItems}
                                          style="width: 100%;"
                                        />
                                      </cf-vstack>
                                      <cf-vstack
                                        gap="0"
                                        style="min-width: 80px;"
                                      >
                                        <span style="font-size: 0.6875rem;">
                                          Color
                                        </span>
                                        <cf-select
                                          $value={editDraftColor}
                                          items={colorSelectItems}
                                          style="width: 100%;"
                                        />
                                      </cf-vstack>
                                      <cf-vstack
                                        gap="0"
                                        style="min-width: 100px;"
                                      >
                                        <span style="font-size: 0.6875rem;">
                                          Make
                                        </span>
                                        <cf-select
                                          $value={editDraftMake}
                                          items={makeSelectItems}
                                          oncf-change={resetModelOnMakeChange({
                                            model: editDraftModel,
                                          })}
                                          style="width: 100%;"
                                        />
                                      </cf-vstack>
                                      <cf-vstack
                                        gap="0"
                                        style="min-width: 100px;"
                                      >
                                        <span style="font-size: 0.6875rem;">
                                          Model
                                        </span>
                                        <cf-select
                                          $value={editDraftModel}
                                          items={editDraftModelItems}
                                          disabled={!editDraftMakeSelected}
                                          style="width: 100%;"
                                        />
                                      </cf-vstack>
                                      <cf-button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => addEditVehicle.send()}
                                      >
                                        + Add vehicle
                                      </cf-button>
                                    </cf-hstack>
                                    {computed(() => {
                                      const err = editDraftVehicleError.get();
                                      if (!err) return null;
                                      return (
                                        <span style="font-size: 0.75rem; color: var(--cf-colors-red-600);">
                                          {err}
                                        </span>
                                      );
                                    })}
                                  </cf-vstack>

                                  <cf-hstack gap="2">
                                    <cf-button
                                      variant="primary"
                                      size="sm"
                                      onClick={() =>
                                        saveEditPerson.send({
                                          originalName: personName,
                                        })}
                                    >
                                      Save
                                    </cf-button>
                                    <cf-button
                                      variant="secondary"
                                      size="sm"
                                      onClick={() => cancelEditPerson.send()}
                                    >
                                      Cancel
                                    </cf-button>
                                  </cf-hstack>
                                </cf-vstack>
                              )
                              : (
                                <cf-vstack gap="1">
                                  <cf-hstack
                                    justify="between"
                                    align="start"
                                    gap="2"
                                    wrap
                                  >
                                    <cf-vstack gap="0">
                                      <cf-hstack gap="2" align="center" wrap>
                                        <span style="font-weight: 600;">
                                          {personName}
                                        </span>
                                        <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                                          #{priorityRank}
                                        </span>
                                        {defaultSpot
                                          ? (
                                            <span style="font-size: 0.6875rem; background-color: #eff6ff; color: #1d4ed8; padding: 1px 6px; border-radius: 9999px;">
                                              Spot #{defaultSpot}
                                            </span>
                                          )
                                          : null}
                                      </cf-hstack>
                                      <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                                        {email}
                                      </span>
                                      <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500);">
                                        {commuteIcon(commuteMode)} {commuteMode}
                                      </span>
                                    </cf-vstack>

                                    <cf-hstack gap="1" align="center">
                                      <cf-button
                                        variant="ghost"
                                        size="sm"
                                        disabled={isFirst}
                                        onClick={() =>
                                          movePersonUp.send({
                                            name: personName,
                                          })}
                                      >
                                        ↑
                                      </cf-button>
                                      <cf-button
                                        variant="ghost"
                                        size="sm"
                                        disabled={isLast}
                                        onClick={() =>
                                          movePersonDown.send({
                                            name: personName,
                                          })}
                                      >
                                        ↓
                                      </cf-button>
                                      <cf-button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          startEditPerson.send({
                                            name: personName,
                                          })}
                                      >
                                        Edit
                                      </cf-button>
                                      <cf-button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          initiateRemovePerson.send({
                                            name: personName,
                                          })}
                                      >
                                        Remove
                                      </cf-button>
                                    </cf-hstack>
                                  </cf-hstack>

                                  {spotPreferences.length > 0
                                    ? (
                                      <span style="font-size: 0.75rem; color: var(--cf-colors-gray-400);">
                                        Prefers: {spotPreferences.map((n) =>
                                          "#" + n
                                        )
                                          .join(", ")}
                                      </span>
                                    )
                                    : null}

                                  {personVehicles.length > 0
                                    ? (
                                      <cf-hstack gap="1" wrap>
                                        {personVehicles.map((pv) => (
                                          <span style="font-size: 0.6875rem; background-color: #f0fdf4; color: #166534; padding: 1px 8px; border-radius: 9999px; border: 1px solid #bbf7d0;">
                                            {pv.formatted}
                                          </span>
                                        ))}
                                      </cf-hstack>
                                    )
                                    : null}

                                  {isRemoveConfirm
                                    ? (
                                      <cf-card style="background: #fef2f2; border: 1px solid #fecaca;">
                                        <cf-vstack gap="1">
                                          <span style="font-size: 0.75rem; color: var(--cf-colors-red-700);">
                                            This person has upcoming requests.
                                            They will be preserved. Remove
                                            anyway?
                                          </span>
                                          <cf-hstack gap="2">
                                            <cf-button
                                              variant="primary"
                                              size="sm"
                                              onClick={() =>
                                                removePerson.send({
                                                  name: personName,
                                                })}
                                            >
                                              Remove
                                            </cf-button>
                                            <cf-button
                                              variant="ghost"
                                              size="sm"
                                              onClick={() =>
                                                cancelRemovePerson.send()}
                                            >
                                              Cancel
                                            </cf-button>
                                          </cf-hstack>
                                        </cf-vstack>
                                      </cf-card>
                                    )
                                    : null}
                                </cf-vstack>
                              )}
                          </cf-card>
                        );
                      })}

                      {addPersonFormOpen.get()
                        ? (
                          <cf-card style="border: 2px dashed var(--cf-colors-gray-200);">
                            <cf-vstack gap="2">
                              <cf-heading level={6}>Add Person</cf-heading>
                              <cf-hstack gap="2" wrap>
                                <cf-vstack
                                  gap="1"
                                  style="flex: 1; min-width: 120px;"
                                >
                                  <span style="font-size: 0.75rem; font-weight: 500;">
                                    Name *
                                  </span>
                                  <cf-input
                                    $value={newPersonName}
                                    placeholder="Full name"
                                    timingStrategy="immediate"
                                    style="width: 100%;"
                                  />
                                </cf-vstack>
                                <cf-vstack
                                  gap="1"
                                  style="flex: 1; min-width: 120px;"
                                >
                                  <span style="font-size: 0.75rem; font-weight: 500;">
                                    Email *
                                  </span>
                                  <cf-input
                                    $value={newPersonEmail}
                                    placeholder="email@company.com"
                                    timingStrategy="immediate"
                                    style="width: 100%;"
                                  />
                                </cf-vstack>
                              </cf-hstack>
                              <cf-hstack gap="2" wrap>
                                <cf-vstack gap="1" style="min-width: 100px;">
                                  <span style="font-size: 0.75rem; font-weight: 500;">
                                    Commute
                                  </span>
                                  <cf-select
                                    $value={newPersonCommuteMode}
                                    items={commuteModeOptions}
                                    style="width: 100%;"
                                  />
                                </cf-vstack>
                                <cf-vstack gap="1" style="min-width: 80px;">
                                  <span style="font-size: 0.75rem; font-weight: 500;">
                                    Priority *
                                  </span>
                                  <cf-input
                                    $value={newPersonPriority}
                                    type="number"
                                    placeholder="1"
                                    timingStrategy="immediate"
                                    style="width: 5rem;"
                                  />
                                </cf-vstack>
                                <cf-vstack gap="1" style="min-width: 100px;">
                                  <span style="font-size: 0.75rem; font-weight: 500;">
                                    Default Spot
                                  </span>
                                  <cf-select
                                    $value={newPersonDefaultSpot}
                                    items={computed(() => [
                                      { label: "None", value: "" },
                                      ...(spots.get() ?? [])
                                        .filter((s) => s.active)
                                        .map((s) => ({
                                          label: `#${s.spotNumber}`,
                                          value: s.spotNumber,
                                        })),
                                    ])}
                                    style="width: 100%;"
                                  />
                                </cf-vstack>
                              </cf-hstack>
                              <cf-vstack gap="1">
                                <span style="font-size: 0.75rem; font-weight: 500;">
                                  Preferences (comma-separated)
                                </span>
                                <cf-input
                                  $value={newPersonPreferences}
                                  placeholder="e.g. 1, 5"
                                  timingStrategy="immediate"
                                  style="width: 100%;"
                                />
                              </cf-vstack>

                              {/* Add form — Vehicles subsection */}
                              <cf-vstack gap="1">
                                <span style="font-size: 0.75rem; font-weight: 500;">
                                  Vehicles
                                </span>
                                {pendingVehicleRows.map((pvRow) => (
                                  <cf-hstack gap="1" align="center">
                                    <span style="font-size: 0.75rem; flex: 1;">
                                      {pvRow.formatted}
                                    </span>
                                    <cf-button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() =>
                                        removePendingVehicle.send({
                                          index: pvRow.idx,
                                        })}
                                    >
                                      ×
                                    </cf-button>
                                  </cf-hstack>
                                ))}
                                <cf-hstack gap="1" wrap align="end">
                                  <cf-vstack gap="0" style="min-width: 80px;">
                                    <span style="font-size: 0.6875rem;">
                                      Plate *
                                    </span>
                                    <cf-input
                                      $value={draftPlateId}
                                      placeholder="e.g. 7ABC123"
                                      timingStrategy="immediate"
                                      style="width: 100%;"
                                    />
                                  </cf-vstack>
                                  <cf-vstack gap="0" style="min-width: 60px;">
                                    <span style="font-size: 0.6875rem;">
                                      State
                                    </span>
                                    <cf-select
                                      $value={draftPlateState}
                                      items={stateSelectItems}
                                      style="width: 100%;"
                                    />
                                  </cf-vstack>
                                  <cf-vstack gap="0" style="min-width: 80px;">
                                    <span style="font-size: 0.6875rem;">
                                      Color
                                    </span>
                                    <cf-select
                                      $value={draftColor}
                                      items={colorSelectItems}
                                      style="width: 100%;"
                                    />
                                  </cf-vstack>
                                  <cf-vstack gap="0" style="min-width: 100px;">
                                    <span style="font-size: 0.6875rem;">
                                      Make
                                    </span>
                                    <cf-select
                                      $value={draftMake}
                                      items={makeSelectItems}
                                      oncf-change={resetModelOnMakeChange({
                                        model: draftModel,
                                      })}
                                      style="width: 100%;"
                                    />
                                  </cf-vstack>
                                  <cf-vstack gap="0" style="min-width: 100px;">
                                    <span style="font-size: 0.6875rem;">
                                      Model
                                    </span>
                                    <cf-select
                                      $value={draftModel}
                                      items={draftModelItems}
                                      disabled={!draftMakeSelected}
                                      style="width: 100%;"
                                    />
                                  </cf-vstack>
                                  <cf-button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => addPendingVehicle.send()}
                                  >
                                    + Add vehicle
                                  </cf-button>
                                </cf-hstack>
                                {computed(() => {
                                  const err = draftVehicleError.get();
                                  if (!err) return null;
                                  return (
                                    <span style="font-size: 0.75rem; color: var(--cf-colors-red-600);">
                                      {err}
                                    </span>
                                  );
                                })}
                              </cf-vstack>

                              {computed(() => {
                                const err = addPersonError.get();
                                if (!err) return null;
                                return (
                                  <span style="font-size: 0.75rem; color: var(--cf-colors-red-600);">
                                    {err}
                                  </span>
                                );
                              })}
                              <cf-hstack gap="2">
                                <cf-button
                                  variant="primary"
                                  size="sm"
                                  onClick={() => submitAddPerson.send()}
                                >
                                  Add Person
                                </cf-button>
                                <cf-button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => toggleAddPersonForm.send()}
                                >
                                  Cancel
                                </cf-button>
                              </cf-hstack>
                            </cf-vstack>
                          </cf-card>
                        )
                        : null}
                    </cf-vstack>

                    {/* Parking Spots */}
                    {adminModeEnabled
                      ? (
                        <cf-vstack gap="2">
                          <cf-hstack justify="between" align="center">
                            <cf-heading level={6}>Parking Spots</cf-heading>
                            <cf-button
                              variant="primary"
                              size="sm"
                              onClick={() => toggleAddSpotForm.send()}
                            >
                              + Add Spot
                            </cf-button>
                          </cf-hstack>

                          {adminSpotsData.map((spot) => {
                            const spotNum2 = spot.spotNumber;
                            const spotLabel2 = spot.label;
                            const spotNotes2 = spot.notes;
                            const spotActive2 = spot.active;
                            // Derived in `adminSpotsData` (see note there) — a
                            // `computed()` nested here reading the perSession
                            // target cells does not re-render.
                            const isEditingSpot = spot.isEditingSpot;
                            const isRemoveSpotConfirm =
                              spot.isRemoveSpotConfirm;

                            return (
                              <cf-card
                                style={spotActive2 ? "" : "opacity: 0.65;"}
                              >
                                {isEditingSpot
                                  ? (
                                    <cf-vstack gap="2">
                                      <cf-hstack gap="2" wrap>
                                        <cf-vstack
                                          gap="1"
                                          style="min-width: 60px;"
                                        >
                                          <span style="font-size: 0.75rem; font-weight: 500;">
                                            Number *
                                          </span>
                                          <cf-input
                                            $value={editSpotNum}
                                            placeholder="e.g. 12"
                                            style="width: 4rem;"
                                          />
                                        </cf-vstack>
                                        <cf-vstack gap="1" style="flex: 1;">
                                          <span style="font-size: 0.75rem; font-weight: 500;">
                                            Label
                                          </span>
                                          <cf-input
                                            $value={editSpotLabel}
                                            placeholder="e.g. Near entrance"
                                            style="width: 100%;"
                                          />
                                        </cf-vstack>
                                      </cf-hstack>
                                      <cf-vstack gap="1">
                                        <span style="font-size: 0.75rem; font-weight: 500;">
                                          Notes
                                        </span>
                                        <cf-input
                                          $value={editSpotNotes}
                                          placeholder="e.g. Tight, no large vehicles"
                                          style="width: 100%;"
                                        />
                                      </cf-vstack>
                                      <cf-hstack gap="2" align="center">
                                        <cf-checkbox $checked={editSpotActive}>
                                          Active
                                        </cf-checkbox>
                                        {spotDeactivateWarning
                                          ? (
                                            <span style="font-size: 0.75rem; color: var(--cf-colors-warning);">
                                              Has upcoming allocations — they
                                              will remain.
                                            </span>
                                          )
                                          : null}
                                      </cf-hstack>
                                      <cf-hstack gap="2">
                                        <cf-button
                                          variant="primary"
                                          size="sm"
                                          onClick={() =>
                                            saveEditSpot.send({
                                              originalNumber: spotNum2,
                                            })}
                                        >
                                          Save
                                        </cf-button>
                                        <cf-button
                                          variant="secondary"
                                          size="sm"
                                          onClick={() => cancelEditSpot.send()}
                                        >
                                          Cancel
                                        </cf-button>
                                      </cf-hstack>
                                    </cf-vstack>
                                  )
                                  : (
                                    <>
                                      <cf-hstack
                                        justify="between"
                                        align="center"
                                        gap="2"
                                        wrap
                                      >
                                        <cf-hstack gap="2" align="center" wrap>
                                          <span
                                            style={`font-weight: 700; font-size: 1rem; color: ${
                                              spotActive2
                                                ? "var(--cf-colors-gray-800)"
                                                : "var(--cf-colors-gray-400)"
                                            };`}
                                          >
                                            #{spotNum2}
                                          </span>
                                          <cf-vstack gap="0">
                                            <span
                                              style={`font-size: 0.875rem; color: ${
                                                spotActive2
                                                  ? "var(--cf-colors-gray-700)"
                                                  : "var(--cf-colors-gray-400)"
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
                                                <span style="font-size: 0.75rem; color: var(--cf-colors-gray-400);">
                                                  {spotNotes2}
                                                </span>
                                              )
                                              : null}
                                          </cf-vstack>
                                          {!spotActive2
                                            ? (
                                              <span style="font-size: 0.6875rem; background-color: #f3f4f6; color: #6b7280; padding: 1px 6px; border-radius: 9999px;">
                                                Inactive
                                              </span>
                                            )
                                            : null}
                                        </cf-hstack>
                                        <cf-hstack gap="1">
                                          <cf-button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() =>
                                              startEditSpot.send({
                                                spotNumber: spotNum2,
                                              })}
                                          >
                                            Edit
                                          </cf-button>
                                          <cf-button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() =>
                                              initiateRemoveSpot.send({
                                                spotNumber: spotNum2,
                                              })}
                                          >
                                            Remove
                                          </cf-button>
                                        </cf-hstack>
                                      </cf-hstack>
                                      {isRemoveSpotConfirm
                                        ? (
                                          <cf-card style="background: #fef2f2; border: 1px solid #fecaca; margin-top: 0.5rem;">
                                            <cf-vstack gap="1">
                                              <span style="font-size: 0.75rem; color: var(--cf-colors-red-700);">
                                                Spot #{spotNum2}{" "}
                                                has upcoming allocations. They
                                                will be preserved. Remove
                                                anyway?
                                              </span>
                                              <cf-hstack gap="2">
                                                <cf-button
                                                  variant="primary"
                                                  size="sm"
                                                  onClick={() =>
                                                    removeSpot.send({
                                                      spotNumber: spotNum2,
                                                    })}
                                                >
                                                  Remove
                                                </cf-button>
                                                <cf-button
                                                  variant="ghost"
                                                  size="sm"
                                                  onClick={() =>
                                                    cancelRemoveSpot.send()}
                                                >
                                                  Cancel
                                                </cf-button>
                                              </cf-hstack>
                                            </cf-vstack>
                                          </cf-card>
                                        )
                                        : null}
                                    </>
                                  )}
                              </cf-card>
                            );
                          })}

                          {addSpotFormOpen.get()
                            ? (
                              <cf-card style="border: 2px dashed var(--cf-colors-gray-200);">
                                <cf-vstack gap="2">
                                  <cf-heading level={6}>Add Spot</cf-heading>
                                  <cf-hstack gap="2" wrap>
                                    <cf-vstack gap="1" style="min-width: 60px;">
                                      <span style="font-size: 0.75rem; font-weight: 500;">
                                        Number *
                                      </span>
                                      <cf-input
                                        $value={newSpotNumber}
                                        placeholder="e.g. 12"
                                        style="width: 4rem;"
                                      />
                                    </cf-vstack>
                                    <cf-vstack gap="1" style="flex: 1;">
                                      <span style="font-size: 0.75rem; font-weight: 500;">
                                        Label
                                      </span>
                                      <cf-input
                                        $value={newSpotLabel}
                                        placeholder="e.g. Near entrance"
                                        style="width: 100%;"
                                      />
                                    </cf-vstack>
                                  </cf-hstack>
                                  <cf-vstack gap="1">
                                    <span style="font-size: 0.75rem; font-weight: 500;">
                                      Notes
                                    </span>
                                    <cf-input
                                      $value={newSpotNotes}
                                      placeholder="e.g. Compact only"
                                      style="width: 100%;"
                                    />
                                  </cf-vstack>
                                  {computed(() => {
                                    const err = addSpotError.get();
                                    if (!err) return null;
                                    return (
                                      <span style="font-size: 0.75rem; color: var(--cf-colors-red-600);">
                                        {err}
                                      </span>
                                    );
                                  })}
                                  <cf-hstack gap="2">
                                    <cf-button
                                      variant="primary"
                                      size="sm"
                                      onClick={() => submitAddSpot.send()}
                                    >
                                      Add Spot
                                    </cf-button>
                                    <cf-button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => toggleAddSpotForm.send()}
                                    >
                                      Cancel
                                    </cf-button>
                                  </cf-hstack>
                                </cf-vstack>
                              </cf-card>
                            )
                            : null}
                        </cf-vstack>
                      )
                      : null}
                  </>
                )
                : null}
            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),

      // Exposed state (Writables auto-unwrap to their T type)
      spots,
      people,
      requests,
      adminRegistry: adminRegistry as PerSpace<ParkingAdminRegistryCell>,
      adminMode: adminModeEnabled,
      currentPersonIsAdmin,
      currentUserCanManageAdmins,
      selectedPersonName: computed(() => selectedPersonName.get() ?? ""),
      requestDate: activeRequestDate,
      requestResult: computed(() => requestResult.get() ?? ""),

      // Exposed actions
      enableAdminManager,
      togglePersonAdmin,
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
