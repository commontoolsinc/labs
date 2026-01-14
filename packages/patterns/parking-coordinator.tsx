/// <cts-enable />
import {
  computed,
  Default,
  handler,
  ifElse,
  lift,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commontools";

// ============ TYPES ============

export type SpotNumber = 1 | 5 | 12;

interface ParkingSpot {
  number: SpotNumber;
  label: Default<string, "">;
  notes: Default<string, "">;
}

export type CommuteMode = "drive" | "bart" | "bike" | "wfh" | "other";

interface Person {
  id: string;
  name: string;
  email: Default<string, "">;
  phone: Default<string, "">;
  usualCommuteMode: Default<CommuteMode, "drive">;
  livesNearby: Default<boolean, false>;
  spotPreferences: Default<SpotNumber[], []>;
  compatibleSpots: Default<SpotNumber[], [1, 5, 12]>;
  defaultSpot: Default<SpotNumber | null, null>;
  priorityRank: number;
  totalBookings: Default<number, 0>;
  lastBookingDate: Default<string | null, null>;
  createdAt: number;
}

export type GuestType = "high-priority" | "best-effort";

interface Guest {
  id: string;
  name: string;
  hostPersonId: string;
  type: GuestType;
  compatibleSpots: Default<SpotNumber[], [1, 5, 12]>;
  notes: Default<string, "">;
  createdAt: number;
}

type RequestStatus = "pending" | "allocated" | "denied" | "cancelled";

interface SpotRequest {
  id: string;
  date: string;
  personId: string | null;
  guestId: string | null;
  requestedAt: number;
  status: RequestStatus;
  allocatedSpot: Default<SpotNumber | null, null>;
  notes: Default<string, "">;
}

interface Allocation {
  id: string;
  date: string;
  spot: SpotNumber;
  personId: string | null;
  guestId: string | null;
  allocatedAt: number;
  wasAutoAllocated: boolean;
}

// ============ ACTION TYPES ============

export interface AddPersonEvent {
  name: string;
  email?: string;
  usualCommuteMode?: CommuteMode;
  livesNearby?: boolean;
  spotPreferences?: SpotNumber[];
  compatibleSpots?: SpotNumber[];
  defaultSpot?: SpotNumber | null;
}

export interface AddGuestEvent {
  name: string;
  hostPersonId: string;
  type: GuestType;
  compatibleSpots?: SpotNumber[];
  notes?: string;
}

export interface RequestSpotEvent {
  personId?: string | null;
  guestId?: string | null;
  date: string;
  notes?: string;
}

export interface AllocateSpotEvent {
  requestId: string;
  spotNumber: SpotNumber;
}

export interface MovePriorityEvent {
  personId: string;
}

export interface RunAutoAllocateEvent {
  date: string;
}

// ============ INPUT/OUTPUT ============

interface Input {
  spots: Default<
    ParkingSpot[],
    [
      { number: 1; label: ""; notes: "" },
      { number: 5; label: ""; notes: "" },
      { number: 12; label: ""; notes: "" },
    ]
  >;
  people: Writable<Default<Person[], []>>;
  guests: Writable<Default<Guest[], []>>;
  requests: Writable<Default<SpotRequest[], []>>;
  allocations: Writable<Default<Allocation[], []>>;
  priorityOrder: Writable<Default<string[], []>>;
}

interface Output {
  spots: ParkingSpot[];
  people: Person[];
  guests: Guest[];
  requests: SpotRequest[];
  allocations: Allocation[];
  priorityOrder: string[];
  todayDate: string;
  // Exposed action streams for testing
  addPerson: Stream<AddPersonEvent>;
  addGuest: Stream<AddGuestEvent>;
  requestSpot: Stream<RequestSpotEvent>;
  runAutoAllocate: Stream<RunAutoAllocateEvent>;
  movePriorityUp: Stream<MovePriorityEvent>;
  movePriorityDown: Stream<MovePriorityEvent>;
}

// ============ DATE HELPERS ============

const getTodayDate = (): string => {
  const now = new Date();
  return now.toISOString().split("T")[0];
};

const getDateDaysAhead = (daysAhead: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  return date.toISOString().split("T")[0];
};

const formatDate = lift((date: string): string => {
  if (!date) return "";
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
});

const isToday = lift((date: string): boolean => {
  return date === getTodayDate();
});

const isWithinBookingWindow = (date: string): boolean => {
  const today = getTodayDate();
  const maxDate = getDateDaysAhead(7);
  return date >= today && date <= maxDate;
};

// ============ ALLOCATION QUERIES ============

const getPendingRequestsForDate = lift(
  (args: { requests: SpotRequest[]; date: string }): SpotRequest[] => {
    return args.requests.filter(
      (r) => r.date === args.date && r.status === "pending",
    );
  },
);

const getAvailableSpotsForDate = lift(
  (args: {
    allocations: Allocation[];
    spots: ParkingSpot[];
    date: string;
  }): SpotNumber[] => {
    const allocated = args.allocations
      .filter((a) => a.date === args.date)
      .map((a) => a.spot);
    return args.spots
      .map((s) => s.number)
      .filter((n) => !allocated.includes(n));
  },
);

const getAllocationForSpotOnDate = lift(
  (args: {
    allocations: Allocation[];
    spot: SpotNumber;
    date: string;
  }): Allocation | null => {
    return (
      args.allocations.find(
        (a) => a.date === args.date && a.spot === args.spot,
      ) || null
    );
  },
);

const isAllocationPresent = lift(
  (allocation: Allocation | null): boolean => allocation !== null,
);

const getAllocatedPersonName = lift(
  (args: {
    allocation: Allocation | null;
    people: Person[];
    guests: Guest[];
  }): string | null => {
    const alloc = args.allocation;
    if (!alloc) return null;
    if (alloc.personId) {
      const person = args.people.find((p) => p.id === alloc.personId);
      return person?.name || "Unknown";
    }
    if (alloc.guestId) {
      const guest = args.guests.find((g) => g.id === alloc.guestId);
      return guest ? `Guest: ${guest.name}` : "Unknown Guest";
    }
    return null;
  },
);

const getRequesterName = lift(
  (args: {
    request: SpotRequest;
    people: Person[];
    guests: Guest[];
  }): string => {
    if (args.request.personId) {
      const person = args.people.find((p) => p.id === args.request.personId);
      return person?.name || "Unknown";
    }
    if (args.request.guestId) {
      const guest = args.guests.find((g) => g.id === args.request.guestId);
      return guest ? `Guest: ${guest.name}` : "Unknown Guest";
    }
    return "Unknown";
  },
);

const getHostName = lift(
  (args: { guest: Guest; people: Person[] }): string => {
    const host = args.people.find((p) => p.id === args.guest.hostPersonId);
    return host?.name || "Unknown";
  },
);

const isArrayEmpty = lift((arr: unknown[]): boolean => arr.length === 0);

const isNumberZero = lift((n: number): boolean => n === 0);

// ============ STATS ============

const getTodayAllocatedCount = lift(
  (args: { allocations: Allocation[] }): number => {
    const today = getTodayDate();
    return args.allocations.filter((a) => a.date === today).length;
  },
);

const getTodayAvailableCount = lift(
  (args: { allocations: Allocation[]; spots: ParkingSpot[] }): number => {
    const today = getTodayDate();
    const allocated = args.allocations.filter((a) => a.date === today).length;
    return args.spots.length - allocated;
  },
);

const getTodayPendingCount = lift(
  (args: { requests: SpotRequest[] }): number => {
    const today = getTodayDate();
    return args.requests.filter(
      (r) => r.date === today && r.status === "pending",
    ).length;
  },
);

const getWeekSummary = lift(
  (args: {
    allocations: Allocation[];
    requests: SpotRequest[];
    spots: ParkingSpot[];
  }): Array<{
    date: string;
    allocated: number;
    available: number;
    pending: number;
  }> => {
    const results = [];
    for (let i = 0; i < 7; i++) {
      const date = getDateDaysAhead(i);
      const dayAllocations = args.allocations.filter((a) => a.date === date);
      const pendingRequests = args.requests.filter(
        (r) => r.date === date && r.status === "pending",
      );
      results.push({
        date,
        allocated: dayAllocations.length,
        available: args.spots.length - dayAllocations.length,
        pending: pendingRequests.length,
      });
    }
    return results;
  },
);

const getSortedPriorityList = lift(
  (args: { people: Person[]; priorityOrder: string[] }): Person[] => {
    return args.priorityOrder
      .map((id) => args.people.find((p) => p.id === id))
      .filter((p): p is Person => p !== undefined);
  },
);

// ============ ID GENERATORS ============

const generateId = (prefix: string): string => {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

// ============ MODULE-SCOPE HANDLERS ============

// Remove a person
const removePersonHandler = handler<
  unknown,
  {
    people: Writable<Person[]>;
    priorityOrder: Writable<string[]>;
    personId: string;
  }
>((_event, { people, priorityOrder, personId }) => {
  const pList = people.get();
  const idx = pList.findIndex((p) => p.id === personId);
  if (idx >= 0) {
    people.set(pList.toSpliced(idx, 1));
  }
  priorityOrder.set(priorityOrder.get().filter((id) => id !== personId));
});

// Remove a guest
const removeGuestHandler = handler<
  unknown,
  { guests: Writable<Guest[]>; guestId: string }
>((_event, { guests, guestId }) => {
  const gList = guests.get();
  const idx = gList.findIndex((g) => g.id === guestId);
  if (idx >= 0) {
    guests.set(gList.toSpliced(idx, 1));
  }
});

// Cancel a request
const cancelRequestHandler = handler<
  unknown,
  {
    requests: Writable<SpotRequest[]>;
    allocations: Writable<Allocation[]>;
    requestId: string;
  }
>((_event, { requests, allocations, requestId }) => {
  const reqList = requests.get();
  const idx = reqList.findIndex((r) => r.id === requestId);
  if (idx < 0) return;

  const request = reqList[idx];

  // Remove allocation if exists
  if (request.status === "allocated" && request.allocatedSpot) {
    const allocList = allocations.get();
    const allocIdx = allocList.findIndex(
      (a) =>
        a.date === request.date &&
        a.spot === request.allocatedSpot &&
        ((request.personId && a.personId === request.personId) ||
          (request.guestId && a.guestId === request.guestId)),
    );
    if (allocIdx >= 0) {
      allocations.set(allocList.toSpliced(allocIdx, 1));
    }
  }

  const updated = [...reqList];
  updated[idx] = { ...updated[idx], status: "cancelled" as RequestStatus };
  requests.set(updated);
});

// Manually allocate a spot to a request
const allocateSpotHandler = handler<
  unknown,
  {
    requests: Writable<SpotRequest[]>;
    allocations: Writable<Allocation[]>;
    people: Writable<Person[]>;
    requestId: string;
    spotNumber: SpotNumber;
  }
>((_event, { requests, allocations, people, requestId, spotNumber }) => {
  const reqList = requests.get();
  const idx = reqList.findIndex((r) => r.id === requestId);
  if (idx < 0) return;

  const request = reqList[idx];
  if (request.status !== "pending") return;

  // Check spot available
  const isAvail = !allocations
    .get()
    .some((a) => a.date === request.date && a.spot === spotNumber);
  if (!isAvail) return;

  // Create allocation
  const allocation: Allocation = {
    id: generateId("alloc"),
    date: request.date,
    spot: spotNumber,
    personId: request.personId,
    guestId: request.guestId,
    allocatedAt: Date.now(),
    wasAutoAllocated: false,
  };
  allocations.push(allocation);

  // Update request
  const updated = [...reqList];
  updated[idx] = {
    ...updated[idx],
    status: "allocated" as RequestStatus,
    allocatedSpot: spotNumber,
  };
  requests.set(updated);

  // Update person's booking count
  if (request.personId) {
    const pList = people.get();
    const pIdx = pList.findIndex((p) => p.id === request.personId);
    if (pIdx >= 0) {
      const updatedPeople = [...pList];
      updatedPeople[pIdx] = {
        ...updatedPeople[pIdx],
        totalBookings: ((updatedPeople[pIdx].totalBookings as number) || 0) + 1,
        lastBookingDate: request.date,
      };
      people.set(updatedPeople);
    }
  }
});

// Move person up in priority (event-based for exposed stream)
const movePriorityUpStreamHandler = handler<
  MovePriorityEvent,
  { priorityOrder: Writable<string[]> }
>((event, { priorityOrder }) => {
  const order = priorityOrder.get();
  const idx = order.indexOf(event.personId);
  if (idx <= 0) return;

  const newOrder = [...order];
  [newOrder[idx - 1], newOrder[idx]] = [newOrder[idx], newOrder[idx - 1]];
  priorityOrder.set(newOrder);
});

// Move person down in priority (event-based for exposed stream)
const movePriorityDownStreamHandler = handler<
  MovePriorityEvent,
  { priorityOrder: Writable<string[]> }
>((event, { priorityOrder }) => {
  const order = priorityOrder.get();
  const idx = order.indexOf(event.personId);
  if (idx < 0 || idx >= order.length - 1) return;

  const newOrder = [...order];
  [newOrder[idx], newOrder[idx + 1]] = [newOrder[idx + 1], newOrder[idx]];
  priorityOrder.set(newOrder);
});

// Move person up in priority (context-based for UI buttons)
const movePriorityUpHandler = handler<
  unknown,
  { priorityOrder: Writable<string[]>; personId: string }
>((_event, { priorityOrder, personId }) => {
  const order = priorityOrder.get();
  const idx = order.indexOf(personId);
  if (idx <= 0) return;

  const newOrder = [...order];
  [newOrder[idx - 1], newOrder[idx]] = [newOrder[idx], newOrder[idx - 1]];
  priorityOrder.set(newOrder);
});

// Move person down in priority (context-based for UI buttons)
const movePriorityDownHandler = handler<
  unknown,
  { priorityOrder: Writable<string[]>; personId: string }
>((_event, { priorityOrder, personId }) => {
  const order = priorityOrder.get();
  const idx = order.indexOf(personId);
  if (idx < 0 || idx >= order.length - 1) return;

  const newOrder = [...order];
  [newOrder[idx], newOrder[idx + 1]] = [newOrder[idx + 1], newOrder[idx]];
  priorityOrder.set(newOrder);
});

// Add a person
const addPersonHandler = handler<
  AddPersonEvent,
  { people: Writable<Person[]>; priorityOrder: Writable<string[]> }
>((event, { people, priorityOrder }) => {
  const id = generateId("person");
  const currentPeople = people.get();

  people.push({
    id,
    name: event.name,
    email: event.email || "",
    phone: "",
    usualCommuteMode: event.usualCommuteMode || "drive",
    livesNearby: event.livesNearby || false,
    spotPreferences: event.spotPreferences || [],
    compatibleSpots: event.compatibleSpots || [1, 5, 12],
    defaultSpot: event.defaultSpot || null,
    priorityRank: currentPeople.length + 1,
    totalBookings: 0,
    lastBookingDate: null,
    createdAt: Date.now(),
  });
  priorityOrder.set([...priorityOrder.get(), id]);
});

// Add a guest
const addGuestHandler = handler<
  AddGuestEvent,
  { guests: Writable<Guest[]> }
>((event, { guests }) => {
  guests.push({
    id: generateId("guest"),
    name: event.name,
    hostPersonId: event.hostPersonId,
    type: event.type,
    compatibleSpots: event.compatibleSpots || [1, 5, 12],
    notes: event.notes || "",
    createdAt: Date.now(),
  });
});

// Request a spot
const requestSpotHandler = handler<
  RequestSpotEvent,
  { requests: Writable<SpotRequest[]> }
>((event, { requests }) => {
  // Check for existing request
  const existingRequest = requests.get().find(
    (r) =>
      r.date === event.date &&
      ((event.personId && r.personId === event.personId) ||
        (event.guestId && r.guestId === event.guestId)) &&
      r.status !== "cancelled",
  );
  if (existingRequest) return;

  requests.push({
    id: generateId("req"),
    date: event.date,
    personId: event.personId || null,
    guestId: event.guestId || null,
    requestedAt: Date.now(),
    status: "pending",
    allocatedSpot: null,
    notes: event.notes || "",
  });
});

// Auto-allocate spots for a date
const runAutoAllocateHandler = handler<
  RunAutoAllocateEvent,
  {
    requests: Writable<SpotRequest[]>;
    allocations: Writable<Allocation[]>;
    people: Writable<Person[]>;
    guests: Writable<Guest[]>;
    priorityOrder: Writable<string[]>;
  }
>((event, { requests, allocations, people, guests, priorityOrder }) => {
  const date = event.date;
  const reqList = requests.get();
  const allocList = allocations.get();
  const peopleList = people.get();
  const guestsList = guests.get();
  const prioOrder = priorityOrder.get();

  const pendingReqs = reqList.filter(
    (r) => r.date === date && r.status === "pending",
  );
  if (pendingReqs.length === 0) return;

  const usedSpots = new Set<SpotNumber>(
    allocList.filter((a) => a.date === date).map((a) => a.spot),
  );
  const allSpotNumbers: SpotNumber[] = [1, 5, 12];

  const getAvailableCompatible = (compatible: SpotNumber[]): SpotNumber[] =>
    compatible.filter((s) => !usedSpots.has(s));

  const newAllocs: Allocation[] = [];
  const updatedReqs = [...reqList];

  // Phase 1: High-priority guests
  for (
    const req of pendingReqs.filter((r) => {
      if (!r.guestId) return false;
      const g = guestsList.find((gg) => gg.id === r.guestId);
      return g?.type === "high-priority";
    })
  ) {
    const guest = guestsList.find((g) => g.id === req.guestId);
    if (!guest) continue;
    const compat = (guest.compatibleSpots as SpotNumber[]) || allSpotNumbers;
    const avail = getAvailableCompatible(compat);
    const reqIdx = updatedReqs.findIndex((r) => r.id === req.id);
    if (avail.length > 0 && reqIdx >= 0) {
      const spot = avail[0];
      usedSpots.add(spot);
      updatedReqs[reqIdx] = {
        ...updatedReqs[reqIdx],
        status: "allocated" as RequestStatus,
        allocatedSpot: spot,
      };
      newAllocs.push({
        id: generateId("alloc"),
        date,
        spot,
        personId: req.personId,
        guestId: req.guestId,
        allocatedAt: Date.now(),
        wasAutoAllocated: true,
      });
    } else if (reqIdx >= 0) {
      updatedReqs[reqIdx] = {
        ...updatedReqs[reqIdx],
        status: "denied" as RequestStatus,
      };
    }
  }

  // Phase 2: People in priority order
  const personReqs = pendingReqs
    .filter(
      (r) =>
        r.personId &&
        updatedReqs.find((ur) => ur.id === r.id)?.status === "pending",
    )
    .sort((a, b) => {
      const aIdx = prioOrder.indexOf(a.personId!);
      const bIdx = prioOrder.indexOf(b.personId!);
      return aIdx - bIdx;
    });

  for (const req of personReqs) {
    const person = peopleList.find((p) => p.id === req.personId);
    if (!person) continue;
    const compat = (person.compatibleSpots as SpotNumber[]) || allSpotNumbers;
    const avail = getAvailableCompatible(compat);
    const reqIdx = updatedReqs.findIndex((r) => r.id === req.id);

    let spot: SpotNumber | null = null;
    if (avail.length > 0) {
      // Check default spot
      if (
        person.defaultSpot &&
        avail.includes(person.defaultSpot as SpotNumber)
      ) {
        spot = person.defaultSpot as SpotNumber;
      } else {
        // Check preferences
        const prefs = (person.spotPreferences as SpotNumber[]) || [];
        for (const pref of prefs) {
          if (avail.includes(pref)) {
            spot = pref;
            break;
          }
        }
        if (!spot) spot = avail[0];
      }
    }

    if (spot && reqIdx >= 0) {
      usedSpots.add(spot);
      updatedReqs[reqIdx] = {
        ...updatedReqs[reqIdx],
        status: "allocated" as RequestStatus,
        allocatedSpot: spot,
      };
      newAllocs.push({
        id: generateId("alloc"),
        date,
        spot,
        personId: req.personId,
        guestId: req.guestId,
        allocatedAt: Date.now(),
        wasAutoAllocated: true,
      });
    } else if (reqIdx >= 0) {
      updatedReqs[reqIdx] = {
        ...updatedReqs[reqIdx],
        status: "denied" as RequestStatus,
      };
    }
  }

  // Phase 3: Best-effort guests
  for (
    const req of pendingReqs.filter((r) => {
      if (!r.guestId) return false;
      const curr = updatedReqs.find((ur) => ur.id === r.id);
      if (curr?.status !== "pending") return false;
      const g = guestsList.find((gg) => gg.id === r.guestId);
      return g?.type === "best-effort";
    })
  ) {
    const guest = guestsList.find((g) => g.id === req.guestId);
    if (!guest) continue;
    const compat = (guest.compatibleSpots as SpotNumber[]) || allSpotNumbers;
    const avail = getAvailableCompatible(compat);
    const reqIdx = updatedReqs.findIndex((r) => r.id === req.id);
    if (avail.length > 0 && reqIdx >= 0) {
      const spot = avail[0];
      usedSpots.add(spot);
      updatedReqs[reqIdx] = {
        ...updatedReqs[reqIdx],
        status: "allocated" as RequestStatus,
        allocatedSpot: spot,
      };
      newAllocs.push({
        id: generateId("alloc"),
        date,
        spot,
        personId: req.personId,
        guestId: req.guestId,
        allocatedAt: Date.now(),
        wasAutoAllocated: true,
      });
    } else if (reqIdx >= 0) {
      updatedReqs[reqIdx] = {
        ...updatedReqs[reqIdx],
        status: "denied" as RequestStatus,
      };
    }
  }

  // Apply updates
  requests.set(updatedReqs);
  for (const alloc of newAllocs) {
    allocations.push(alloc);
  }
});

// ============ MAIN PATTERN ============

export default pattern<Input, Output>(
  ({ spots, people, guests, requests, allocations, priorityOrder }) => {
    const todayDate = getTodayDate();

    // Tab state
    const activeTab = Writable.of<string>("today");

    // Form states
    const newPersonName = Writable.of("");
    const newPersonEmail = Writable.of("");
    const newGuestName = Writable.of("");
    const newGuestHost = Writable.of("");
    const newGuestType = Writable.of<GuestType>("best-effort");
    const selectedRequestDate = Writable.of(todayDate);
    const selectedPersonForRequest = Writable.of("");

    // Computed values
    const todayAllocated = getTodayAllocatedCount({ allocations });
    const todayAvailable = getTodayAvailableCount({ allocations, spots });
    const todayPendingCount = getTodayPendingCount({ requests });
    const weekSummary = getWeekSummary({ allocations, requests, spots });
    const sortedPriority = getSortedPriorityList({ people, priorityOrder });
    const todayPending = getPendingRequestsForDate({
      requests,
      date: todayDate,
    });
    const todayAvailableSpots = getAvailableSpotsForDate({
      allocations,
      spots,
      date: todayDate,
    });

    const personCount = computed(() => people.get().length);
    const guestCount = computed(() => guests.get().length);

    // Person select items for dropdowns
    const personSelectItems = computed(() =>
      people.get().map((p) => ({ label: p.name, value: p.id }))
    );

    // ============ UI ============

    return {
      [NAME]: "Parking Coordinator",
      [UI]: (
        <ct-screen>
          {/* Header with stats */}
          <ct-vstack slot="header" gap="2">
            <ct-hstack justify="between" align="center">
              <ct-heading level={4}>Parking Coordinator</ct-heading>
              <span style="font-size: 0.875rem; color: var(--ct-color-gray-500);">
                {todayDate}
              </span>
            </ct-hstack>

            {/* Quick stats */}
            <ct-hstack gap="2">
              <ct-card style="flex: 1; text-align: center; padding: 0.5rem;">
                <div style="font-size: 1.25rem; font-weight: bold; color: var(--ct-color-green-600);">
                  {todayAvailable}
                </div>
                <div style="font-size: 0.625rem; color: var(--ct-color-gray-500);">
                  Available
                </div>
              </ct-card>
              <ct-card style="flex: 1; text-align: center; padding: 0.5rem;">
                <div style="font-size: 1.25rem; font-weight: bold; color: var(--ct-color-blue-600);">
                  {todayAllocated}
                </div>
                <div style="font-size: 0.625rem; color: var(--ct-color-gray-500);">
                  Allocated
                </div>
              </ct-card>
              <ct-card style="flex: 1; text-align: center; padding: 0.5rem;">
                <div style="font-size: 1.25rem; font-weight: bold; color: var(--ct-color-orange-600);">
                  {todayPendingCount}
                </div>
                <div style="font-size: 0.625rem; color: var(--ct-color-gray-500);">
                  Pending
                </div>
              </ct-card>
            </ct-hstack>

            {/* Tabs */}
            <ct-tabs $value={activeTab}>
              <ct-tab-list>
                <ct-tab value="today">Today</ct-tab>
                <ct-tab value="week">Week</ct-tab>
                <ct-tab value="people">People</ct-tab>
                <ct-tab value="admin">Admin</ct-tab>
              </ct-tab-list>
            </ct-tabs>
          </ct-vstack>

          <ct-vscroll flex showScrollbar fadeEdges>
            {/* TODAY TAB */}
            {ifElse(
              computed(() => activeTab.get() === "today"),
              <ct-vstack gap="3" style="padding: 1rem;">
                <ct-heading level={5}>Today's Spots</ct-heading>
                {spots.map((spot) => {
                  const allocation = getAllocationForSpotOnDate({
                    allocations,
                    spot: spot.number as SpotNumber,
                    date: todayDate,
                  });
                  const isAllocated = isAllocationPresent(allocation);
                  const allocatedToName = getAllocatedPersonName({
                    allocation,
                    people,
                    guests,
                  });

                  return (
                    <ct-card
                      style={{
                        borderLeft: ifElse(
                          isAllocated,
                          "4px solid var(--ct-color-blue-500)",
                          "4px solid var(--ct-color-green-500)",
                        ),
                      }}
                    >
                      <ct-hstack gap="2" align="center">
                        <div style="font-size: 1.5rem; font-weight: bold; min-width: 50px;">
                          #{spot.number}
                        </div>
                        <ct-vstack gap="0" style="flex: 1;">
                          {ifElse(
                            isAllocated,
                            <span style="font-weight: 500;">
                              {allocatedToName}
                            </span>,
                            <span style="color: var(--ct-color-green-600); font-weight: 500;">
                              Available
                            </span>,
                          )}
                          {spot.label && (
                            <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                              {spot.label}
                            </span>
                          )}
                        </ct-vstack>
                      </ct-hstack>
                    </ct-card>
                  );
                })}

                <ct-heading level={5}>Pending Requests</ct-heading>
                {todayPending.map((req) => {
                  const requesterName = getRequesterName({
                    request: req,
                    people,
                    guests,
                  });

                  return (
                    <ct-card>
                      <ct-hstack gap="2" align="center">
                        <span style="flex: 1; font-weight: 500;">
                          {requesterName}
                        </span>
                        {todayAvailableSpots.map((spotNum) => (
                          <ct-button
                            variant="secondary"
                            size="sm"
                            onClick={allocateSpotHandler({
                              requests,
                              allocations,
                              people,
                              requestId: req.id,
                              spotNumber: spotNum,
                            })}
                          >
                            #{spotNum}
                          </ct-button>
                        ))}
                        <ct-button
                          variant="ghost"
                          size="sm"
                          onClick={cancelRequestHandler({
                            requests,
                            allocations,
                            requestId: req.id,
                          })}
                        >
                          Cancel
                        </ct-button>
                      </ct-hstack>
                    </ct-card>
                  );
                })}

                {ifElse(
                  isArrayEmpty(todayPending),
                  <div style="text-align: center; color: var(--ct-color-gray-500); padding: 1rem;">
                    No pending requests for today
                  </div>,
                  null,
                )}
              </ct-vstack>,
              null,
            )}

            {/* WEEK TAB */}
            {ifElse(
              computed(() => activeTab.get() === "week"),
              <ct-vstack gap="2" style="padding: 1rem;">
                {weekSummary.map((day) => {
                  const dayIsToday = isToday(day.date);
                  return (
                    <ct-card
                      style={{
                        borderLeft: ifElse(
                          dayIsToday,
                          "4px solid var(--ct-color-blue-500)",
                          "4px solid transparent",
                        ),
                      }}
                    >
                      <ct-hstack gap="2" align="center">
                        <ct-vstack gap="0" style="flex: 1;">
                          <ct-hstack gap="2" align="center">
                            <span style="font-weight: 600;">
                              {formatDate(day.date)}
                            </span>
                            {ifElse(
                              dayIsToday,
                              <span style="font-size: 0.625rem; background: var(--ct-color-blue-100); color: var(--ct-color-blue-700); padding: 0.125rem 0.5rem; border-radius: 999px;">
                                Today
                              </span>,
                              null,
                            )}
                          </ct-hstack>
                        </ct-vstack>
                        <ct-hstack gap="3">
                          <span style="font-size: 0.75rem; color: var(--ct-color-green-600);">
                            {day.available} avail
                          </span>
                          <span style="font-size: 0.75rem; color: var(--ct-color-blue-600);">
                            {day.allocated} alloc
                          </span>
                          {ifElse(
                            computed(() => day.pending > 0),
                            <span style="font-size: 0.75rem; color: var(--ct-color-orange-600);">
                              {day.pending} pending
                            </span>,
                            null,
                          )}
                        </ct-hstack>
                      </ct-hstack>
                    </ct-card>
                  );
                })}
              </ct-vstack>,
              null,
            )}

            {/* PEOPLE TAB */}
            {ifElse(
              computed(() => activeTab.get() === "people"),
              <ct-vstack gap="2" style="padding: 1rem;">
                <ct-hstack justify="between" align="center">
                  <ct-heading level={5}>
                    Priority List ({personCount})
                  </ct-heading>
                </ct-hstack>
                <p style="font-size: 0.75rem; color: var(--ct-color-gray-500); margin: 0;">
                  Higher position = gets spot first. Use arrows to reorder.
                </p>

                {sortedPriority.map((person, idx) => (
                  <ct-card>
                    <ct-hstack gap="2" align="center">
                      <span style="font-size: 1.25rem; font-weight: bold; min-width: 30px; color: var(--ct-color-gray-400);">
                        {computed(() => idx + 1)}
                      </span>
                      <ct-vstack gap="0" style="flex: 1;">
                        <span style="font-weight: 500;">{person.name}</span>
                        <ct-hstack gap="2">
                          <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                            {person.usualCommuteMode || "drive"}
                          </span>
                          {ifElse(
                            computed(() => person.livesNearby === true),
                            <span style="font-size: 0.625rem; background: var(--ct-color-cyan-100); color: var(--ct-color-cyan-700); padding: 0.125rem 0.5rem; border-radius: 999px;">
                              Nearby
                            </span>,
                            null,
                          )}
                          {ifElse(
                            computed(() => person.defaultSpot !== null),
                            <span style="font-size: 0.625rem; background: var(--ct-color-gray-100); color: var(--ct-color-gray-700); padding: 0.125rem 0.5rem; border-radius: 999px;">
                              Default: #{person.defaultSpot}
                            </span>,
                            null,
                          )}
                        </ct-hstack>
                      </ct-vstack>
                      <ct-button
                        variant="ghost"
                        size="sm"
                        onClick={movePriorityUpHandler({
                          priorityOrder,
                          personId: person.id,
                        })}
                      >
                        ↑
                      </ct-button>
                      <ct-button
                        variant="ghost"
                        size="sm"
                        onClick={movePriorityDownHandler({
                          priorityOrder,
                          personId: person.id,
                        })}
                      >
                        ↓
                      </ct-button>
                      <ct-button
                        variant="ghost"
                        size="sm"
                        onClick={removePersonHandler({
                          people,
                          priorityOrder,
                          personId: person.id,
                        })}
                      >
                        ×
                      </ct-button>
                    </ct-hstack>
                  </ct-card>
                ))}

                {ifElse(
                  isNumberZero(personCount),
                  <div style="text-align: center; color: var(--ct-color-gray-500); padding: 2rem;">
                    No people added yet. Add them in the Admin tab.
                  </div>,
                  null,
                )}
              </ct-vstack>,
              null,
            )}

            {/* ADMIN TAB */}
            {ifElse(
              computed(() => activeTab.get() === "admin"),
              <ct-vstack gap="3" style="padding: 1rem;">
                {/* Add Person */}
                <ct-card>
                  <ct-vstack gap="2">
                    <ct-heading level={6}>Add Person</ct-heading>
                    <ct-hstack gap="2">
                      <ct-input
                        $value={newPersonName}
                        placeholder="Name..."
                        style="flex: 1;"
                      />
                      <ct-input
                        $value={newPersonEmail}
                        placeholder="Email..."
                        style="flex: 1;"
                      />
                      <ct-button
                        variant="primary"
                        onClick={() => {
                          const name = newPersonName.get().trim();
                          const email = newPersonEmail.get().trim();
                          if (!name) return;

                          const id = generateId("person");
                          const currentPeople = people.get();

                          people.push({
                            id,
                            name,
                            email,
                            phone: "",
                            usualCommuteMode: "drive",
                            livesNearby: false,
                            spotPreferences: [],
                            compatibleSpots: [1, 5, 12],
                            defaultSpot: null,
                            priorityRank: currentPeople.length + 1,
                            totalBookings: 0,
                            lastBookingDate: null,
                            createdAt: Date.now(),
                          });
                          priorityOrder.set([...priorityOrder.get(), id]);

                          newPersonName.set("");
                          newPersonEmail.set("");
                        }}
                      >
                        Add
                      </ct-button>
                    </ct-hstack>
                  </ct-vstack>
                </ct-card>

                {/* Add Guest */}
                <ct-card>
                  <ct-vstack gap="2">
                    <ct-heading level={6}>Add Guest</ct-heading>
                    <ct-hstack gap="2">
                      <ct-input
                        $value={newGuestName}
                        placeholder="Guest name..."
                        style="flex: 1;"
                      />
                      <ct-select
                        $value={newGuestHost}
                        items={personSelectItems}
                        placeholder="Host..."
                        style="flex: 1;"
                      />
                      <ct-select
                        $value={newGuestType}
                        items={[
                          { label: "High Priority", value: "high-priority" },
                          { label: "Best Effort", value: "best-effort" },
                        ]}
                        style="width: 140px;"
                      />
                      <ct-button
                        variant="primary"
                        onClick={() => {
                          const name = newGuestName.get().trim();
                          const hostPersonId = newGuestHost.get();
                          const guestType = newGuestType.get();
                          if (!name || !hostPersonId) return;

                          guests.push({
                            id: generateId("guest"),
                            name,
                            hostPersonId,
                            type: guestType,
                            compatibleSpots: [1, 5, 12],
                            notes: "",
                            createdAt: Date.now(),
                          });

                          newGuestName.set("");
                          newGuestHost.set("");
                          newGuestType.set("best-effort");
                        }}
                      >
                        Add
                      </ct-button>
                    </ct-hstack>
                  </ct-vstack>
                </ct-card>

                {/* Request Spot */}
                <ct-card>
                  <ct-vstack gap="2">
                    <ct-heading level={6}>Request Spot</ct-heading>
                    <ct-hstack gap="2">
                      <ct-select
                        $value={selectedPersonForRequest}
                        items={personSelectItems}
                        placeholder="Person..."
                        style="flex: 1;"
                      />
                      <ct-input
                        $value={selectedRequestDate}
                        type="date"
                        style="width: 150px;"
                      />
                      <ct-button
                        variant="secondary"
                        onClick={() => {
                          const personId = selectedPersonForRequest.get();
                          const date = selectedRequestDate.get();
                          if (!personId || !isWithinBookingWindow(date)) return;

                          // Check for existing request
                          const existingRequest = requests.get().find(
                            (r) =>
                              r.date === date &&
                              r.personId === personId &&
                              r.status !== "cancelled",
                          );
                          if (existingRequest) return;

                          requests.push({
                            id: generateId("req"),
                            date,
                            personId,
                            guestId: null,
                            requestedAt: Date.now(),
                            status: "pending",
                            allocatedSpot: null,
                            notes: "",
                          });
                        }}
                      >
                        Request
                      </ct-button>
                    </ct-hstack>
                  </ct-vstack>
                </ct-card>

                {/* Auto-Allocate */}
                <ct-card>
                  <ct-vstack gap="2">
                    <ct-heading level={6}>Auto-Allocate</ct-heading>
                    <ct-hstack gap="2">
                      <ct-input
                        $value={selectedRequestDate}
                        type="date"
                        style="width: 150px;"
                      />
                      <ct-button
                        variant="primary"
                        onClick={() => {
                          const date = selectedRequestDate.get();
                          const reqList = requests.get();
                          const allocList = allocations.get();
                          const peopleList = people.get();
                          const guestsList = guests.get();
                          const prioOrder = priorityOrder.get();

                          const pendingReqs = reqList.filter(
                            (r) => r.date === date && r.status === "pending",
                          );
                          if (pendingReqs.length === 0) return;

                          const usedSpots = new Set<SpotNumber>(
                            allocList
                              .filter((a) => a.date === date)
                              .map((a) => a.spot),
                          );
                          const allSpotNumbers: SpotNumber[] = [1, 5, 12];

                          const getAvailableCompatible = (
                            compatible: SpotNumber[],
                          ): SpotNumber[] =>
                            compatible.filter((s) => !usedSpots.has(s));

                          const newAllocs: Allocation[] = [];
                          const updatedReqs = [...reqList];

                          // Phase 1: High-priority guests
                          for (
                            const req of pendingReqs.filter((r) => {
                              if (!r.guestId) return false;
                              const g = guestsList.find(
                                (gg) => gg.id === r.guestId,
                              );
                              return g?.type === "high-priority";
                            })
                          ) {
                            const guest = guestsList.find(
                              (g) => g.id === req.guestId,
                            );
                            if (!guest) continue;
                            const compat =
                              (guest.compatibleSpots as SpotNumber[]) ||
                              allSpotNumbers;
                            const avail = getAvailableCompatible(compat);
                            const reqIdx = updatedReqs.findIndex(
                              (r) => r.id === req.id,
                            );
                            if (avail.length > 0 && reqIdx >= 0) {
                              const spot = avail[0];
                              usedSpots.add(spot);
                              updatedReqs[reqIdx] = {
                                ...updatedReqs[reqIdx],
                                status: "allocated" as RequestStatus,
                                allocatedSpot: spot,
                              };
                              newAllocs.push({
                                id: generateId("alloc"),
                                date,
                                spot,
                                personId: req.personId,
                                guestId: req.guestId,
                                allocatedAt: Date.now(),
                                wasAutoAllocated: true,
                              });
                            } else if (reqIdx >= 0) {
                              updatedReqs[reqIdx] = {
                                ...updatedReqs[reqIdx],
                                status: "denied" as RequestStatus,
                              };
                            }
                          }

                          // Phase 2: People in priority order
                          const personReqs = pendingReqs
                            .filter(
                              (r) =>
                                r.personId &&
                                updatedReqs.find((ur) => ur.id === r.id)
                                    ?.status === "pending",
                            )
                            .sort((a, b) => {
                              const aIdx = prioOrder.indexOf(a.personId!);
                              const bIdx = prioOrder.indexOf(b.personId!);
                              return aIdx - bIdx;
                            });

                          for (const req of personReqs) {
                            const person = peopleList.find(
                              (p) => p.id === req.personId,
                            );
                            if (!person) continue;
                            const compat =
                              (person.compatibleSpots as SpotNumber[]) ||
                              allSpotNumbers;
                            const avail = getAvailableCompatible(compat);
                            const reqIdx = updatedReqs.findIndex(
                              (r) => r.id === req.id,
                            );

                            let spot: SpotNumber | null = null;
                            if (avail.length > 0) {
                              // Check default spot
                              if (
                                person.defaultSpot &&
                                avail.includes(person.defaultSpot as SpotNumber)
                              ) {
                                spot = person.defaultSpot as SpotNumber;
                              } else {
                                // Check preferences
                                const prefs =
                                  (person.spotPreferences as SpotNumber[]) ||
                                  [];
                                for (const pref of prefs) {
                                  if (avail.includes(pref)) {
                                    spot = pref;
                                    break;
                                  }
                                }
                                if (!spot) spot = avail[0];
                              }
                            }

                            if (spot && reqIdx >= 0) {
                              usedSpots.add(spot);
                              updatedReqs[reqIdx] = {
                                ...updatedReqs[reqIdx],
                                status: "allocated" as RequestStatus,
                                allocatedSpot: spot,
                              };
                              newAllocs.push({
                                id: generateId("alloc"),
                                date,
                                spot,
                                personId: req.personId,
                                guestId: req.guestId,
                                allocatedAt: Date.now(),
                                wasAutoAllocated: true,
                              });
                            } else if (reqIdx >= 0) {
                              updatedReqs[reqIdx] = {
                                ...updatedReqs[reqIdx],
                                status: "denied" as RequestStatus,
                              };
                            }
                          }

                          // Phase 3: Best-effort guests
                          for (
                            const req of pendingReqs.filter((r) => {
                              if (!r.guestId) return false;
                              const curr = updatedReqs.find(
                                (ur) => ur.id === r.id,
                              );
                              if (curr?.status !== "pending") return false;
                              const g = guestsList.find(
                                (gg) => gg.id === r.guestId,
                              );
                              return g?.type === "best-effort";
                            })
                          ) {
                            const guest = guestsList.find(
                              (g) => g.id === req.guestId,
                            );
                            if (!guest) continue;
                            const compat =
                              (guest.compatibleSpots as SpotNumber[]) ||
                              allSpotNumbers;
                            const avail = getAvailableCompatible(compat);
                            const reqIdx = updatedReqs.findIndex(
                              (r) => r.id === req.id,
                            );
                            if (avail.length > 0 && reqIdx >= 0) {
                              const spot = avail[0];
                              usedSpots.add(spot);
                              updatedReqs[reqIdx] = {
                                ...updatedReqs[reqIdx],
                                status: "allocated" as RequestStatus,
                                allocatedSpot: spot,
                              };
                              newAllocs.push({
                                id: generateId("alloc"),
                                date,
                                spot,
                                personId: req.personId,
                                guestId: req.guestId,
                                allocatedAt: Date.now(),
                                wasAutoAllocated: true,
                              });
                            } else if (reqIdx >= 0) {
                              updatedReqs[reqIdx] = {
                                ...updatedReqs[reqIdx],
                                status: "denied" as RequestStatus,
                              };
                            }
                          }

                          // Apply updates
                          requests.set(updatedReqs);
                          for (const alloc of newAllocs) {
                            allocations.push(alloc);
                          }
                        }}
                      >
                        Run Auto-Allocate
                      </ct-button>
                    </ct-hstack>
                    <p style="font-size: 0.75rem; color: var(--ct-color-gray-500); margin: 0;">
                      Assigns spots based on priority, preferences, and
                      compatibility.
                    </p>
                  </ct-vstack>
                </ct-card>

                {/* Guest List */}
                <ct-card>
                  <ct-vstack gap="2">
                    <ct-heading level={6}>Guests ({guestCount})</ct-heading>
                    {guests.map((guest) => {
                      const hostName = getHostName({ guest, people });
                      return (
                        <ct-hstack gap="2" align="center">
                          <span style="flex: 1;">{guest.name}</span>
                          <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                            Host: {hostName}
                          </span>
                          <span
                            style={{
                              fontSize: "0.625rem",
                              padding: "0.125rem 0.5rem",
                              borderRadius: "999px",
                              background: ifElse(
                                computed(() => guest.type === "high-priority"),
                                "var(--ct-color-red-100)",
                                "var(--ct-color-gray-100)",
                              ),
                              color: ifElse(
                                computed(() => guest.type === "high-priority"),
                                "var(--ct-color-red-700)",
                                "var(--ct-color-gray-700)",
                              ),
                            }}
                          >
                            {guest.type}
                          </span>
                          <ct-button
                            variant="ghost"
                            size="sm"
                            onClick={removeGuestHandler({
                              guests,
                              guestId: guest.id,
                            })}
                          >
                            ×
                          </ct-button>
                        </ct-hstack>
                      );
                    })}
                    {ifElse(
                      isNumberZero(guestCount),
                      <div style="text-align: center; color: var(--ct-color-gray-500); padding: 0.5rem;">
                        No guests
                      </div>,
                      null,
                    )}
                  </ct-vstack>
                </ct-card>
              </ct-vstack>,
              null,
            )}
          </ct-vscroll>
        </ct-screen>
      ),
      spots,
      people,
      guests,
      requests,
      allocations,
      priorityOrder,
      todayDate,
      // Exposed action streams for testing
      addPerson: addPersonHandler({ people, priorityOrder }),
      addGuest: addGuestHandler({ guests }),
      requestSpot: requestSpotHandler({ requests }),
      runAutoAllocate: runAutoAllocateHandler({
        requests,
        allocations,
        people,
        guests,
        priorityOrder,
      }),
      movePriorityUp: movePriorityUpStreamHandler({ priorityOrder }),
      movePriorityDown: movePriorityDownStreamHandler({ priorityOrder }),
    };
  },
);
