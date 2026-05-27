import {
  action,
  computed,
  Default,
  generateObject,
  handler,
  ImageData,
  NAME,
  nonPrivateRandom,
  pattern,
  type PerSpace,
  safeDateNow,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import { normalizePlateId, US_STATES } from "../../vehicles.ts";

// ============================================================
// Domain Types (DESIGN §4)
// ============================================================

export type Classification = "ours" | "guest" | "offender" | "unknown";

// Phase 3b: known-vehicle registry entry (DESIGN §8). category "ours" is
// derived from people[].vehicles — only guest/offender live here.
export interface KnownVehicle {
  plateNumber: string; // normalized uppercase alphanumerics
  plateState: string; // uppercase 2-letter
  description: string; // human note, e.g. "white delivery van"
  category: "guest" | "offender";
  name?: string; // optional display name for guests (e.g. "Mary Friend")
  org: string; // e.g. "Local Butcher Shop"
  label: string; // e.g. "delivery van, Tue mornings"
}

// Phase 2: structured result of LLM plate/vehicle extraction from a photo.
export interface PlateExtraction {
  description: string; // color + make + model in plain words; "" if unclear
  plateNumber: string; // characters only; "" if not legible
  plateState: string; // 2-letter US state; "" if not visible
  confidence: "high" | "medium" | "low";
}

// Lightweight persisted image reference. We deliberately store only the blob
// `url` (+ filename), NOT the full `ImageData` — its required `data` field is a
// ~700KB inline base64 string, and inlining that into the perSpace `sightings`
// array destabilizes the cell's sync. The blob bytes live out-of-band at `url`.
export interface SightingImage {
  url: string;
  name: string;
}

export interface Sighting {
  id: string;
  spotNumber: string;
  capturedAt: number;
  reportedBy: string;
  image: SightingImage;
  description: string;
  plateNumber: string; // normalized uppercase alphanumerics
  plateState: string; // uppercase 2-letter
  extractionPending: boolean; // Phase 2: true while LLM call is in flight
  extractionError: string; // Phase 2: non-empty if extraction failed
  humanCorrected: boolean; // Phase 2: true once a person edited the extracted fields
  classification: Classification;
  notes: string;
}

// ============================================================
// Cell Types (DESIGN §5)
// ============================================================

// Spots cell — reuse parking-coordinator's shape (spotNumber + label)
export interface ParkingSpot {
  spotNumber: string;
  label: string;
  notes?: string;
  active?: boolean;
}

type SpotsCell = Writable<
  | ParkingSpot[]
  | Default<[
    { spotNumber: "1"; label: "Near entrance" },
    { spotNumber: "5"; label: "" },
    { spotNumber: "12"; label: "Compact only" },
    { spotNumber: "13"; label: "" },
  ]>
>;

type SightingsCell = Writable<Sighting[] | Default<[]>>;

// Phase 3b: known-vehicle registry cell
type KnownVehiclesCell = Writable<KnownVehicle[] | Default<[]>>;

// Phase 3b: loose person shape — we read only vehicles from it.
// The full parking-coordinator Person has more fields; this covers what we need.
// Phase 3c: vehicle element type includes the full coordinator shape so writes
// from assignToPerson are compatible with the coordinator's UI.
interface PersonWithVehicles {
  name: string;
  vehicles?: {
    plateId: string;
    plateState: string;
    color?: string;
    make?: string;
    model?: string;
  }[];
}

type PeopleCell = Writable<PersonWithVehicles[] | Default<[]>>;

// ============================================================
// Pattern I/O (DESIGN §12, trimmed to Phase 1)
// ============================================================

export interface LotWatchInput {
  spots?: PerSpace<SpotsCell>;
  sightings?: PerSpace<SightingsCell>;
  // Phase 3b: read employee vehicles → "ours" classification
  people?: PerSpace<PeopleCell>;
  // Phase 3b: guest/offender registries
  knownVehicles?: PerSpace<KnownVehiclesCell>;
  // Phase 3c: adminRegistry?: PerSpace<...>;  — admin gating
}

export interface LotWatchOutput {
  [NAME]: string;
  [UI]: VNode;
  sightings: Sighting[];
  knownVehicles: KnownVehicle[];
  people: PersonWithVehicles[];
  captureSighting: Stream<{
    spotNumber: string;
    image: ImageData;
    description: string;
    plateNumber: string;
    plateState: string;
    notes: string;
  }>;
  deleteSighting: Stream<{ id: string }>;
  selectTab: Stream<{ tab: "capture" | "sightings" }>;
  markVehicle: Stream<{
    plateNumber: string;
    plateState: string;
    category: "guest" | "offender";
    org: string;
    label?: string;
    name?: string;
  }>;
  removeKnownVehicle: Stream<{ plateNumber: string; plateState: string }>;
  openAssign: Stream<{ id: string }>;
  cancelAssign: Stream<void>;
  assignToPerson: Stream<void>;
  openGuest: Stream<{ id: string }>;
  cancelGuest: Stream<void>;
  saveGuest: Stream<void>;
}

// ============================================================
// Utilities
// ============================================================

const genId = (): string =>
  `sighting-${safeDateNow()}-${nonPrivateRandom().toString(36).slice(2, 10)}`;

type ImageUploadEvent = {
  detail?: {
    images?: ImageData[];
    allImages?: ImageData[];
    files?: ImageData[];
    allFiles?: ImageData[];
  };
};

// ============================================================
// Module-scope handlers (MUST be at module scope — not inside pattern())
// ============================================================

const onPhotoCaptured = handler<
  ImageUploadEvent,
  { draftImage: Writable<ImageData | null> }
>(({ detail }, { draftImage }) => {
  const img = (detail?.allImages ?? detail?.images ?? [])[0] ?? null;
  draftImage.set(img);
});

// ============================================================
// Classification display helpers (module scope — not inside pattern())
// ============================================================

const classificationColor = (c: Classification): string => {
  if (c === "ours") return "#166534";
  if (c === "guest") return "#1e40af";
  if (c === "offender") return "#991b1b";
  return "#374151"; // unknown
};

const classificationBg = (c: Classification): string => {
  if (c === "ours") return "#dcfce7";
  if (c === "guest") return "#dbeafe";
  if (c === "offender") return "#fee2e2";
  return "#f3f4f6"; // unknown
};

// ============================================================
// Phase 3b: Classification helper (DESIGN §8) — module-scope pure function
// so it can be called from inside computed() without capturing cells.
// Priority: ours > offender > guest > unknown.
// ============================================================

export const classifyPlate = (
  plateNumber: string,
  plateState: string,
  ours: readonly { plateId: string; plateState: string }[],
  known: readonly KnownVehicle[],
): Classification => {
  if (!plateNumber) return "unknown";
  const normPlate = normalizePlateId(plateNumber);
  const normState = plateState.toUpperCase().trim();
  // 1. ours — from people[].vehicles
  for (const v of ours) {
    if (
      normalizePlateId(v.plateId) === normPlate &&
      v.plateState.toUpperCase().trim() === normState
    ) {
      return "ours";
    }
  }
  // 2. offender takes priority over guest
  for (const kv of known) {
    if (
      normalizePlateId(kv.plateNumber) === normPlate &&
      kv.plateState.toUpperCase().trim() === normState &&
      kv.category === "offender"
    ) {
      return "offender";
    }
  }
  // 3. guest
  for (const kv of known) {
    if (
      normalizePlateId(kv.plateNumber) === normPlate &&
      kv.plateState.toUpperCase().trim() === normState &&
      kv.category === "guest"
    ) {
      return "guest";
    }
  }
  return "unknown";
};

// Phase 3: group sightings by normalized plate (plateNumber|plateState).
// Module-scope pure helper so both the sightings list and the repeat-offender
// summary derive from it without one computed reading another. Sightings with
// no readable plate are skipped (can't be matched/deduped).
export const plateKey = (plateNumber: string, plateState: string): string =>
  `${plateNumber}|${plateState}`;

export interface PlateGroup {
  plate: string;
  state: string;
  description: string;
  count: number;
  spots: string[];
  firstSeen: number;
  lastSeen: number;
  isRepeat: boolean; // seen 2+ times => repeat offender
}

const groupSightingsByPlate = (all: readonly Sighting[]): PlateGroup[] => {
  const map = new Map<string, PlateGroup>();
  for (const s of all) {
    if (!s.plateNumber) continue;
    const key = plateKey(s.plateNumber, s.plateState);
    const g = map.get(key);
    if (g) {
      g.count += 1;
      if (!g.spots.includes(s.spotNumber)) g.spots.push(s.spotNumber);
      g.firstSeen = Math.min(g.firstSeen, s.capturedAt);
      g.lastSeen = Math.max(g.lastSeen, s.capturedAt);
      if (!g.description && s.description) g.description = s.description;
    } else {
      map.set(key, {
        plate: s.plateNumber,
        state: s.plateState,
        description: s.description,
        count: 1,
        spots: [s.spotNumber],
        firstSeen: s.capturedAt,
        lastSeen: s.capturedAt,
        isRepeat: false,
      });
    }
  }
  const groups: PlateGroup[] = [];
  for (const g of map.values()) {
    g.isRepeat = g.count >= 2;
    groups.push(g);
  }
  return groups;
};

const fmtWhen = (ts: number): string => {
  const d = new Date(ts);
  return `${
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  } ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
};

// ============================================================
// Default seed data
// ============================================================

const DEFAULT_SPOTS: ParkingSpot[] = [
  { spotNumber: "1", label: "Near entrance", active: true },
  { spotNumber: "5", label: "", active: true },
  { spotNumber: "12", label: "Compact only", active: true },
  { spotNumber: "13", label: "", active: true },
];

// ============================================================
// Pattern
// ============================================================

export default pattern<LotWatchInput, LotWatchOutput>(
  ({
    spots: inputSpots,
    sightings: inputSightings,
    people: inputPeople,
    knownVehicles: inputKnownVehicles,
  }) => {
    // ---- Cells (DESIGN §5) ----

    const spots = inputSpots ?? Writable.perSpace.of(DEFAULT_SPOTS);
    const sightings = inputSightings ??
      Writable.perSpace.of<Sighting[]>([]);

    // Phase 3b: known-vehicle registry (guests + offenders). When wired from a
    // parent space we share the same cell; standalone we own it.
    const knownVehicles = inputKnownVehicles ??
      Writable.perSpace.of<KnownVehicle[]>([]);

    // Phase 3b: people cell — read-only for deriving the "ours" vehicle set.
    // When absent (standalone) the "ours" bucket is empty.
    const people = inputPeople ??
      Writable.perSpace.of<PersonWithVehicles[]>([]);

    // PerUser: who is reporting
    const reporterName = new Writable.perUser("");

    // PerSession: tab navigation
    const selectedTab = new Writable.perSession<"capture" | "sightings">(
      "capture",
    );

    // PerSession: capture draft fields
    const draftSpot = new Writable.perSession("");
    const draftImage = new Writable.perSession<ImageData | null>(null);
    const draftDescription = new Writable.perSession("");
    const draftPlateNumber = new Writable.perSession("");
    const draftPlateState = new Writable.perSession("CA");
    const draftNotes = new Writable.perSession("");

    // PerSession: delete confirm dialog target
    const deleteConfirmTarget = new Writable.perSession<string | null>(null);

    // Phase 3c: assign-to-person dialog state
    // assignTarget: sighting id whose person-picker is open, or null
    const assignTarget = new Writable.perSession<string | null>(null);
    // assignPersonName: name of the person selected in the picker
    const assignPersonName = new Writable.perSession<string>("");

    // Guest name flow: inline form to optionally name a guest vehicle.
    // guestTarget: sighting id whose guest-name form is open, or null
    const guestTarget = new Writable.perSession<string | null>(null);
    // guestName: free-text name typed in the guest form
    const guestName = new Writable.perSession<string>("");

    // ---- Phase 2: LLM extraction from the draft photo ----
    // Runs reactively when a photo is captured. Uses the draft's inline `data`
    // (that's why `includeData` stays on the capture input) — transient, the
    // saved Sighting keeps only the blob url.
    const extraction = generateObject<PlateExtraction>({
      system:
        "You are reading a photo of a parked car to log a parking violation. " +
        "Extract the vehicle description (color + make + model in plain words), " +
        "the license plate characters, and the 2-letter US state if visible. " +
        "The photo may be rotated. If a field is not legible, return an empty " +
        "string — do not guess.",
      prompt: computed(() => {
        const img = draftImage.get();
        const image = img?.data ?? img?.url;
        if (!image) return [];
        return [
          { type: "image" as const, image },
          {
            type: "text" as const,
            text:
              "Extract description, plateNumber (characters only, no spaces or " +
              "dashes), plateState (2-letter), and your confidence.",
          },
        ];
      }),
      schema: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description:
              "Color + make + model in plain words, e.g. 'white Toyota Corolla'",
          },
          plateNumber: {
            type: "string",
            description:
              "Plate characters only, uppercase, no spaces/dashes; '' if illegible",
          },
          plateState: {
            type: "string",
            description: "2-letter US state code if visible, else ''",
          },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
        },
      },
      model: "anthropic:claude-sonnet-4-5",
    });

    // ---- Actions ----

    const selectTab = action<{ tab: "capture" | "sightings" }>(({ tab }) => {
      selectedTab.set(tab);
    });

    // Spot selection — cell mutations must go through an action(), not a bare
    // `.set()` in an inline onClick.
    const setDraftSpot = action<{ spot: string }>(({ spot }) => {
      draftSpot.set(spot);
    });

    // Phase 2: copy the LLM extraction into the editable draft fields. The
    // extracted values are read in JSX (where `extraction.result` is reactive)
    // and passed in as plain args — an action can't read a generateObject
    // result directly. The user can then review/correct before saving.
    const applyExtraction = action(() => {
      const r = extraction.result;
      if (r?.description) draftDescription.set(r.description);
      if (r?.plateNumber) draftPlateNumber.set(r.plateNumber);
      if (r?.plateState) draftPlateState.set(r.plateState);
    });

    const captureSighting = action<{
      spotNumber: string;
      image: ImageData;
      description: string;
      plateNumber: string;
      plateState: string;
      notes: string;
    }>(({ spotNumber, image, description, plateNumber, plateState, notes }) => {
      const normalizedPlate = normalizePlateId(plateNumber);
      const normalizedState = plateState.toUpperCase().trim().slice(0, 2);

      // Persist ONLY the lightweight blob reference (`url` + `name`), never the
      // inline base64 `data` — a ~700KB data-URL inline in this perSpace array
      // destabilizes the cell's sync. The draft kept `data` for transient use
      // (Phase 2 LLM); the stored record stays light. (Idiom: photo.tsx.)
      const lightImage = { url: image?.url ?? "", name: image?.name ?? "" };

      const sighting: Sighting = {
        id: genId(),
        spotNumber,
        capturedAt: safeDateNow(),
        reportedBy: reporterName.get() || "Unknown",
        image: lightImage,
        description: description.trim(),
        plateNumber: normalizedPlate,
        plateState: normalizedState,
        extractionPending: false, // Phase 2: set true, then resolve via LLM
        extractionError: "",
        humanCorrected: false,
        classification: "unknown", // Phase 2: classify against registries
        notes: notes.trim(),
      };

      sightings.set([...(sightings.get() ?? []), sighting]);

      // Reset draft
      draftSpot.set("");
      draftImage.set(null);
      draftDescription.set("");
      draftPlateNumber.set("");
      draftPlateState.set("CA");
      draftNotes.set("");
      selectedTab.set("sightings");
    });

    const submitCapture = action(() => {
      const img = draftImage.get();
      const spot = draftSpot.get();
      if (!img || !spot) return;
      // perSession reads can be undefined before first write — fall back.
      captureSighting.send({
        spotNumber: spot,
        image: img,
        description: draftDescription.get() ?? "",
        plateNumber: draftPlateNumber.get() ?? "",
        plateState: draftPlateState.get() ?? "CA",
        notes: draftNotes.get() ?? "",
      });
    });

    const deleteSighting = action<{ id: string }>(({ id }) => {
      sightings.set((sightings.get() ?? []).filter((s) => s.id !== id));
      deleteConfirmTarget.set(null);
    });

    const initiateDelete = action<{ id: string }>(({ id }) => {
      deleteConfirmTarget.set(id);
    });

    const cancelDelete = action(() => {
      deleteConfirmTarget.set(null);
    });

    // Phase 3c: assign-to-person actions — write the plate into the shared
    // parking-coordinator people cell so sightings classify as "ours".
    const openAssign = action<{ id: string }>(({ id }) => {
      assignTarget.set(id);
      // Default to the first person's name so the picker has a sensible value.
      const first = (people.get() ?? [])[0];
      assignPersonName.set(first?.name ?? "");
    });

    const cancelAssign = action(() => {
      assignTarget.set(null);
    });

    // Reads assignTarget + assignPersonName from cells (safe inside action).
    // Writes a coordinator-shaped Vehicle into that person's vehicles array.
    const assignToPerson = action(() => {
      const targetId = assignTarget.get();
      const personName = assignPersonName.get() ?? "";
      if (!targetId || !personName) return;

      // Find the sighting by id.
      const all = sightings.get() ?? [];
      let sightingPlate = "";
      let sightingState = "";
      for (const s of all) {
        if (s.id === targetId) {
          sightingPlate = s.plateNumber;
          sightingState = s.plateState;
          break;
        }
      }
      if (!sightingPlate) return; // no readable plate — nothing to write

      const normPlate = normalizePlateId(sightingPlate);
      const normState = sightingState.toUpperCase().trim();

      // Build a coordinator-compatible Vehicle object (extra fields fine).
      const newVehicle = {
        plateId: normPlate,
        plateState: normState,
        color: "",
        make: "",
        model: "",
      };

      // Update the people list: find the named person, dedupe by plateId|state,
      // append if not already present.
      const currentPeople = people.get() ?? [];
      const updatedPeople = currentPeople.map((p) => {
        if (p.name !== personName) return p;
        const existing = p.vehicles ?? [];
        // Dedupe: skip if this plate is already registered for this person.
        for (const v of existing) {
          if (
            normalizePlateId(v.plateId) === normPlate &&
            v.plateState.toUpperCase().trim() === normState
          ) {
            return p; // already there
          }
        }
        return { ...p, vehicles: [...existing, newVehicle] };
      });
      people.set(updatedPeople);
      assignTarget.set(null);
    });

    // Guest name flow actions.
    const openGuest = action<{ id: string }>(({ id }) => {
      guestTarget.set(id);
      guestName.set("");
    });

    const cancelGuest = action(() => {
      guestTarget.set(null);
    });

    // Reads guestTarget (sighting id) + guestName from cells; writes to registry.
    const saveGuest = action(() => {
      const targetId = guestTarget.get();
      if (!targetId) return;

      // Find the sighting to get its plate/state.
      const all = sightings.get() ?? [];
      let sightingPlate = "";
      let sightingState = "";
      for (const s of all) {
        if (s.id === targetId) {
          sightingPlate = s.plateNumber;
          sightingState = s.plateState;
          break;
        }
      }
      if (!sightingPlate) return; // no readable plate

      const normPlate = normalizePlateId(sightingPlate);
      const normState = sightingState.toUpperCase().trim().slice(0, 2);
      const guestNameVal = guestName.get() ?? "";

      // Write directly to registry (same logic as markVehicle).
      const entry: KnownVehicle = {
        plateNumber: normPlate,
        plateState: normState,
        description: "",
        category: "guest",
        name: guestNameVal,
        org: "",
        label: "",
      };
      const current = knownVehicles.get() ?? [];
      let found = false;
      const updated: KnownVehicle[] = [];
      for (const kv of current) {
        if (
          normalizePlateId(kv.plateNumber) === normPlate &&
          kv.plateState.toUpperCase().trim() === normState
        ) {
          updated.push({ ...kv, category: "guest", name: guestNameVal });
          found = true;
        } else {
          updated.push(kv);
        }
      }
      if (!found) updated.push(entry);
      knownVehicles.set(updated);
      guestTarget.set(null);
    });

    // Phase 3b: curation actions — add/update a plate in the known registry.
    // Phase 3c: admin-gate these writes before exposing to non-admin users.
    const markVehicle = action<{
      plateNumber: string;
      plateState: string;
      category: "guest" | "offender";
      org: string;
      label?: string;
      name?: string;
    }>(({ plateNumber, plateState, category, org, label, name }) => {
      const normPlate = normalizePlateId(plateNumber);
      const normState = plateState.toUpperCase().trim().slice(0, 2);
      const entry: KnownVehicle = {
        plateNumber: normPlate,
        plateState: normState,
        description: "",
        category,
        name: name ?? "",
        org: org ?? "",
        label: label ?? "",
      };
      const current = knownVehicles.get() ?? [];
      // Dedupe: if plate|state already exists, update category/org/label/name.
      let found = false;
      const updated: KnownVehicle[] = [];
      for (const kv of current) {
        if (
          normalizePlateId(kv.plateNumber) === normPlate &&
          kv.plateState.toUpperCase().trim() === normState
        ) {
          updated.push({
            ...kv,
            category,
            name: name ?? kv.name,
            org: org ?? kv.org,
            label: label ?? kv.label,
          });
          found = true;
        } else {
          updated.push(kv);
        }
      }
      if (!found) updated.push(entry);
      knownVehicles.set(updated);
    });

    const removeKnownVehicle = action<{
      plateNumber: string;
      plateState: string;
    }>(({ plateNumber, plateState }) => {
      const normPlate = normalizePlateId(plateNumber);
      const normState = plateState.toUpperCase().trim();
      knownVehicles.set(
        (knownVehicles.get() ?? []).filter(
          (kv) =>
            !(normalizePlateId(kv.plateNumber) === normPlate &&
              kv.plateState.toUpperCase().trim() === normState),
        ),
      );
    });

    // ---- Pre-computed display data (avoid OpaqueCell closures in .map()) ----

    // Active spots for the spot picker. We read the perSession `draftSpot`
    // HERE (top-level computed) and emit `selected` per spot — reading it in a
    // `computed()` nested inside the `.map()` below silently returns undefined
    // (a narrower perSession cell can't be followed from this space-scoped
    // render context), so the selected highlight would never update.
    const activeSpots = computed(() => {
      const chosen = draftSpot.get();
      return (spots.get() ?? []).filter((s) => {
        // active field may be undefined on spots from coordinator — treat as active
        const isActive = (s as ParkingSpot).active;
        return isActive === undefined || isActive === true;
      }).map((s) => ({
        spotNumber: s.spotNumber,
        label: s.label,
        selected: chosen === s.spotNumber,
      }));
    });

    // Sightings in reverse-chronological order with display-ready data.
    // Phase 3b: classification is derived LIVE from registries here — not from
    // s.classification — so promoting a plate instantly reclassifies all rows.
    const sightingRows = computed(() => {
      // Use .map() directly on the cell array (spread `[...cell.get()]` throws
      // "not iterable" inside a computed), then reverse the resulting plain
      // array for newest-first order.
      const all = sightings.get() ?? [];

      // Phase 3b: read registries ONCE at the top of this computed.
      const ourVehicles = (people.get() ?? []).flatMap(
        (p) => p.vehicles ?? [],
      );
      const knownList = knownVehicles.get() ?? [];

      // Per-row inline-open state. We read the perSession "which row's form is
      // open" cells HERE, at the top of this computed, and emit a plain boolean
      // per row. Defining a `computed()` *inside* the `.map()` below that reads
      // these perSession cells does NOT reliably re-render when they change;
      // deriving the flags in this single top-level computed does.
      const confirmId = deleteConfirmTarget.get();
      const guestId = guestTarget.get();
      const assignId = assignTarget.get();

      const repeatKeys = new Set(
        groupSightingsByPlate(all)
          .filter((g) => g.isRepeat)
          .map((g) => plateKey(g.plate, g.state)),
      );
      return all.map((s) => {
        const date = new Date(s.capturedAt);
        const dateStr = date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const timeStr = date.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        });
        const plateDisplay = s.plateNumber
          ? `${s.plateNumber}${s.plateState ? " (" + s.plateState + ")" : ""}`
          : "";
        const imgSrc = s.image?.url ?? "";
        // Phase 3b: live classification from registries (not stored field)
        const cls = classifyPlate(
          s.plateNumber,
          s.plateState,
          ourVehicles,
          knownList,
        );
        // Phase 3b: show curation buttons only for unknown plates with a
        // readable plate number. Pre-compute plate/state as plain strings so
        // the onClick arrow can read them without touching any cell.
        const canMark = cls === "unknown" && !!s.plateNumber;
        // Phase 3c: "assign to person" button — show when plate is readable
        // and currently unknown (same gate as canMark, kept separate for clarity).
        const canAssign = !!s.plateNumber && cls === "unknown";
        // knownTag: supplemental label shown next to the classification chip.
        // For guests: the optional name. For offenders: the org name.
        let knownTag = "";
        if (cls === "guest" || cls === "offender") {
          const normPlate = normalizePlateId(s.plateNumber);
          const normState = s.plateState.toUpperCase().trim();
          for (const kv of knownList) {
            if (
              normalizePlateId(kv.plateNumber) === normPlate &&
              kv.plateState.toUpperCase().trim() === normState
            ) {
              knownTag = cls === "guest" ? (kv.name ?? "") : (kv.org ?? "");
              break;
            }
          }
        }
        return {
          id: s.id,
          spotNumber: s.spotNumber,
          description: s.description,
          plateDisplay,
          plateNumber: s.plateNumber,
          plateState: s.plateState,
          reportedBy: s.reportedBy,
          dateStr,
          timeStr,
          imgSrc,
          notes: s.notes,
          classificationLabel: cls,
          classificationColor: classificationColor(cls),
          classificationBg: classificationBg(cls),
          isRepeat: s.plateNumber
            ? repeatKeys.has(plateKey(s.plateNumber, s.plateState))
            : false,
          canMark,
          canAssign,
          knownTag,
          isConfirmOpen: confirmId === s.id,
          isGuestOpen: guestId === s.id,
          isAssignOpen: assignId === s.id,
        };
      }).reverse();
    });

    // Phase 3: repeat offenders — plates seen 2+ times, newest activity first.
    const repeatOffenders = computed(() =>
      groupSightingsByPlate(sightings.get() ?? [])
        .filter((g) => g.isRepeat)
        .map((g) => ({
          plate: g.plate,
          state: g.state,
          description: g.description,
          count: g.count,
          spotsLabel: g.spots.map((n) => "#" + n).join(", "),
          firstSeen: fmtWhen(g.firstSeen),
          lastSeen: fmtWhen(g.lastSeen),
        }))
        .sort((a, b) => b.count - a.count)
    );
    const hasRepeatOffenders = computed(() =>
      groupSightingsByPlate(sightings.get() ?? []).some((g) => g.isRepeat)
    );

    // Save is disabled until an image is captured AND a spot is chosen.
    // (Read writables with .get() and return a real boolean — referencing a
    // computed inside JSX props and negating it would coerce the cell object,
    // not its value.)
    const cannotSave = computed(() => !draftImage.get() || !draftSpot.get());

    // Phase 2: gate the extraction UI on having a photo.
    const hasDraftImage = computed(() => draftImage.get() !== null);

    // Reverse-chron count for the Sightings header / empty-state.
    const sightingCount = computed(() => (sightings.get() ?? []).length);
    const noSightings = computed(() => (sightings.get() ?? []).length === 0);

    // Tab visibility — used as ternary conditions directly in JSX. NOTE:
    // perSession `.get()` returns `undefined` until first written (the
    // constructor default is NOT returned by `.get()`), so fall back to
    // "capture" — otherwise the whole body renders blank on first load.
    const isCaptureTab = computed(() =>
      (selectedTab.get() ?? "capture") === "capture"
    );
    const isSightingsTab = computed(() => selectedTab.get() === "sightings");

    // State select items
    const stateSelectItems = US_STATES.map((s) => ({ label: s, value: s }));

    // Phase 3c: people select items for the assign-to-person picker.
    // Use .map() not spread — spread throws inside computed().
    const peopleSelectItems = computed(() =>
      (people.get() ?? []).map((p) => ({ label: p.name, value: p.name }))
    );
    const hasPeople = computed(() => (people.get() ?? []).length > 0);

    // ---- UI ----

    return {
      [NAME]: "Lot Watch",
      [UI]: (
        <cf-screen>
          {/* Header with tab navigation */}
          <div
            slot="header"
            style="padding: 0.75rem 1rem; display: flex; flex-direction: column; gap: 0.5rem; border-bottom: 1px solid var(--cf-color-gray-200);"
          >
            <cf-heading level={4}>Lot Watch</cf-heading>
            <cf-hstack gap="2">
              <cf-button
                variant={computed(() =>
                  (selectedTab.get() ?? "capture") === "capture"
                    ? "primary"
                    : "secondary"
                )}
                size="sm"
                onClick={() => selectTab.send({ tab: "capture" })}
              >
                📸 Capture
              </cf-button>
              <cf-button
                variant={computed(() =>
                  selectedTab.get() === "sightings" ? "primary" : "secondary"
                )}
                size="sm"
                onClick={() => selectTab.send({ tab: "sightings" })}
              >
                🚗 Sightings
              </cf-button>
              {/* Phase 2: Report tab */}
            </cf-hstack>
          </div>

          <cf-vscroll flex>
            <cf-vstack gap="3" style="padding: 1rem;">
              {/* ====== CAPTURE TAB ====== */}
              {isCaptureTab
                ? (
                  <cf-vstack gap="3">
                    {/* Reporter name */}
                    <cf-card>
                      <cf-vstack gap="2">
                        <cf-heading level={6}>Who's reporting?</cf-heading>
                        <cf-input
                          $value={reporterName}
                          placeholder="Your name"
                          style="width: 100%;"
                        />
                      </cf-vstack>
                    </cf-card>

                    {/* Photo capture */}
                    <cf-card>
                      <cf-vstack gap="2">
                        <cf-heading level={6}>📸 Capture</cf-heading>
                        {
                          /* `includeData` gives the DRAFT image both `url` (blob
                            store) and inline `data` — `data` is used transiently
                            for Phase 2 LLM extraction. But we persist only the
                            lightweight `{url}` into the sighting (see
                            captureSighting): inlining the ~700KB `data` into the
                            perSpace array destabilizes its sync. Idiom per
                            photo.tsx — persist the blob `url`, not the bytes. */
                        }
                        <cf-image-input
                          capture="environment"
                          includeData
                          showPreview
                          previewSize="lg"
                          buttonText="📸 Photograph the car"
                          oncf-change={onPhotoCaptured({ draftImage })}
                        />
                      </cf-vstack>
                    </cf-card>

                    {/* Phase 2: auto-extraction status (once a photo exists) */}
                    {hasDraftImage
                      ? (
                        <cf-card style="border-left: 3px solid #6366f1;">
                          <cf-vstack gap="1">
                            <cf-heading level={6}>
                              ✨ Auto-extraction
                            </cf-heading>
                            {extraction.pending
                              ? (
                                <span style="font-size: 0.875rem; color: var(--cf-color-gray-500);">
                                  Reading the plate…
                                </span>
                              )
                              : extraction.error
                              ? (
                                <span style="font-size: 0.875rem; color: #991b1b;">
                                  Couldn't read it: {extraction.error}
                                </span>
                              )
                              : (
                                <cf-vstack gap="0">
                                  <span style="font-size: 0.875rem;">
                                    {extraction.result?.description}
                                  </span>
                                  <span style="font-size: 0.875rem; font-family: monospace; font-weight: 500;">
                                    {extraction.result?.plateNumber}{" "}
                                    {extraction.result?.plateState}
                                  </span>
                                  <span style="font-size: 0.7rem; color: var(--cf-color-gray-500);">
                                    confidence: {extraction.result?.confidence}
                                  </span>
                                  <cf-button
                                    variant="secondary"
                                    size="sm"
                                    style="margin-top: 0.25rem;"
                                    onClick={() => applyExtraction.send()}
                                  >
                                    ✨ Use these
                                  </cf-button>
                                </cf-vstack>
                              )}
                          </cf-vstack>
                        </cf-card>
                      )
                      : null}

                    {/* Spot picker */}
                    <cf-card>
                      <cf-vstack gap="2">
                        <cf-heading level={6}>Which spot?</cf-heading>
                        <cf-hstack gap="2" wrap>
                          {activeSpots.map((spot) => {
                            const spotNum = spot.spotNumber;
                            return (
                              <cf-button
                                variant={spot.selected ? "primary" : "secondary"}
                                onClick={() =>
                                  setDraftSpot.send({ spot: spotNum })}
                              >
                                #{spotNum}
                                {spot.label
                                  ? (
                                    <span style="font-size: 0.75rem; margin-left: 4px; opacity: 0.8;">
                                      {spot.label}
                                    </span>
                                  )
                                  : null}
                              </cf-button>
                            );
                          })}
                        </cf-hstack>
                      </cf-vstack>
                    </cf-card>

                    {/* Vehicle details */}
                    <cf-card>
                      <cf-vstack gap="2">
                        <cf-heading level={6}>Vehicle Details</cf-heading>
                        <cf-vstack gap="1">
                          <span style="font-size: 0.75rem; font-weight: 500;">
                            Description
                          </span>
                          <cf-input
                            $value={draftDescription}
                            placeholder="e.g. black Subaru Outback"
                            style="width: 100%;"
                          />
                        </cf-vstack>
                        {/* Phase 2: Description auto-filled by LLM extraction */}

                        <cf-hstack gap="2" wrap>
                          <cf-vstack gap="1" style="flex: 1; min-width: 120px;">
                            <span style="font-size: 0.75rem; font-weight: 500;">
                              Plate Number
                            </span>
                            <cf-input
                              $value={draftPlateNumber}
                              placeholder="e.g. 7ABC123"
                              style="width: 100%; text-transform: uppercase;"
                            />
                          </cf-vstack>
                          {/* Phase 2: Plate auto-filled by LLM extraction */}

                          <cf-vstack gap="1" style="min-width: 100px;">
                            <span style="font-size: 0.75rem; font-weight: 500;">
                              State
                            </span>
                            <cf-select
                              $value={draftPlateState}
                              items={stateSelectItems}
                            />
                          </cf-vstack>
                        </cf-hstack>

                        <cf-vstack gap="1">
                          <span style="font-size: 0.75rem; font-weight: 500;">
                            Notes (optional)
                          </span>
                          <cf-input
                            $value={draftNotes}
                            placeholder="e.g. blocked the dumpster"
                            style="width: 100%;"
                          />
                        </cf-vstack>
                      </cf-vstack>
                    </cf-card>

                    {/* Save button */}
                    <cf-button
                      variant="primary"
                      disabled={cannotSave}
                      onClick={() => submitCapture.send()}
                      style="width: 100%;"
                    >
                      Save Sighting
                    </cf-button>

                    {computed(() => {
                      const img = draftImage.get();
                      const spot = draftSpot.get();
                      if (img && spot) return null;
                      const missing: string[] = [];
                      if (!img) missing.push("a photo");
                      if (!spot) missing.push("a spot");
                      return (
                        <span style="font-size: 0.75rem; color: var(--cf-color-gray-500); text-align: center;">
                          Requires {missing.join(" and ")} to save.
                        </span>
                      );
                    })}
                  </cf-vstack>
                )
                : null}

              {/* ====== SIGHTINGS TAB ====== */}
              {isSightingsTab
                ? (
                  <cf-vstack gap="2">
                    <cf-heading level={6}>
                      Sightings ({sightingCount})
                    </cf-heading>

                    {noSightings
                      ? (
                        <cf-card>
                          <span style="color: var(--cf-color-gray-500); font-size: 0.875rem;">
                            No sightings yet. Use 📸 Capture to document a car
                            in one of your spots.
                          </span>
                        </cf-card>
                      )
                      : null}

                    {/* Phase 3: repeat offenders (plates seen 2+ times) */}
                    {hasRepeatOffenders
                      ? (
                        <cf-card style="background: #fef2f2; border: 1px solid #fecaca;">
                          <cf-vstack gap="2">
                            <cf-heading level={6}>
                              🔁 Repeat offenders
                            </cf-heading>
                            {repeatOffenders.map((g) => (
                              <cf-hstack
                                justify="between"
                                align="center"
                                gap="2"
                                wrap
                              >
                                <cf-vstack gap="0">
                                  <span style="font-weight: 600; font-family: monospace;">
                                    {g.plate} ({g.state})
                                  </span>
                                  <span style="font-size: 0.75rem; color: var(--cf-color-gray-600);">
                                    {g.description} · spots {g.spotsLabel}
                                  </span>
                                  <span style="font-size: 0.7rem; color: var(--cf-color-gray-500);">
                                    {g.firstSeen} → {g.lastSeen}
                                  </span>
                                </cf-vstack>
                                <span
                                  style={{
                                    padding: "2px 10px",
                                    borderRadius: "9999px",
                                    backgroundColor: "#991b1b",
                                    color: "white",
                                    fontSize: "0.75rem",
                                    fontWeight: "700",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {g.count}× seen
                                </span>
                              </cf-hstack>
                            ))}
                          </cf-vstack>
                        </cf-card>
                      )
                      : null}

                    {sightingRows.map((row) => {
                      const rowId = row.id;
                      // Per-row open-state booleans are derived in the
                      // `sightingRows` computed (see note there) — reading the
                      // perSession target cells in a `computed()` nested in this
                      // `.map()` does not reliably re-render.
                      const isConfirmTarget = row.isConfirmOpen;
                      const isAssignTarget = row.isAssignOpen;
                      const isGuestTarget = row.isGuestOpen;
                      return (
                        <cf-card>
                          <cf-vstack gap="2">
                            {/* Thumbnail + spot header */}
                            <cf-hstack gap="2" align="start">
                              {row.imgSrc
                                ? (
                                  <img
                                    src={row.imgSrc}
                                    style="width: 80px; height: 60px; object-fit: cover; border-radius: 6px; flex-shrink: 0;"
                                    alt="Sighting photo"
                                  />
                                )
                                : (
                                  <div style="width: 80px; height: 60px; background: var(--cf-color-gray-100); border-radius: 6px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 1.5rem;">
                                    🚗
                                  </div>
                                )}
                              <cf-vstack gap="1" style="flex: 1; min-width: 0;">
                                <cf-hstack
                                  justify="between"
                                  align="center"
                                  gap="1"
                                  wrap
                                >
                                  <span style="font-weight: 600; font-size: 0.875rem;">
                                    Spot #{row.spotNumber}
                                  </span>
                                  <cf-hstack gap="1" align="center">
                                    <span
                                      style={{
                                        display: "inline-block",
                                        padding: "2px 8px",
                                        borderRadius: "9999px",
                                        backgroundColor: row.classificationBg,
                                        color: row.classificationColor,
                                        fontSize: "0.7rem",
                                        fontWeight: "600",
                                        textTransform: "uppercase",
                                      }}
                                    >
                                      {row.classificationLabel}
                                    </span>
                                    {row.knownTag
                                      ? (
                                        <span
                                          style={{
                                            fontSize: "0.7rem",
                                            color: row.classificationColor,
                                          }}
                                        >
                                          {row.knownTag}
                                        </span>
                                      )
                                      : null}
                                  </cf-hstack>
                                  {row.isRepeat
                                    ? (
                                      <span
                                        style={{
                                          padding: "2px 8px",
                                          borderRadius: "9999px",
                                          backgroundColor: "#991b1b",
                                          color: "white",
                                          fontSize: "0.7rem",
                                          fontWeight: "700",
                                        }}
                                      >
                                        🔁 repeat
                                      </span>
                                    )
                                    : null}
                                </cf-hstack>
                                {row.description
                                  ? (
                                    <span style="font-size: 0.875rem;">
                                      {row.description}
                                    </span>
                                  )
                                  : null}
                                {row.plateDisplay
                                  ? (
                                    <span style="font-size: 0.875rem; font-family: monospace; font-weight: 500;">
                                      {row.plateDisplay}
                                    </span>
                                  )
                                  : null}
                              </cf-vstack>
                            </cf-hstack>

                            {/* Notes */}
                            {row.notes
                              ? (
                                <span style="font-size: 0.75rem; color: var(--cf-color-gray-600); font-style: italic; padding: 0.375rem 0.5rem; background: var(--cf-color-gray-50); border-radius: 4px;">
                                  {row.notes}
                                </span>
                              )
                              : null}

                            {/* Phase 3b: curation buttons for unknown plates */}
                            {row.canMark
                              ? (
                                <cf-vstack gap="1">
                                  {/* Guest flow: button → inline form */}
                                  {isGuestTarget
                                    ? (
                                      <cf-card style="border-left: 3px solid #1e40af; padding: 0.5rem;">
                                        <cf-vstack gap="2">
                                          <span style="font-size: 0.75rem; font-weight: 600;">
                                            Mark as guest
                                          </span>
                                          <cf-input
                                            $value={guestName}
                                            placeholder="Guest name (optional)"
                                            style="width: 100%;"
                                          />
                                          <cf-hstack gap="1">
                                            <cf-button
                                              variant="primary"
                                              size="sm"
                                              onClick={() => saveGuest.send()}
                                            >
                                              Save guest
                                            </cf-button>
                                            <cf-button
                                              variant="ghost"
                                              size="sm"
                                              onClick={() => cancelGuest.send()}
                                            >
                                              Cancel
                                            </cf-button>
                                          </cf-hstack>
                                        </cf-vstack>
                                      </cf-card>
                                    )
                                    : (
                                      <cf-hstack gap="1" wrap>
                                        <cf-button
                                          variant="secondary"
                                          size="sm"
                                          onClick={() =>
                                            openGuest.send({ id: rowId })}
                                        >
                                          Mark guest
                                        </cf-button>
                                        <cf-button
                                          variant="secondary"
                                          size="sm"
                                          onClick={() =>
                                            markVehicle.send({
                                              plateNumber: row.plateNumber,
                                              plateState: row.plateState,
                                              category: "offender",
                                              org: "Local Butcher Shop",
                                            })}
                                        >
                                          Mark offender
                                        </cf-button>
                                        {/* Phase 3c: admin-gate */}
                                      </cf-hstack>
                                    )}
                                </cf-vstack>
                              )
                              : null}

                            {/* Phase 3c: "assign to known person" button + inline picker */}
                            {row.canAssign
                              ? (
                                <cf-vstack gap="1">
                                  {isAssignTarget
                                    ? (
                                      <cf-card style="border-left: 3px solid #6366f1; padding: 0.5rem;">
                                        <cf-vstack gap="2">
                                          <span style="font-size: 0.75rem; font-weight: 600;">
                                            👤 Assign to person
                                          </span>
                                          {hasPeople
                                            ? (
                                              <cf-vstack gap="1">
                                                <cf-select
                                                  $value={assignPersonName}
                                                  items={peopleSelectItems}
                                                />
                                                <cf-hstack gap="1">
                                                  <cf-button
                                                    variant="primary"
                                                    size="sm"
                                                    onClick={() =>
                                                      assignToPerson.send()}
                                                  >
                                                    Add to their vehicles
                                                  </cf-button>
                                                  <cf-button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() =>
                                                      cancelAssign.send()}
                                                  >
                                                    Cancel
                                                  </cf-button>
                                                </cf-hstack>
                                              </cf-vstack>
                                            )
                                            : (
                                              <cf-hstack gap="1" align="center">
                                                <span style="font-size: 0.75rem; color: var(--cf-color-gray-500);">
                                                  Add people in Parking
                                                  Coordinator first.
                                                </span>
                                                <cf-button
                                                  variant="ghost"
                                                  size="sm"
                                                  onClick={() =>
                                                    cancelAssign.send()}
                                                >
                                                  Cancel
                                                </cf-button>
                                              </cf-hstack>
                                            )}
                                        </cf-vstack>
                                      </cf-card>
                                    )
                                    : (
                                      <cf-button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                          openAssign.send({ id: rowId })}
                                      >
                                        👤 It's a known person's car
                                      </cf-button>
                                    )}
                                </cf-vstack>
                              )
                              : null}

                            {/* Footer: reporter + time + delete */}
                            <cf-hstack justify="between" align="center" wrap>
                              <span style="font-size: 0.75rem; color: var(--cf-color-gray-500);">
                                {row.reportedBy} — {row.dateStr} {row.timeStr}
                              </span>

                              {/* Delete */}
                              {isConfirmTarget
                                ? (
                                  <cf-hstack gap="1">
                                    <span style="font-size: 0.75rem; color: #991b1b;">
                                      Delete?
                                    </span>
                                    <cf-button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() =>
                                        deleteSighting.send({ id: rowId })}
                                    >
                                      Yes
                                    </cf-button>
                                    <cf-button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => cancelDelete.send()}
                                    >
                                      No
                                    </cf-button>
                                  </cf-hstack>
                                )
                                : (
                                  <cf-button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                      initiateDelete.send({ id: rowId })}
                                  >
                                    ×
                                  </cf-button>
                                )}
                            </cf-hstack>
                          </cf-vstack>
                        </cf-card>
                      );
                    })}
                  </cf-vstack>
                )
                : null}

              {/* Phase 2: Report tab content */}
              {/* Phase 2: Classification, dedup/grouping, LLM extraction */}
              {/* Phase 2: Admin gating on delete/curation */}
              {/* Phase 2: knownVehicles registry management UI */}
            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),

      sightings,
      knownVehicles,
      people,
      captureSighting,
      deleteSighting,
      selectTab,
      markVehicle,
      removeKnownVehicle,
      openAssign,
      cancelAssign,
      assignToPerson,
      openGuest,
      cancelGuest,
      saveGuest,
    };
  },
);
