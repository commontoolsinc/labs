/// <cts-enable />
import {
  computed,
  Default,
  equals,
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

// NOTE: All fields wrapped in Default<> to avoid runtime persistence bug
// where mixed Default/non-Default fields cause 2nd+ array items to lose values.
export interface Person {
  name: Default<string, "">;
  email: Default<string, "">;
  phone: Default<string, "">;
  usualCommuteMode: Default<CommuteMode, "drive">;
  livesNearby: Default<boolean, false>;
  spotPreferences: Default<SpotNumber[], []>;
  compatibleSpots: Default<SpotNumber[], [1, 5, 12]>;
  defaultSpot: Default<SpotNumber | null, null>;
  priorityRank: Default<number, 0>;
  totalBookings: Default<number, 0>;
  lastBookingDate: Default<string | null, null>;
  createdAt: Default<number, 0>;
}

export type GuestType = "high-priority" | "best-effort";

// NOTE: All fields wrapped in Default<> to avoid persistence bug
export interface Guest {
  name: Default<string, "">;
  hostPerson: Person;
  type: Default<GuestType, "best-effort">;
  compatibleSpots: Default<SpotNumber[], [1, 5, 12]>;
  notes: Default<string, "">;
  createdAt: Default<number, 0>;
}

type RequestStatus = "pending" | "allocated" | "denied" | "cancelled";

// NOTE: All fields wrapped in Default<> to avoid persistence bug
export interface SpotRequest {
  date: string;
  person: Person | null;
  guest: Guest | null;
  requestedAt: Default<number, 0>;
  status: Default<RequestStatus, "pending">;
  allocatedSpot: Default<SpotNumber | null, null>;
  notes: Default<string, "">;
}

// NOTE: All fields wrapped in Default<> to avoid persistence bug
export interface Allocation {
  date: string;
  spot: SpotNumber;
  person: Person | null;
  guest: Guest | null;
  allocatedAt: Default<number, 0>;
  wasAutoAllocated: Default<boolean, false>;
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
  hostPerson: Person;
  type: GuestType;
  compatibleSpots?: SpotNumber[];
  notes?: string;
}

export interface RequestSpotEvent {
  person?: Person | null;
  guest?: Guest | null;
  date: string;
  notes?: string;
}

export interface AllocateSpotEvent {
  request: SpotRequest;
  spotNumber: SpotNumber;
}

export interface MovePriorityUpEvent {
  person: Person;
}

export interface MovePriorityDownEvent {
  person: Person;
}

export interface CancelRequestEvent {
  request: SpotRequest;
}

export interface RemovePersonEvent {
  person: Person;
}

export interface RemoveGuestEvent {
  guest: Guest;
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
}

interface Output {
  spots: ParkingSpot[];
  people: Person[];
  guests: Guest[];
  requests: SpotRequest[];
  allocations: Allocation[];
  todayDate: string;
  // Exposed action streams for testing
  addPerson: Stream<AddPersonEvent>;
  addGuest: Stream<AddGuestEvent>;
  requestSpot: Stream<RequestSpotEvent>;
  runAutoAllocate: Stream<RunAutoAllocateEvent>;
  movePriorityUp: Stream<MovePriorityUpEvent>;
  movePriorityDown: Stream<MovePriorityDownEvent>;
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
    // Now using direct object references
    if (alloc.person) {
      return alloc.person.name || "Unknown";
    }
    if (alloc.guest) {
      return `Guest: ${alloc.guest.name}`;
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
    // Now using direct object references
    if (args.request.person) {
      return args.request.person.name || "Unknown";
    }
    if (args.request.guest) {
      return `Guest: ${args.request.guest.name}`;
    }
    return "Unknown";
  },
);

const getHostName = lift(
  (args: { guest: Guest; people: Person[] }): string => {
    // Now using direct object reference
    return args.guest.hostPerson?.name || "Unknown";
  },
);

const isArrayEmpty = lift((arr: unknown[]): boolean => arr.length === 0);

const isNumberZero = lift((n: number): boolean => n === 0);

const formatGuestType = lift((type: GuestType): string =>
  type === "high-priority" ? "High Priority" : "Best Effort"
);

// Lifted helpers for conditional rendering (to avoid computed() inside .map())
const isPendingGreaterThanZero = lift(
  (day: { pending: number }): boolean => day.pending > 0,
);

const isGuestHighPriority = lift((guest: Guest): boolean =>
  guest.type === "high-priority"
);

const isTabActive = lift(
  (args: { activeTab: string; tab: string }): boolean =>
    args.activeTab === args.tab,
);

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

// Note: Removed getSortedPriorityList - we now use people array directly
// since its order IS the priority order. Using lift() would return an
// OpaqueRef that doesn't work with JSX .map().

// ============ MODULE-SCOPE HANDLERS ============

/**
 * Remove a person (event-based for stream pattern)
 *
 * WORKAROUND for rendering issue: Creating handler bindings inside .map()
 * with person from callback causes only the first card to render.
 * Using event-based handlers with .send() in arrow functions fixes this.
 * See: movePriorityUpStreamHandler for the same pattern.
 */
const removePersonStreamHandler = handler<
  RemovePersonEvent,
  {
    people: Writable<Person[]>;
    requests: Writable<SpotRequest[]>;
    guests: Writable<Guest[]>;
  }
>((event, { people, requests, guests }) => {
  const person = event.person;
  const pList = people.get();
  const idx = pList.findIndex((p) => equals(person, p));
  if (idx >= 0) {
    people.set(pList.toSpliced(idx, 1));
  }
  // Remove related requests
  const reqList = requests.get();
  const filteredReqs = reqList.filter(
    (r) => !r.person || !equals(r.person, person),
  );
  if (filteredReqs.length !== reqList.length) {
    requests.set(filteredReqs);
  }
  // Remove guests hosted by this person
  const guestList = guests.get();
  const filteredGuests = guestList.filter(
    (g) => !g.hostPerson || !equals(g.hostPerson, person),
  );
  if (filteredGuests.length !== guestList.length) {
    guests.set(filteredGuests);
  }
});

// Remove a guest (context-based for UI buttons)
const removeGuestHandler = handler<
  unknown,
  { guests: Writable<Guest[]>; requests: Writable<SpotRequest[]>; guest: Guest }
>((_event, { guests, requests, guest }) => {
  const gList = guests.get();
  const idx = gList.findIndex((g) => equals(guest, g));
  if (idx >= 0) {
    guests.set(gList.toSpliced(idx, 1));
  }
  // Also remove any requests for this guest
  const reqList = requests.get();
  const filteredReqs = reqList.filter((r) =>
    !r.guest || !equals(r.guest, guest)
  );
  if (filteredReqs.length !== reqList.length) {
    requests.set(filteredReqs);
  }
});

// Cancel a request (context-based for UI buttons)
const cancelRequestHandler = handler<
  unknown,
  {
    requests: Writable<SpotRequest[]>;
    allocations: Writable<Allocation[]>;
    request: SpotRequest;
  }
>((_event, { requests, allocations, request: targetRequest }) => {
  const reqList = requests.get();
  const idx = reqList.findIndex((r) => equals(targetRequest, r));
  if (idx < 0) return;

  const request = reqList[idx];

  // Remove allocation if exists
  if (request.status === "allocated" && request.allocatedSpot) {
    const allocList = allocations.get();
    const allocIdx = allocList.findIndex(
      (a) =>
        a.date === request.date &&
        a.spot === request.allocatedSpot &&
        ((request.person && a.person && equals(a.person, request.person)) ||
          (request.guest && a.guest && equals(a.guest, request.guest))),
    );
    if (allocIdx >= 0) {
      allocations.set(allocList.toSpliced(allocIdx, 1));
    }
  }

  const updated = [...reqList];
  updated[idx] = { ...updated[idx], status: "cancelled" as RequestStatus };
  requests.set(updated);
});

// Manually allocate a spot to a request (context-based for UI buttons)
const allocateSpotHandler = handler<
  unknown,
  {
    requests: Writable<SpotRequest[]>;
    allocations: Writable<Allocation[]>;
    people: Writable<Person[]>;
    request: SpotRequest;
    spotNumber: SpotNumber;
  }
>((
  _event,
  { requests, allocations, people, request: targetRequest, spotNumber },
) => {
  const reqList = requests.get();
  const idx = reqList.findIndex((r) => equals(targetRequest, r));
  if (idx < 0) return;

  const request = reqList[idx];
  if (request.status !== "pending") return;

  // Check spot available
  const isAvail = !allocations
    .get()
    .some((a) => a.date === request.date && a.spot === spotNumber);
  if (!isAvail) return;

  // Create allocation with direct object references
  const allocation: Allocation = {
    date: request.date,
    spot: spotNumber,
    person: request.person,
    guest: request.guest,
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
  if (request.person) {
    const pList = people.get();
    const pIdx = request.person
      ? pList.findIndex((p) => equals(request.person!, p))
      : -1;
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
/**
 * WORKAROUND for CT-1173: Array persistence bug
 *
 * When array elements are obtained via .get() on a Writable<Person[]>, they
 * contain internal proxy symbols (like Symbol("toCell")) that interfere with
 * persistence. When you .set() an array containing these proxy objects, the
 * persistence layer can lose field values on second+ items.
 *
 * The fix is to explicitly reconstruct each object as a plain JavaScript object,
 * stripping the proxy symbols. This ensures all field values persist correctly.
 *
 * See: https://linear.app/common-tools/issue/CT-1173
 * See also: tutorials/making-lists.md (lines 195-224)
 */
const reconstructPerson = (p: Person): Person => ({
  name: p.name,
  email: p.email,
  phone: p.phone,
  usualCommuteMode: p.usualCommuteMode,
  livesNearby: p.livesNearby,
  spotPreferences: [...(p.spotPreferences || [])],
  compatibleSpots: [...(p.compatibleSpots || [])],
  defaultSpot: p.defaultSpot,
  priorityRank: p.priorityRank,
  totalBookings: p.totalBookings,
  lastBookingDate: p.lastBookingDate,
  createdAt: p.createdAt,
});

const movePriorityUpStreamHandler = handler<
  MovePriorityUpEvent,
  { people: Writable<Person[]> }
>((event, { people }) => {
  const person = event.person;
  const order = people.get();
  const idx = order.findIndex((p) => equals(person, p));
  if (idx <= 0) return;

  const newOrder = order.map(reconstructPerson);
  [newOrder[idx - 1], newOrder[idx]] = [newOrder[idx], newOrder[idx - 1]];
  people.set(newOrder);
});

// Move person down in priority (event-based for exposed stream)
const movePriorityDownStreamHandler = handler<
  MovePriorityDownEvent,
  { people: Writable<Person[]> }
>((event, { people }) => {
  const person = event.person;
  const order = people.get();
  const idx = order.findIndex((p) => equals(person, p));
  if (idx < 0 || idx >= order.length - 1) return;

  const newOrder = order.map(reconstructPerson);
  [newOrder[idx], newOrder[idx + 1]] = [newOrder[idx + 1], newOrder[idx]];
  people.set(newOrder);
});

// Add a person
const addPersonHandler = handler<
  AddPersonEvent,
  { people: Writable<Person[]> }
>((event, { people }) => {
  const currentPeople = people.get();

  const person: Person = {
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
  };
  people.push(person);
});

// Add a guest
const addGuestHandler = handler<
  AddGuestEvent,
  { guests: Writable<Guest[]> }
>((event, { guests }) => {
  guests.push({
    name: event.name,
    hostPerson: event.hostPerson,
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
  // Check for existing request using equals() for object comparison
  const existingRequest = requests.get().find(
    (r) =>
      r.date === event.date &&
      ((event.person && r.person && equals(r.person, event.person)) ||
        (event.guest && r.guest && equals(r.guest, event.guest))) &&
      r.status !== "cancelled",
  );
  if (existingRequest) return;

  requests.push({
    date: event.date,
    person: event.person || null,
    guest: event.guest || null,
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
    _guests: Writable<Guest[]>;
  }
>((event, { requests, allocations, people, _guests }) => {
  const date = event.date;
  const reqList = requests.get();
  const allocList = allocations.get();
  const prioOrder = people.get();

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
      if (!r.guest) return false;
      return r.guest.type === "high-priority";
    })
  ) {
    const guest = req.guest;
    if (!guest) continue;
    const compat = (guest.compatibleSpots as SpotNumber[]) || allSpotNumbers;
    const avail = getAvailableCompatible(compat);
    const reqIdx = updatedReqs.findIndex((r) => equals(req, r));
    if (avail.length > 0 && reqIdx >= 0) {
      const spot = avail[0];
      usedSpots.add(spot);
      updatedReqs[reqIdx] = {
        ...updatedReqs[reqIdx],
        status: "allocated" as RequestStatus,
        allocatedSpot: spot,
      };
      newAllocs.push({
        date,
        spot,
        person: req.person,
        guest: req.guest,
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
        r.person &&
        updatedReqs.find((ur) => equals(ur, r))?.status === "pending",
    )
    .sort((a, b) => {
      const aIdx = a.person
        ? prioOrder.findIndex((p) => equals(p, a.person!))
        : -1;
      const bIdx = b.person
        ? prioOrder.findIndex((p) => equals(p, b.person!))
        : -1;
      return aIdx - bIdx;
    });

  for (const req of personReqs) {
    const person = req.person;
    if (!person) continue;
    const compat = (person.compatibleSpots as SpotNumber[]) || allSpotNumbers;
    const avail = getAvailableCompatible(compat);
    const reqIdx = updatedReqs.findIndex((r) => equals(req, r));

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
        date,
        spot,
        person: req.person,
        guest: req.guest,
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
      if (!r.guest) return false;
      const curr = updatedReqs.find((ur) => equals(ur, r));
      if (curr?.status !== "pending") return false;
      return r.guest.type === "best-effort";
    })
  ) {
    const guest = req.guest;
    if (!guest) continue;
    const compat = (guest.compatibleSpots as SpotNumber[]) || allSpotNumbers;
    const avail = getAvailableCompatible(compat);
    const reqIdx = updatedReqs.findIndex((r) => equals(req, r));
    if (avail.length > 0 && reqIdx >= 0) {
      const spot = avail[0];
      usedSpots.add(spot);
      updatedReqs[reqIdx] = {
        ...updatedReqs[reqIdx],
        status: "allocated" as RequestStatus,
        allocatedSpot: spot,
      };
      newAllocs.push({
        date,
        spot,
        person: req.person,
        guest: req.guest,
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

// ============ UI FORM HANDLERS ============
// These handlers wrap form state access to avoid "reactive reference outside of a reactive context" errors

const addPersonFromFormHandler = handler<
  void,
  {
    newPersonName: Writable<string>;
    newPersonEmail: Writable<string>;
    people: Writable<Person[]>;
  }
>((_event, { newPersonName, newPersonEmail, people }) => {
  const name = newPersonName.get().trim();
  const email = newPersonEmail.get().trim();
  if (!name) return;

  const currentPeople = people.get();
  const person: Person = {
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
  };
  people.push(person);

  newPersonName.set("");
  newPersonEmail.set("");
});

const addGuestFromFormHandler = handler<
  void,
  {
    newGuestName: Writable<string>;
    newGuestHost: Writable<string>;
    newGuestType: Writable<GuestType>;
    people: Writable<Person[]>;
    guests: Writable<Guest[]>;
  }
>((_event, { newGuestName, newGuestHost, newGuestType, people, guests }) => {
  const name = newGuestName.get().trim();
  const hostPersonIdx = parseInt(newGuestHost.get(), 10);
  const guestType = newGuestType.get();
  const peopleList = people.get();
  if (
    !name ||
    isNaN(hostPersonIdx) ||
    hostPersonIdx < 0 ||
    hostPersonIdx >= peopleList.length
  ) return;

  const hostPerson = peopleList[hostPersonIdx];
  guests.push({
    name,
    hostPerson,
    type: guestType,
    compatibleSpots: [1, 5, 12],
    notes: "",
    createdAt: Date.now(),
  });

  newGuestName.set("");
  newGuestHost.set("");
  newGuestType.set("best-effort");
});

const requestSpotFromFormHandler = handler<
  void,
  {
    selectedPersonForRequest: Writable<string>;
    selectedRequestDate: Writable<string>;
    people: Writable<Person[]>;
    requests: Writable<SpotRequest[]>;
  }
>(
  (
    _event,
    { selectedPersonForRequest, selectedRequestDate, people, requests },
  ) => {
    const personIdx = parseInt(selectedPersonForRequest.get(), 10);
    const date = selectedRequestDate.get();
    const peopleList = people.get();
    if (
      isNaN(personIdx) ||
      personIdx < 0 ||
      personIdx >= peopleList.length ||
      !isWithinBookingWindow(date)
    ) return;

    const person = peopleList[personIdx];

    // Check for existing request using equals()
    const existingRequest = requests.get().find(
      (r) =>
        r.date === date &&
        r.person &&
        equals(r.person, person) &&
        r.status !== "cancelled",
    );
    if (existingRequest) return;

    requests.push({
      date,
      person,
      guest: null,
      requestedAt: Date.now(),
      status: "pending",
      allocatedSpot: null,
      notes: "",
    });
  },
);

const runAutoAllocateFromFormHandler = handler<
  void,
  {
    selectedRequestDate: Writable<string>;
    requests: Writable<SpotRequest[]>;
    allocations: Writable<Allocation[]>;
    people: Writable<Person[]>;
  }
>(
  (
    _event,
    { selectedRequestDate, requests, allocations, people },
  ) => {
    const date = selectedRequestDate.get();
    const reqList = requests.get();
    const allocList = allocations.get();
    const prioOrder = people.get();

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
        if (!r.guest) return false;
        return r.guest.type === "high-priority";
      })
    ) {
      const guest = req.guest;
      if (!guest) continue;
      const compat = (guest.compatibleSpots as SpotNumber[]) || allSpotNumbers;
      const avail = getAvailableCompatible(compat);
      const reqIdx = updatedReqs.findIndex((r) => equals(req, r));
      if (avail.length > 0 && reqIdx >= 0) {
        const spot = avail[0];
        usedSpots.add(spot);
        updatedReqs[reqIdx] = {
          ...updatedReqs[reqIdx],
          status: "allocated" as RequestStatus,
          allocatedSpot: spot,
        };
        newAllocs.push({
          date,
          spot,
          person: req.person,
          guest: req.guest,
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
          r.person &&
          updatedReqs.find((ur) => equals(ur, r))?.status === "pending",
      )
      .sort((a, b) => {
        const aIdx = a.person
          ? prioOrder.findIndex((p) => equals(p, a.person!))
          : -1;
        const bIdx = b.person
          ? prioOrder.findIndex((p) => equals(p, b.person!))
          : -1;
        return aIdx - bIdx;
      });

    for (const req of personReqs) {
      const person = req.person;
      if (!person) continue;
      const compat = (person.compatibleSpots as SpotNumber[]) || allSpotNumbers;
      const avail = getAvailableCompatible(compat);
      const reqIdx = updatedReqs.findIndex((r) => equals(req, r));

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
          date,
          spot,
          person: req.person,
          guest: req.guest,
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
        if (!r.guest) return false;
        const curr = updatedReqs.find((ur) => equals(ur, r));
        if (curr?.status !== "pending") return false;
        return r.guest.type === "best-effort";
      })
    ) {
      const guest = req.guest;
      if (!guest) continue;
      const compat = (guest.compatibleSpots as SpotNumber[]) || allSpotNumbers;
      const avail = getAvailableCompatible(compat);
      const reqIdx = updatedReqs.findIndex((r) => equals(req, r));
      if (avail.length > 0 && reqIdx >= 0) {
        const spot = avail[0];
        usedSpots.add(spot);
        updatedReqs[reqIdx] = {
          ...updatedReqs[reqIdx],
          status: "allocated" as RequestStatus,
          allocatedSpot: spot,
        };
        newAllocs.push({
          date,
          spot,
          person: req.person,
          guest: req.guest,
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
  },
);

// ============ MAIN PATTERN ============

export default pattern<Input, Output>(
  ({ spots, people, guests, requests, allocations }) => {
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
    // Note: Using people directly instead of lift() result
    // The people array order IS the priority order, no transformation needed
    // Using lift() would return an OpaqueRef that doesn't work with JSX .map()
    const sortedPriority = people;
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

    // Person select items for dropdowns - use index as value since we removed IDs
    const personSelectItems = computed(() =>
      people.get().map((p, idx) => ({ label: p.name, value: String(idx) }))
    );

    // Create handler streams for UI form buttons
    const addPersonFromFormStream = addPersonFromFormHandler({
      newPersonName,
      newPersonEmail,
      people,
    });
    const addGuestFromFormStream = addGuestFromFormHandler({
      newGuestName,
      newGuestHost,
      newGuestType,
      people,
      guests,
    });
    const requestSpotFromFormStream = requestSpotFromFormHandler({
      selectedPersonForRequest,
      selectedRequestDate,
      people,
      requests,
    });
    const runAutoAllocateFromFormStream = runAutoAllocateFromFormHandler({
      selectedRequestDate,
      requests,
      allocations,
      people,
    });

    /**
     * Priority control streams for People tab
     *
     * WORKAROUND: Creating handler bindings inside .map() with person from
     * callback causes only the first card to render. Using pre-created
     * streams and calling .send() in onClick arrow functions fixes this.
     */
    const movePriorityUpStream = movePriorityUpStreamHandler({ people });
    const movePriorityDownStream = movePriorityDownStreamHandler({ people });
    const removePersonStream = removePersonStreamHandler({
      people,
      requests,
      guests,
    });

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
              isTabActive({ activeTab, tab: "today" }),
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
                              request: req,
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
                            request: req,
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
                  ifElse(
                    isNumberZero(personCount),
                    <ct-card style="background: var(--ct-color-blue-50); border: 1px solid var(--ct-color-blue-200);">
                      <ct-vstack
                        gap="2"
                        style="text-align: center; padding: 1rem;"
                      >
                        <span style="font-size: 1.5rem;">🚗</span>
                        <span style="font-weight: 600; color: var(--ct-color-blue-700);">
                          Get Started
                        </span>
                        <span style="color: var(--ct-color-gray-600); font-size: 0.875rem;">
                          Add team members in the Admin tab to begin
                          coordinating parking spots.
                        </span>
                      </ct-vstack>
                    </ct-card>,
                    <div style="text-align: center; color: var(--ct-color-gray-500); padding: 1rem;">
                      No pending requests for today
                    </div>,
                  ),
                  null,
                )}
              </ct-vstack>,
              null,
            )}

            {/* WEEK TAB */}
            {ifElse(
              isTabActive({ activeTab, tab: "week" }),
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
                            isPendingGreaterThanZero(day),
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
              isTabActive({ activeTab, tab: "people" }),
              <ct-vstack gap="2" style="padding: 1rem;">
                <ct-hstack justify="between" align="center">
                  <ct-heading level={5}>
                    Priority List ({personCount})
                  </ct-heading>
                </ct-hstack>
                <p style="font-size: 0.75rem; color: var(--ct-color-gray-500); margin: 0;">
                  Higher position = gets spot first. Use arrows to reorder.
                </p>

                {
                  /*
                   * Person cards with priority controls
                   *
                   * WORKAROUND: Use pre-created handler streams and call .send()
                   * in onClick arrow functions instead of creating handlers
                   * inline in .map(). Creating handlers inside .map() with
                   * person from the callback causes rendering issues where
                   * only the first card renders.
                   */
                }
                {sortedPriority.map((person) => (
                  <ct-card>
                    <ct-hstack gap="2" align="center">
                      <ct-vstack gap="0" style="flex: 1;">
                        <span style="font-weight: 500;">{person.name}</span>
                        <span style="font-size: 0.75rem; color: var(--ct-color-gray-500);">
                          {person.usualCommuteMode || "drive"}
                        </span>
                      </ct-vstack>
                      <ct-button
                        variant="ghost"
                        size="sm"
                        onClick={() => movePriorityUpStream.send({ person })}
                      >
                        ↑
                      </ct-button>
                      <ct-button
                        variant="ghost"
                        size="sm"
                        onClick={() => movePriorityDownStream.send({ person })}
                      >
                        ↓
                      </ct-button>
                      <ct-button
                        variant="ghost"
                        size="sm"
                        onClick={() => removePersonStream.send({ person })}
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
              isTabActive({ activeTab, tab: "admin" }),
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
                        onClick={addPersonFromFormStream}
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
                          { label: "Best Effort", value: "best-effort" },
                          { label: "High Priority", value: "high-priority" },
                        ]}
                        placeholder="Priority"
                        style="width: 140px;"
                      />
                      <ct-button
                        variant="primary"
                        onClick={addGuestFromFormStream}
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
                        onClick={requestSpotFromFormStream}
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
                        onClick={runAutoAllocateFromFormStream}
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
                                isGuestHighPriority(guest),
                                "var(--ct-color-red-100)",
                                "var(--ct-color-gray-100)",
                              ),
                              color: ifElse(
                                isGuestHighPriority(guest),
                                "var(--ct-color-red-700)",
                                "var(--ct-color-gray-700)",
                              ),
                            }}
                          >
                            {formatGuestType(guest.type)}
                          </span>
                          <ct-button
                            variant="ghost"
                            size="sm"
                            onClick={removeGuestHandler({
                              guests,
                              requests,
                              guest,
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
      todayDate,
      // Exposed action streams for testing
      addPerson: addPersonHandler({ people }),
      addGuest: addGuestHandler({ guests }),
      requestSpot: requestSpotHandler({ requests }),
      runAutoAllocate: runAutoAllocateHandler({
        requests,
        allocations,
        people,
        _guests: guests,
      }),
      movePriorityUp: movePriorityUpStreamHandler({ people }),
      movePriorityDown: movePriorityDownStreamHandler({ people }),
    };
  },
);
