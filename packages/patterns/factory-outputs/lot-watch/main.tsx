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
import {
  normalizePlateId,
  US_STATES,
} from "../../vehicles.ts";

// ============================================================
// Domain Types (DESIGN §4)
// ============================================================

export type Classification = "ours" | "guest" | "offender" | "unknown";

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

// ============================================================
// Pattern I/O (DESIGN §12, trimmed to Phase 1)
// ============================================================

export interface LotWatchInput {
  spots?: PerSpace<SpotsCell>;
  sightings?: PerSpace<SightingsCell>;
  // Phase 2: people?: PerSpace<PeopleCell>;       — for "ours" classification
  // Phase 2: adminRegistry?: PerSpace<...>;        — for admin gating
  // Phase 2: knownVehicles?: PerSpace<...>;        — guest/offender registries
}

export interface LotWatchOutput {
  [NAME]: string;
  [UI]: VNode;
  sightings: Sighting[];
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
  ({ spots: inputSpots, sightings: inputSightings }) => {
    // ---- Cells (DESIGN §5) ----

    const spots = inputSpots ?? Writable.perSpace.of(DEFAULT_SPOTS);
    const sightings = inputSightings ??
      Writable.perSpace.of<Sighting[]>([]);

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
            description: "Color + make + model in plain words, e.g. 'white Toyota Corolla'",
          },
          plateNumber: {
            type: "string",
            description: "Plate characters only, uppercase, no spaces/dashes; '' if illegible",
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

    // ---- Pre-computed display data (avoid OpaqueCell closures in .map()) ----

    // Active spots for the spot picker
    const activeSpots = computed(() =>
      (spots.get() ?? []).filter((s) => {
        // active field may be undefined on spots from coordinator — treat as active
        const isActive = (s as ParkingSpot).active;
        return isActive === undefined || isActive === true;
      }).map((s) => ({
        spotNumber: s.spotNumber,
        label: s.label,
      }))
    );

    // Sightings in reverse-chronological order with display-ready data
    const sightingRows = computed(() => {
      // Use .map() directly on the cell array (spread `[...cell.get()]` throws
      // "not iterable" inside a computed), then reverse the resulting plain
      // array for newest-first order.
      return (sightings.get() ?? []).map((s) => {
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
        const cls = s.classification;
        return {
          id: s.id,
          spotNumber: s.spotNumber,
          description: s.description,
          plateDisplay,
          reportedBy: s.reportedBy,
          dateStr,
          timeStr,
          imgSrc,
          notes: s.notes,
          classificationLabel: cls,
          classificationColor: classificationColor(cls),
          classificationBg: classificationBg(cls),
        };
      }).reverse();
    });

    // Save is disabled until an image is captured AND a spot is chosen.
    // (Read writables with .get() and return a real boolean — referencing a
    // computed inside JSX props and negating it would coerce the cell object,
    // not its value.)
    const cannotSave = computed(() =>
      !draftImage.get() || !draftSpot.get()
    );

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
              {isCaptureTab ? (
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
                        {/* `includeData` gives the DRAFT image both `url` (blob
                            store) and inline `data` — `data` is used transiently
                            for Phase 2 LLM extraction. But we persist only the
                            lightweight `{url}` into the sighting (see
                            captureSighting): inlining the ~700KB `data` into the
                            perSpace array destabilizes its sync. Idiom per
                            photo.tsx — persist the blob `url`, not the bytes. */}
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
                    {hasDraftImage ? (
                      <cf-card style="border-left: 3px solid #6366f1;">
                        <cf-vstack gap="1">
                          <cf-heading level={6}>✨ Auto-extraction</cf-heading>
                          {extraction.pending ? (
                            <span style="font-size: 0.875rem; color: var(--cf-color-gray-500);">
                              Reading the plate…
                            </span>
                          ) : extraction.error ? (
                            <span style="font-size: 0.875rem; color: #991b1b;">
                              Couldn't read it: {extraction.error}
                            </span>
                          ) : (
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
                    ) : null}

                    {/* Spot picker */}
                    <cf-card>
                      <cf-vstack gap="2">
                        <cf-heading level={6}>Which spot?</cf-heading>
                        <cf-hstack gap="2" wrap>
                          {activeSpots.map((spot) => {
                            const spotNum = spot.spotNumber;
                            return (
                              <cf-button
                                variant={computed(() =>
                                  draftSpot.get() === spotNum
                                    ? "primary"
                                    : "secondary"
                                )}
                                onClick={() => setDraftSpot.send({ spot: spotNum })}
                              >
                                #{spotNum}
                                {spot.label
                                  ? (
                                    <span
                                      style="font-size: 0.75rem; margin-left: 4px; opacity: 0.8;"
                                    >
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
                        <span
                          style="font-size: 0.75rem; color: var(--cf-color-gray-500); text-align: center;"
                        >
                          Requires {missing.join(" and ")} to save.
                        </span>
                      );
                    })}
                </cf-vstack>
              ) : null}

              {/* ====== SIGHTINGS TAB ====== */}
              {isSightingsTab ? (
                <cf-vstack gap="2">
                    <cf-heading level={6}>
                      Sightings ({sightingCount})
                    </cf-heading>

                    {noSightings ? (
                      <cf-card>
                        <span style="color: var(--cf-color-gray-500); font-size: 0.875rem;">
                          No sightings yet. Use 📸 Capture to document a car in
                          one of your spots.
                        </span>
                      </cf-card>
                    ) : null}

                    {sightingRows.map((row) => {
                      const rowId = row.id;
                      const isConfirmTarget = computed(() =>
                        deleteConfirmTarget.get() === rowId
                      );
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
                                  <div
                                    style="width: 80px; height: 60px; background: var(--cf-color-gray-100); border-radius: 6px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 1.5rem;"
                                  >
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
                                    <span
                                      style="font-size: 0.875rem; font-family: monospace; font-weight: 500;"
                                    >
                                      {row.plateDisplay}
                                    </span>
                                  )
                                  : null}
                              </cf-vstack>
                            </cf-hstack>

                            {/* Notes */}
                            {row.notes
                              ? (
                                <span
                                  style="font-size: 0.75rem; color: var(--cf-color-gray-600); font-style: italic; padding: 0.375rem 0.5rem; background: var(--cf-color-gray-50); border-radius: 4px;"
                                >
                                  {row.notes}
                                </span>
                              )
                              : null}

                            {/* Footer: reporter + time + delete */}
                            <cf-hstack justify="between" align="center" wrap>
                              <span
                                style="font-size: 0.75rem; color: var(--cf-color-gray-500);"
                              >
                                {row.reportedBy} — {row.dateStr} {row.timeStr}
                              </span>

                              {/* Delete */}
                              {isConfirmTarget ? (
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
                              ) : (
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
              ) : null}

              {/* Phase 2: Report tab content */}
              {/* Phase 2: Classification, dedup/grouping, LLM extraction */}
              {/* Phase 2: Admin gating on delete/curation */}
              {/* Phase 2: knownVehicles registry management UI */}

            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),

      sightings,
      captureSighting,
      deleteSighting,
      selectTab,
    };
  },
);
