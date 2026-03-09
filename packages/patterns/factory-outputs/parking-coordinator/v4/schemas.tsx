/// <cts-enable />
import { Default, NAME, Stream, UI, type VNode, Writable } from "commontools";

// === Domain Types ===

/** A physical parking space */
export interface ParkingSpot {
  number: number;
  label: Default<string, "">;
  notes: Default<string, "">;
}

/** Commute mode options */
export type CommuteMode = "drive" | "transit" | "bike" | "wfh" | "other";

/** A team member who may use the parking system */
export interface Person {
  name: string;
  email: string;
  commuteMode: Default<CommuteMode, "drive">;
  spotPreferences: Default<number[], []>;
  defaultSpot: Default<number, 0>; // 0 means no default
}

/** Status of a spot request */
export type RequestStatus = "pending" | "allocated" | "denied" | "cancelled";

/** A team member's request for a parking spot on a specific date */
export interface SpotRequest {
  personEmail: string; // reference by email
  date: string; // YYYY-MM-DD
  status: Default<RequestStatus, "pending">;
  assignedSpot: Default<number, 0>; // 0 means none
  requestedAt: string; // ISO timestamp
}

/** A confirmed parking assignment for a specific spot on a specific date */
export interface Allocation {
  spotNumber: number;
  date: string; // YYYY-MM-DD
  personEmail: string;
  autoAllocated: Default<boolean, true>;
}

// === Pattern Types ===

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
  adminMode: boolean;
  todayDate: string;
  viewMode: string;

  // Initialization
  seedSpots: Stream<void>;

  // Team member actions
  requestSpot: Stream<{ personEmail: string; date: string }>;
  cancelRequest: Stream<{ personEmail: string; date: string }>;
  retryRequest: Stream<{ personEmail: string; date: string }>;

  // Admin actions
  toggleAdmin: Stream<void>;
  setViewMode: Stream<{ mode: string }>;
  addPerson: Stream<{ name: string; email: string; commuteMode: string }>;
  removePerson: Stream<{ email: string }>;
  movePersonUp: Stream<{ email: string }>;
  movePersonDown: Stream<{ email: string }>;
  setDefaultSpot: Stream<{ email: string; spotNumber: number }>;
  setSpotPreferences: Stream<{ email: string; preferences: number[] }>;
  addSpot: Stream<{ number: number; label: string; notes: string }>;
  removeSpot: Stream<{ spotNumber: number }>;
  editSpot: Stream<{ spotNumber: number; label: string; notes: string }>;
  manualAllocate: Stream<{
    personEmail: string;
    date: string;
    spotNumber: number;
  }>;
}
