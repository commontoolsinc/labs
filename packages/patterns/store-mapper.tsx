/// <cts-enable />
/**
 * Store Mapper Pattern
 *
 * Captures grocery store layouts through:
 * - Manual aisle entry with descriptions
 * - Perimeter department positioning
 * - Entrance marking
 * - Item location corrections for future reference
 *
 * The generated store data is used by Shopping List for AI-powered aisle sorting.
 */
import {
  computed,
  Default,
  derive,
  equals,
  generateObject,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";

// Types for store layout
type WallPosition =
  | "front-left"
  | "front-center"
  | "front-right"
  | "back-left"
  | "back-center"
  | "back-right"
  | "left-front"
  | "left-center"
  | "left-back"
  | "right-front"
  | "right-center"
  | "right-back"
  | "unassigned"
  | "not-in-store"
  | "in-center-aisle";

interface Aisle {
  name: string; // Just the number, e.g., "1", "2", "5A"
  description: Default<string, "">;
}

interface Department {
  name: string;
  icon: string;
  location: Default<WallPosition, "unassigned">;
  description: Default<string, "">;
}

interface Entrance {
  position: WallPosition;
}

interface ItemLocation {
  itemName: string;
  correctAisle: string;
  incorrectAisle: Default<string, "">;
  timestamp: number;
}

interface Input {
  storeName: Writable<Default<string, "My Store">>;
  aisles: Writable<Default<Aisle[], []>>;
  departments: Writable<Default<Department[], []>>;
  entrances: Writable<Default<Entrance[], []>>;
  itemLocations: Writable<Default<ItemLocation[], []>>;
}

interface Output {
  storeName: string;
  aisles: Aisle[];
  departments: Department[];
  entrances: Entrance[];
  itemLocations: ItemLocation[];
  outline: string;
  aisleCount: number;
  deptCount: number;
  correctionCount: number;
}

// Type for position grouping in visual map (must be at module scope for pattern compiler)
type ItemsByPos = Record<
  string,
  { depts: Department[]; entrances: Entrance[] }
>;

// Types for AI photo-based aisle import
interface ImageData {
  id: string;
  name: string;
  url?: string; // data URL (preferred)
  data?: string; // data URL (for compatibility)
}

interface ExtractedAisle {
  name: string;
  products: string[];
}

// Default departments to load
const DEFAULT_DEPARTMENTS: Array<{ name: string; icon: string }> = [
  { name: "Bakery", icon: "🥖" },
  { name: "Deli", icon: "🥪" },
  { name: "Produce", icon: "🥬" },
  { name: "Dairy", icon: "🥛" },
  { name: "Frozen Foods", icon: "🧊" },
  { name: "Meat & Seafood", icon: "🥩" },
  { name: "Pharmacy", icon: "💊" },
];

// Handlers
const addAisle = handler<
  { detail: { message: string } },
  { aisles: Writable<Aisle[]> }
>(({ detail }, { aisles }) => {
  const name = detail?.message?.trim();
  if (!name) return;

  // Check for duplicate aisle
  const existing = aisles.get();
  if (existing.some((a) => a.name === name)) return;

  aisles.push({
    name,
    description: "",
  });
});

const removeAisle = handler<
  unknown,
  { aisles: Writable<Aisle[]>; aisle: Aisle }
>((_event, { aisles, aisle }) => {
  const current = aisles.get();
  const index = current.findIndex((el) => equals(aisle, el));
  if (index >= 0) {
    aisles.set(current.toSpliced(index, 1));
  }
});

// Entrance handlers
const addEntrance = handler<
  unknown,
  { entrances: Writable<Entrance[]>; position: WallPosition }
>((_event, { entrances, position }) => {
  const current = entrances.get();
  // Don't add duplicate entrances at same position
  if (current.some((e) => e.position === position)) return;
  entrances.push({ position });
});

const removeEntrance = handler<
  unknown,
  { entrances: Writable<Entrance[]>; entrance: Entrance }
>((_event, { entrances, entrance }) => {
  const current = entrances.get();
  const index = current.findIndex((el) => equals(entrance, el));
  if (index >= 0) {
    entrances.set(current.toSpliced(index, 1));
  }
});

// Department location handler
const setDepartmentLocation = handler<
  unknown,
  {
    departments: Writable<Department[]>;
    dept: Department;
    location: WallPosition;
  }
>((_event, { departments, dept, location }) => {
  const current = departments.get();
  const index = current.findIndex((el) => equals(dept, el));
  if (index >= 0) {
    departments.set(
      current.toSpliced(index, 1, { ...current[index], location }),
    );
  }
});

// Handlers for AI photo import
const addExtractedAisle = handler<
  unknown,
  { aisles: Writable<Aisle[]>; extracted: ExtractedAisle }
>((_event, { aisles, extracted }) => {
  const current = aisles.get() || [];
  const exists = current.some(
    (a: Aisle) => a.name.toLowerCase() === extracted.name.toLowerCase(),
  );
  if (!exists) {
    aisles.push({
      name: extracted.name,
      description: (extracted.products || []).map((p: string) => `- ${p}`).join(
        "\n",
      ),
    });
  }
});

const addAllExtractedAisles = handler<
  unknown,
  {
    aisles: Writable<Aisle[]>;
    extractedList: ExtractedAisle[];
    hiddenPhotoIds: Writable<string[]>;
    photoId: string;
  }
>((_event, { aisles, extractedList, hiddenPhotoIds, photoId }) => {
  const current = aisles.get() || [];
  const existingNames = new Set(
    current.map((a: Aisle) => a.name.toLowerCase()),
  );
  const newAisles = extractedList
    .filter((e) => !existingNames.has(e.name.toLowerCase()))
    .map((e) => ({
      name: e.name,
      description: (e.products || []).map((p) => `- ${p}`).join("\n"),
    }));
  aisles.set([...current, ...newAisles]);
  // Hide the photo after adding
  const currentHidden = hiddenPhotoIds.get();
  if (!currentHidden.includes(photoId)) {
    hiddenPhotoIds.set([...currentHidden, photoId]);
  }
});

const mergeExtractedAisle = handler<
  unknown,
  { aisles: Writable<Aisle[]>; extracted: ExtractedAisle }
>((_event, { aisles, extracted }) => {
  const current = aisles.get() || [];
  const idx = current.findIndex(
    (a: Aisle) => a.name.toLowerCase() === extracted.name.toLowerCase(),
  );
  if (idx >= 0) {
    const existing = current[idx];
    const existingItems = (existing.description || "")
      .split("\n")
      .map((l) => l.replace(/^-\s*/, "").trim().toLowerCase())
      .filter(Boolean);
    const newProducts = (extracted.products || []).filter(
      (p) => !existingItems.includes(p.toLowerCase()),
    );
    if (newProducts.length > 0) {
      const newDesc = existing.description
        ? existing.description + "\n" +
          newProducts.map((p) => `- ${p}`).join("\n")
        : newProducts.map((p) => `- ${p}`).join("\n");
      aisles.set(
        current.toSpliced(idx, 1, { ...existing, description: newDesc }),
      );
    }
  }
});

const hidePhoto = handler<
  unknown,
  { hiddenPhotoIds: Writable<string[]>; photoId: string }
>((_event, { hiddenPhotoIds, photoId }) => {
  const current = hiddenPhotoIds.get() || [];
  if (!current.includes(photoId)) {
    hiddenPhotoIds.set([...current, photoId]);
  }
});

export default pattern<Input, Output>(
  ({ storeName, aisles, departments, entrances, itemLocations }) => {
    // Pre-load default departments if empty (using computed to safely access reactive value)
    const _initDepts = computed(() => {
      const current = departments.get();
      if (current.length === 0) {
        // Schedule the set for next tick to avoid reactive cycle
        queueMicrotask(() => {
          departments.set(
            DEFAULT_DEPARTMENTS.map((d) => ({
              ...d,
              location: "unassigned" as const,
              description: "",
            })),
          );
        });
      }
      return true;
    });
    // Force evaluation of the computed
    void _initDepts;

    // UI state
    const currentSection = Writable.of<
      "map" | "aisles" | "departments" | "corrections" | "outline"
    >("map");
    const newCorrectionItem = Writable.of("");
    const newCorrectionAisle = Writable.of("");

    // Photo import state
    const uploadedPhotos = Writable.of<ImageData[]>([]);
    const hiddenPhotoIds = Writable.of<string[]>([]);

    // Process uploaded photos with AI
    // Note: Photos are NOT auto-deleted after "Add All" to prevent the photo extraction
    // reset bug. When uploadedPhotos array changes, this .map() re-evaluates and creates
    // new generateObject calls, resetting all photos to "Analyzing...". Users can manually
    // delete photos using the delete button.
    const photoExtractions = uploadedPhotos.map((photo) => {
      const extraction = generateObject({
        system:
          'You are analyzing photos from a grocery store. Your task is to extract ALL visible aisle signs and return them as JSON.\n\nIMPORTANT: You MUST return a JSON object with an "aisles" array, even if you only see one aisle or partial information.\n\nFor each aisle sign you see:\n- Extract ONLY the aisle number (e.g., "8", "12", "5A", "5B") - DO NOT include the word "Aisle"\n- Extract each product category as a separate item in the products array\n- Include partially visible signs - do your best to read them\n\nExample output:\n{\n  "aisles": [\n    {"name": "8", "products": ["Bread", "Cereal", "Coffee"]},\n    {"name": "9", "products": ["Snacks", "Chips"]}\n  ]\n}',
        prompt: derive(photo, (p) => {
          // Safety check: photo might be undefined after deletion
          if (!p || !p.data) return [];
          return [
            { type: "image" as const, image: p.data },
            {
              type: "text" as const,
              text:
                "Look at this grocery store photo and extract ALL aisle signs you can see. Return a JSON object with an 'aisles' array containing objects with 'name' (just the number like '5' or '5A', NOT 'Aisle 5') and 'products' (array of strings) fields. Each product category should be a separate item in the products array. Read any text on hanging signs, endcaps, or aisle markers.",
            },
          ];
        }),
        schema: {
          type: "object",
          properties: {
            aisles: {
              type: "array",
              description: "List of aisles detected in the photo",
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description:
                      "Aisle number only (e.g., '8', '5A', '12') - do NOT include the word 'Aisle'",
                  },
                  products: {
                    type: "array",
                    description: "Array of product categories in this aisle",
                    items: {
                      type: "string",
                    },
                  },
                },
              },
            },
          },
        },
        model: "anthropic:claude-sonnet-4-5",
      });

      return {
        photo,
        photoName: photo.name,
        extractedAisles: derive(
          extraction.result,
          (result: { aisles?: ExtractedAisle[] } | null) => ({
            aisles: (result && result.aisles) || [],
          }),
        ),
        pending: extraction.pending,
        error: extraction.error,
      };
    });

    // Sorted aisles (natural numeric order)
    const sortedAisles = derive(aisles, (aisleList: Aisle[]) => {
      return [...aisleList].sort((a, b) => {
        const numA = parseInt(a.name.match(/^\d+/)?.[0] || "999", 10);
        const numB = parseInt(b.name.match(/^\d+/)?.[0] || "999", 10);
        if (numA !== numB) return numA - numB;
        return a.name.localeCompare(b.name);
      });
    });

    // Generate markdown outline
    const outline = computed(() => {
      const aislesSorted = [...aisles.get()].sort((a, b) => {
        const numA = parseInt(a.name.match(/^\d+/)?.[0] || "999", 10);
        const numB = parseInt(b.name.match(/^\d+/)?.[0] || "999", 10);
        if (numA !== numB) return numA - numB;
        return a.name.localeCompare(b.name);
      });
      const depts = departments.get();
      const corrections = itemLocations.get();
      const lines: string[] = [];

      // Aisles
      for (const aisle of aislesSorted) {
        const knownItems = corrections
          .filter((c) => c.correctAisle === `Aisle ${aisle.name}`)
          .map((c) => c.itemName);
        const knownStr = knownItems.length > 0
          ? ` (Known items: ${knownItems.join(", ")})`
          : "";
        lines.push(`# Aisle ${aisle.name}${knownStr}`);
        lines.push(aisle.description || "(no description)");
        lines.push("");
      }

      // Departments with locations
      const assignedDepts = depts.filter(
        (d) =>
          d.location !== "unassigned" &&
          d.location !== "not-in-store" &&
          d.location !== "in-center-aisle",
      );
      for (const dept of assignedDepts) {
        const locStr = dept.location.replace("-", " ");
        const knownItems = corrections
          .filter((c) => c.correctAisle === dept.name)
          .map((c) => c.itemName);
        const knownStr = knownItems.length > 0
          ? ` (Known items: ${knownItems.join(", ")})`
          : "";
        lines.push(`# ${dept.name} (${locStr})${knownStr}`);
        lines.push(dept.description || "(no description)");
        lines.push("");
      }

      return lines.join("\n");
    });

    // Counts for reactive arrays
    const aisleCount = computed(() => aisles.get().length);
    const deptCount = computed(() => departments.get().length);
    const correctionCount = computed(() => itemLocations.get().length);
    const entranceCount = computed(() => entrances.get().length);

    // Group departments and entrances by position for the visual map
    const itemsByPosition = computed((): ItemsByPos => {
      const byPos: ItemsByPos = {};
      // Add departments
      for (const dept of departments.get()) {
        if (
          dept.location && dept.location !== "unassigned" &&
          dept.location !== "not-in-store" &&
          dept.location !== "in-center-aisle"
        ) {
          if (!byPos[dept.location]) {
            byPos[dept.location] = { depts: [], entrances: [] };
          }
          byPos[dept.location].depts.push(dept);
        }
      }
      // Add entrances
      for (const entrance of entrances.get()) {
        if (!byPos[entrance.position]) {
          byPos[entrance.position] = { depts: [], entrances: [] };
        }
        byPos[entrance.position].entrances.push(entrance);
      }
      return byPos;
    });

    // Pre-compute entrance positions for button states (use Record instead of Set for JSON-serializable)
    const entrancePositions = computed(() => {
      const positions: Record<string, boolean> = {};
      for (const e of entrances.get()) {
        positions[e.position] = true;
      }
      return positions;
    });

    // Gap detection for aisles
    const detectedGaps = derive(aisles, (aisleList: Aisle[]) => {
      const numbers = aisleList
        .map((a) => parseInt(a.name.match(/^\d+/)?.[0] || "", 10))
        .filter((n) => !isNaN(n))
        .sort((a, b) => a - b);

      const gaps: number[] = [];
      for (let i = 1; i < numbers.length; i++) {
        // Push all missing numbers in the gap, not just the first one
        for (
          let missing = numbers[i - 1] + 1;
          missing < numbers[i];
          missing++
        ) {
          gaps.push(missing);
        }
      }
      return gaps;
    });

    return {
      [NAME]: storeName,
      [UI]: (
        <ct-screen>
          {/* Header */}
          <div
            slot="header"
            style={{
              background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
              borderRadius: "8px",
              padding: "1rem",
              color: "white",
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}
          >
            <ct-hstack justify="between" align="center">
              <ct-hstack gap="2" align="center">
                <span style={{ fontSize: "1.5rem" }}>🗺️</span>
                <ct-input
                  $value={storeName}
                  placeholder="Store name..."
                  customStyle="font-size: 1.25rem; font-weight: bold; background: transparent; border: none; color: white;"
                />
              </ct-hstack>
            </ct-hstack>
            <div
              style={{
                fontSize: "13px",
                opacity: 0.9,
                marginTop: "0.5rem",
              }}
            >
              {computed(() =>
                `${aisleCount} aisles • ${deptCount} departments • ${entranceCount} entrances`
              )}
            </div>
          </div>

          {/* Navigation tabs */}
          <ct-tabs $value={currentSection}>
            <ct-tab-list>
              <ct-tab value="map">Map</ct-tab>
              <ct-tab value="aisles">Aisles</ct-tab>
              <ct-tab value="departments">Depts</ct-tab>
              <ct-tab value="corrections">Fixes</ct-tab>
              <ct-tab value="outline">Outline</ct-tab>
            </ct-tab-list>

            {/* MAP SECTION */}
            <ct-tab-panel value="map">
              <ct-vscroll flex showScrollbar fadeEdges>
                <ct-vstack gap="3" style="padding: 1rem; max-width: 800px;">
                  {/* CSS for store map */}
                  <style>
                    {`
                    .store-map {
                      display: grid;
                      grid-template-columns: 60px 1fr 60px;
                      grid-template-rows: 60px 140px 60px;
                      gap: 0;
                      width: 100%;
                      max-width: 400px;
                      height: 260px;
                      border: 3px solid #374151;
                      border-radius: 8px;
                      overflow: hidden;
                      background: transparent;
                      margin: 0 auto;
                    }
                    .store-map-corner {
                      background: #d1d5db;
                      width: 100%;
                      height: 100%;
                    }
                    .store-map-corner-tl { background: linear-gradient(to bottom left, #fed7aa 50%, #bbf7d0 50%); }
                    .store-map-corner-tr { background: linear-gradient(to bottom right, #fed7aa 50%, #e9d5ff 50%); }
                    .store-map-corner-bl { background: linear-gradient(to top left, #dbeafe 50%, #bbf7d0 50%); }
                    .store-map-corner-br { background: linear-gradient(to top right, #dbeafe 50%, #e9d5ff 50%); }
                    .store-map-wall {
                      display: flex;
                      padding: 4px;
                      gap: 2px;
                      overflow: hidden;
                      width: 100%;
                      height: 100%;
                    }
                    .store-map-wall-horizontal { flex-direction: row; }
                    .store-map-wall-vertical { flex-direction: column; }
                    .store-map-wall-front { grid-column: 2; grid-row: 3; background: #dbeafe; }
                    .store-map-wall-back { grid-column: 2; grid-row: 1; background: #fed7aa; }
                    .store-map-wall-left { grid-column: 1; grid-row: 2; background: #bbf7d0; }
                    .store-map-wall-right { grid-column: 3; grid-row: 2; background: #e9d5ff; }
                    .store-map-slot {
                      flex: 1;
                      display: flex;
                      justify-content: center;
                      align-items: center;
                      min-width: 0;
                      min-height: 0;
                      gap: 2px;
                      flex-wrap: wrap;
                    }
                    .store-map-entrance-slot {
                      background: #374151;
                      border-radius: 2px;
                    }
                    .store-map-center {
                      grid-column: 2;
                      grid-row: 2;
                      background: #f9fafb;
                      display: flex;
                      flex-direction: column;
                      align-items: center;
                      justify-content: center;
                      color: #6b7280;
                      font-size: 14px;
                    }
                    .store-map-badge {
                      font-size: 24px;
                      cursor: default;
                    }
                    .store-map-entrance {
                      font-size: 20px;
                      cursor: default;
                    }
                    .wall-btn-front::part(button) {
                      background-color: #eff6ff;
                      color: #1e40af;
                      border-color: #3b82f6;
                    }
                    .wall-btn-back::part(button) {
                      background-color: #fff7ed;
                      color: #c2410c;
                      border-color: #f97316;
                    }
                    .wall-btn-left::part(button) {
                      background-color: #f0fdf4;
                      color: #047857;
                      border-color: #10b981;
                    }
                    .wall-btn-right::part(button) {
                      background-color: #faf5ff;
                      color: #7e22ce;
                      border-color: #a855f7;
                    }
                  `}
                  </style>

                  {/* Visual Store Map */}
                  <ct-card>
                    <ct-vstack gap="2">
                      <span style={{ fontWeight: 600, fontSize: "16px" }}>
                        🏪 Store Layout
                      </span>
                      <div className="store-map">
                        {/* Corners */}
                        <div
                          className="store-map-corner store-map-corner-tl"
                          style={{ gridColumn: 1, gridRow: 1 }}
                        />
                        <div
                          className="store-map-corner store-map-corner-tr"
                          style={{ gridColumn: 3, gridRow: 1 }}
                        />
                        <div
                          className="store-map-corner store-map-corner-bl"
                          style={{ gridColumn: 1, gridRow: 3 }}
                        />
                        <div
                          className="store-map-corner store-map-corner-br"
                          style={{ gridColumn: 3, gridRow: 3 }}
                        />

                        {/* Back wall (top - orange) */}
                        <div className="store-map-wall store-map-wall-horizontal store-map-wall-back">
                          {derive(itemsByPosition, (items: ItemsByPos) => {
                            const hasBL =
                              (items["back-left"]?.entrances || []).length > 0;
                            const hasBC =
                              (items["back-center"]?.entrances || []).length >
                                0;
                            const hasBR =
                              (items["back-right"]?.entrances || []).length > 0;
                            return (
                              <>
                                <div
                                  className={`store-map-slot${
                                    hasBL ? " store-map-entrance-slot" : ""
                                  }`}
                                >
                                  {(items["back-left"]?.entrances || []).map(
                                    () => (
                                      <span
                                        className="store-map-entrance"
                                        title="Entrance"
                                      >
                                        🚪
                                      </span>
                                    ),
                                  )}
                                  {(items["back-left"]?.depts || []).map((
                                    d,
                                  ) => (
                                    <span
                                      className="store-map-badge"
                                      title={d.name}
                                    >
                                      {d.icon}
                                    </span>
                                  ))}
                                </div>
                                <div
                                  className={`store-map-slot${
                                    hasBC ? " store-map-entrance-slot" : ""
                                  }`}
                                >
                                  {(items["back-center"]?.entrances || []).map(
                                    () => (
                                      <span
                                        className="store-map-entrance"
                                        title="Entrance"
                                      >
                                        🚪
                                      </span>
                                    ),
                                  )}
                                  {(items["back-center"]?.depts || []).map((
                                    d,
                                  ) => (
                                    <span
                                      className="store-map-badge"
                                      title={d.name}
                                    >
                                      {d.icon}
                                    </span>
                                  ))}
                                </div>
                                <div
                                  className={`store-map-slot${
                                    hasBR ? " store-map-entrance-slot" : ""
                                  }`}
                                >
                                  {(items["back-right"]?.entrances || []).map(
                                    () => (
                                      <span
                                        className="store-map-entrance"
                                        title="Entrance"
                                      >
                                        🚪
                                      </span>
                                    ),
                                  )}
                                  {(items["back-right"]?.depts || []).map((
                                    d,
                                  ) => (
                                    <span
                                      className="store-map-badge"
                                      title={d.name}
                                    >
                                      {d.icon}
                                    </span>
                                  ))}
                                </div>
                              </>
                            );
                          })}
                        </div>

                        {/* Left wall (green) */}
                        <div className="store-map-wall store-map-wall-vertical store-map-wall-left">
                          {derive(itemsByPosition, (items: ItemsByPos) => {
                            const hasLB =
                              (items["left-back"]?.entrances || []).length > 0;
                            const hasLC =
                              (items["left-center"]?.entrances || []).length >
                                0;
                            const hasLF =
                              (items["left-front"]?.entrances || []).length > 0;
                            return (
                              <>
                                <div
                                  className={`store-map-slot${
                                    hasLB ? " store-map-entrance-slot" : ""
                                  }`}
                                >
                                  {(items["left-back"]?.entrances || []).map(
                                    () => (
                                      <span
                                        className="store-map-entrance"
                                        title="Entrance"
                                      >
                                        🚪
                                      </span>
                                    ),
                                  )}
                                  {(items["left-back"]?.depts || []).map((
                                    d,
                                  ) => (
                                    <span
                                      className="store-map-badge"
                                      title={d.name}
                                    >
                                      {d.icon}
                                    </span>
                                  ))}
                                </div>
                                <div
                                  className={`store-map-slot${
                                    hasLC ? " store-map-entrance-slot" : ""
                                  }`}
                                >
                                  {(items["left-center"]?.entrances || []).map(
                                    () => (
                                      <span
                                        className="store-map-entrance"
                                        title="Entrance"
                                      >
                                        🚪
                                      </span>
                                    ),
                                  )}
                                  {(items["left-center"]?.depts || []).map((
                                    d,
                                  ) => (
                                    <span
                                      className="store-map-badge"
                                      title={d.name}
                                    >
                                      {d.icon}
                                    </span>
                                  ))}
                                </div>
                                <div
                                  className={`store-map-slot${
                                    hasLF ? " store-map-entrance-slot" : ""
                                  }`}
                                >
                                  {(items["left-front"]?.entrances || []).map(
                                    () => (
                                      <span
                                        className="store-map-entrance"
                                        title="Entrance"
                                      >
                                        🚪
                                      </span>
                                    ),
                                  )}
                                  {(items["left-front"]?.depts || []).map((
                                    d,
                                  ) => (
                                    <span
                                      className="store-map-badge"
                                      title={d.name}
                                    >
                                      {d.icon}
                                    </span>
                                  ))}
                                </div>
                              </>
                            );
                          })}
                        </div>

                        {/* Center */}
                        <div className="store-map-center">
                          <div style={{ fontWeight: 500 }}>Aisles</div>
                          <div>{aisleCount}</div>
                        </div>

                        {/* Right wall (purple) */}
                        <div className="store-map-wall store-map-wall-vertical store-map-wall-right">
                          {derive(itemsByPosition, (items: ItemsByPos) => {
                            const hasRB =
                              (items["right-back"]?.entrances || []).length > 0;
                            const hasRC =
                              (items["right-center"]?.entrances || []).length >
                                0;
                            const hasRF =
                              (items["right-front"]?.entrances || []).length >
                                0;
                            return (
                              <>
                                <div
                                  className={`store-map-slot${
                                    hasRB ? " store-map-entrance-slot" : ""
                                  }`}
                                >
                                  {(items["right-back"]?.entrances || []).map(
                                    () => (
                                      <span
                                        className="store-map-entrance"
                                        title="Entrance"
                                      >
                                        🚪
                                      </span>
                                    ),
                                  )}
                                  {(items["right-back"]?.depts || []).map((
                                    d,
                                  ) => (
                                    <span
                                      className="store-map-badge"
                                      title={d.name}
                                    >
                                      {d.icon}
                                    </span>
                                  ))}
                                </div>
                                <div
                                  className={`store-map-slot${
                                    hasRC ? " store-map-entrance-slot" : ""
                                  }`}
                                >
                                  {(items["right-center"]?.entrances || []).map(
                                    () => (
                                      <span
                                        className="store-map-entrance"
                                        title="Entrance"
                                      >
                                        🚪
                                      </span>
                                    ),
                                  )}
                                  {(items["right-center"]?.depts || []).map((
                                    d,
                                  ) => (
                                    <span
                                      className="store-map-badge"
                                      title={d.name}
                                    >
                                      {d.icon}
                                    </span>
                                  ))}
                                </div>
                                <div
                                  className={`store-map-slot${
                                    hasRF ? " store-map-entrance-slot" : ""
                                  }`}
                                >
                                  {(items["right-front"]?.entrances || []).map(
                                    () => (
                                      <span
                                        className="store-map-entrance"
                                        title="Entrance"
                                      >
                                        🚪
                                      </span>
                                    ),
                                  )}
                                  {(items["right-front"]?.depts || []).map((
                                    d,
                                  ) => (
                                    <span
                                      className="store-map-badge"
                                      title={d.name}
                                    >
                                      {d.icon}
                                    </span>
                                  ))}
                                </div>
                              </>
                            );
                          })}
                        </div>

                        {/* Front wall (bottom - blue) */}
                        <div className="store-map-wall store-map-wall-horizontal store-map-wall-front">
                          {derive(itemsByPosition, (items: ItemsByPos) => {
                            const hasFL =
                              (items["front-left"]?.entrances || []).length > 0;
                            const hasFC =
                              (items["front-center"]?.entrances || []).length >
                                0;
                            const hasFR =
                              (items["front-right"]?.entrances || []).length >
                                0;
                            return (
                              <>
                                <div
                                  className={`store-map-slot${
                                    hasFL ? " store-map-entrance-slot" : ""
                                  }`}
                                >
                                  {(items["front-left"]?.entrances || []).map(
                                    () => (
                                      <span
                                        className="store-map-entrance"
                                        title="Entrance"
                                      >
                                        🚪
                                      </span>
                                    ),
                                  )}
                                  {(items["front-left"]?.depts || []).map((
                                    d,
                                  ) => (
                                    <span
                                      className="store-map-badge"
                                      title={d.name}
                                    >
                                      {d.icon}
                                    </span>
                                  ))}
                                </div>
                                <div
                                  className={`store-map-slot${
                                    hasFC ? " store-map-entrance-slot" : ""
                                  }`}
                                >
                                  {(items["front-center"]?.entrances || []).map(
                                    () => (
                                      <span
                                        className="store-map-entrance"
                                        title="Entrance"
                                      >
                                        🚪
                                      </span>
                                    ),
                                  )}
                                  {(items["front-center"]?.depts || []).map((
                                    d,
                                  ) => (
                                    <span
                                      className="store-map-badge"
                                      title={d.name}
                                    >
                                      {d.icon}
                                    </span>
                                  ))}
                                </div>
                                <div
                                  className={`store-map-slot${
                                    hasFR ? " store-map-entrance-slot" : ""
                                  }`}
                                >
                                  {(items["front-right"]?.entrances || []).map(
                                    () => (
                                      <span
                                        className="store-map-entrance"
                                        title="Entrance"
                                      >
                                        🚪
                                      </span>
                                    ),
                                  )}
                                  {(items["front-right"]?.depts || []).map((
                                    d,
                                  ) => (
                                    <span
                                      className="store-map-badge"
                                      title={d.name}
                                    >
                                      {d.icon}
                                    </span>
                                  ))}
                                </div>
                              </>
                            );
                          })}
                        </div>
                      </div>
                      <div
                        style={{
                          textAlign: "center",
                          fontSize: "12px",
                          color: "var(--ct-color-gray-500)",
                        }}
                      >
                        <span style={{ color: "#3b82f6" }}>■</span>{" "}
                        Front (entrance){" "}
                        <span style={{ color: "#f97316" }}>■</span> Back{" "}
                        <span style={{ color: "#10b981" }}>■</span> Left{" "}
                        <span style={{ color: "#a855f7" }}>■</span> Right
                      </div>
                    </ct-vstack>
                  </ct-card>

                  {/* Add Entrances Section */}
                  <ct-card style="background: #fef3c7; border: 1px solid #fbbf24;">
                    <ct-vstack gap="2">
                      <span style={{ fontWeight: 600, color: "#92400e" }}>
                        🚪 Mark Store Entrances
                      </span>
                      <div
                        style={{
                          fontSize: "13px",
                          color: "#78350f",
                        }}
                      >
                        Click to add entrances:
                      </div>

                      {/* Front wall buttons */}
                      <div
                        style={{
                          display: "flex",
                          gap: "6px",
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        <span
                          style={{
                            width: "60px",
                            fontSize: "12px",
                            fontWeight: 600,
                            color: "#3b82f6",
                          }}
                        >
                          Front:
                        </span>
                        <ct-button
                          size="sm"
                          variant="outline"
                          className="wall-btn-front"
                          disabled={derive(
                            entrancePositions,
                            (p: Record<string, boolean>) => !!p["front-left"],
                          )}
                          onClick={addEntrance({
                            entrances,
                            position: "front-left",
                          })}
                        >
                          Left
                        </ct-button>
                        <ct-button
                          size="sm"
                          variant="outline"
                          className="wall-btn-front"
                          disabled={derive(
                            entrancePositions,
                            (p: Record<string, boolean>) => !!p["front-center"],
                          )}
                          onClick={addEntrance({
                            entrances,
                            position: "front-center",
                          })}
                        >
                          Center
                        </ct-button>
                        <ct-button
                          size="sm"
                          variant="outline"
                          className="wall-btn-front"
                          disabled={derive(
                            entrancePositions,
                            (p: Record<string, boolean>) => !!p["front-right"],
                          )}
                          onClick={addEntrance({
                            entrances,
                            position: "front-right",
                          })}
                        >
                          Right
                        </ct-button>
                      </div>

                      {/* Back wall buttons */}
                      <div
                        style={{
                          display: "flex",
                          gap: "6px",
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        <span
                          style={{
                            width: "60px",
                            fontSize: "12px",
                            fontWeight: 600,
                            color: "#f97316",
                          }}
                        >
                          Back:
                        </span>
                        <ct-button
                          size="sm"
                          variant="outline"
                          className="wall-btn-back"
                          disabled={derive(
                            entrancePositions,
                            (p: Record<string, boolean>) => !!p["back-left"],
                          )}
                          onClick={addEntrance({
                            entrances,
                            position: "back-left",
                          })}
                        >
                          Left
                        </ct-button>
                        <ct-button
                          size="sm"
                          variant="outline"
                          className="wall-btn-back"
                          disabled={derive(
                            entrancePositions,
                            (p: Record<string, boolean>) => !!p["back-center"],
                          )}
                          onClick={addEntrance({
                            entrances,
                            position: "back-center",
                          })}
                        >
                          Center
                        </ct-button>
                        <ct-button
                          size="sm"
                          variant="outline"
                          className="wall-btn-back"
                          disabled={derive(
                            entrancePositions,
                            (p: Record<string, boolean>) => !!p["back-right"],
                          )}
                          onClick={addEntrance({
                            entrances,
                            position: "back-right",
                          })}
                        >
                          Right
                        </ct-button>
                      </div>

                      {/* Left wall buttons */}
                      <div
                        style={{
                          display: "flex",
                          gap: "6px",
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        <span
                          style={{
                            width: "60px",
                            fontSize: "12px",
                            fontWeight: 600,
                            color: "#10b981",
                          }}
                        >
                          Left:
                        </span>
                        <ct-button
                          size="sm"
                          variant="outline"
                          className="wall-btn-left"
                          disabled={derive(
                            entrancePositions,
                            (p: Record<string, boolean>) => !!p["left-front"],
                          )}
                          onClick={addEntrance({
                            entrances,
                            position: "left-front",
                          })}
                        >
                          Front
                        </ct-button>
                        <ct-button
                          size="sm"
                          variant="outline"
                          className="wall-btn-left"
                          disabled={derive(
                            entrancePositions,
                            (p: Record<string, boolean>) => !!p["left-center"],
                          )}
                          onClick={addEntrance({
                            entrances,
                            position: "left-center",
                          })}
                        >
                          Center
                        </ct-button>
                        <ct-button
                          size="sm"
                          variant="outline"
                          className="wall-btn-left"
                          disabled={derive(
                            entrancePositions,
                            (p: Record<string, boolean>) => !!p["left-back"],
                          )}
                          onClick={addEntrance({
                            entrances,
                            position: "left-back",
                          })}
                        >
                          Back
                        </ct-button>
                      </div>

                      {/* Right wall buttons */}
                      <div
                        style={{
                          display: "flex",
                          gap: "6px",
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        <span
                          style={{
                            width: "60px",
                            fontSize: "12px",
                            fontWeight: 600,
                            color: "#a855f7",
                          }}
                        >
                          Right:
                        </span>
                        <ct-button
                          size="sm"
                          variant="outline"
                          className="wall-btn-right"
                          disabled={derive(
                            entrancePositions,
                            (p: Record<string, boolean>) => !!p["right-front"],
                          )}
                          onClick={addEntrance({
                            entrances,
                            position: "right-front",
                          })}
                        >
                          Front
                        </ct-button>
                        <ct-button
                          size="sm"
                          variant="outline"
                          className="wall-btn-right"
                          disabled={derive(
                            entrancePositions,
                            (p: Record<string, boolean>) => !!p["right-center"],
                          )}
                          onClick={addEntrance({
                            entrances,
                            position: "right-center",
                          })}
                        >
                          Center
                        </ct-button>
                        <ct-button
                          size="sm"
                          variant="outline"
                          className="wall-btn-right"
                          disabled={derive(
                            entrancePositions,
                            (p: Record<string, boolean>) => !!p["right-back"],
                          )}
                          onClick={addEntrance({
                            entrances,
                            position: "right-back",
                          })}
                        >
                          Back
                        </ct-button>
                      </div>

                      {/* Show added entrances */}
                      {ifElse(
                        derive(entranceCount, (c: number) => c > 0),
                        <div style={{ marginTop: "0.5rem" }}>
                          <span
                            style={{
                              fontSize: "12px",
                              fontWeight: 600,
                              color: "#92400e",
                            }}
                          >
                            Added ({entranceCount}):
                          </span>
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: "0.5rem",
                              marginTop: "0.5rem",
                            }}
                          >
                            {entrances.map((entrance) => (
                              <div
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "0.25rem",
                                  padding: "4px 8px",
                                  background: "white",
                                  border: "1px solid #fbbf24",
                                  borderRadius: "4px",
                                  fontSize: "12px",
                                }}
                              >
                                🚪 {entrance.position}
                                <ct-button
                                  size="sm"
                                  variant="ghost"
                                  onClick={removeEntrance({
                                    entrances,
                                    entrance,
                                  })}
                                  style="padding: 2px 4px; min-height: 0;"
                                >
                                  ×
                                </ct-button>
                              </div>
                            ))}
                          </div>
                        </div>,
                        null,
                      )}
                    </ct-vstack>
                  </ct-card>

                  {/* Quick Actions */}
                  <ct-hstack gap="2">
                    <ct-button
                      variant="secondary"
                      onClick={() => currentSection.set("aisles")}
                      style="flex: 1;"
                    >
                      + Add Aisles
                    </ct-button>
                    <ct-button
                      variant="secondary"
                      onClick={() => currentSection.set("departments")}
                      style="flex: 1;"
                    >
                      + Add Departments
                    </ct-button>
                  </ct-hstack>
                </ct-vstack>
              </ct-vscroll>
            </ct-tab-panel>

            {/* AISLES SECTION */}
            <ct-tab-panel value="aisles">
              <ct-vscroll flex showScrollbar fadeEdges>
                <ct-vstack gap="2" style="padding: 1rem; max-width: 800px;">
                  {/* Gap warning */}
                  {ifElse(
                    derive(detectedGaps, (gaps: number[]) => gaps.length > 0),
                    <ct-card style="background: #fef3c7; border: 1px solid #fbbf24;">
                      <ct-vstack gap="1">
                        <span style={{ fontWeight: 500, color: "#92400e" }}>
                          ⚠️ Missing aisle(s) detected:{" "}
                          {derive(detectedGaps, (g: number[]) => g.join(", "))}
                        </span>
                      </ct-vstack>
                    </ct-card>,
                    null,
                  )}

                  {/* Aisle list */}
                  {sortedAisles.map((aisle) => (
                    <ct-card>
                      <ct-hstack gap="2" align="start">
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: "1.25rem",
                            minWidth: "80px",
                            color: "#667eea",
                          }}
                        >
                          Aisle {aisle.name}
                        </div>
                        <ct-vstack gap="1" style="flex: 1;">
                          <ct-textarea
                            $value={aisle.description}
                            placeholder="Description (e.g., Bread & Cereal)"
                            rows={3}
                            auto-resize
                          />
                        </ct-vstack>
                        <ct-button
                          variant="ghost"
                          onClick={removeAisle({ aisles, aisle })}
                        >
                          ×
                        </ct-button>
                      </ct-hstack>
                    </ct-card>
                  ))}

                  {/* Empty state */}
                  {ifElse(
                    computed(() => aisles.get().length === 0),
                    <div
                      style={{
                        textAlign: "center",
                        color: "var(--ct-color-gray-500)",
                        padding: "2rem",
                      }}
                    >
                      No aisles yet. Add one below!
                    </div>,
                    null,
                  )}

                  {/* Add aisle input */}
                  <ct-message-input
                    placeholder="Enter aisle number (e.g., 1, 2, 5A)..."
                    appearance="rounded"
                    onct-send={addAisle({ aisles })}
                  />

                  {/* AI Photo Import Section */}
                  <ct-card style="background: #f0fdf4; border: 1px solid #86efac; margin-top: 1rem;">
                    <ct-vstack gap="2">
                      <ct-hstack gap="2" align="center">
                        <span style={{ fontSize: "1.2rem" }}>📷</span>
                        <span style={{ fontWeight: 600, color: "#166534" }}>
                          Import Aisles from Photos
                        </span>
                      </ct-hstack>
                      <div
                        style={{
                          fontSize: "13px",
                          color: "#166534",
                        }}
                      >
                        Take photos of aisle signs - AI will extract aisle
                        numbers and products automatically.
                      </div>
                      <ct-image-input
                        multiple
                        maxImages={20}
                        maxSizeBytes={4000000}
                        showPreview={false}
                        buttonText="📷 Scan Aisle Signs"
                        variant="secondary"
                        $images={uploadedPhotos}
                      />

                      {/* Photo extraction results */}
                      {photoExtractions.map((extraction) =>
                        ifElse(
                          computed(() =>
                            hiddenPhotoIds.get().includes(extraction.photo.id)
                          ),
                          null,
                          <div
                            style={{
                              padding: "0.75rem",
                              background: "white",
                              borderRadius: "6px",
                              border: "1px solid #86efac",
                              marginTop: "0.5rem",
                            }}
                          >
                            <ct-hstack
                              justify="between"
                              align="center"
                              style="margin-bottom: 0.5rem;"
                            >
                              <span
                                style={{
                                  fontSize: "12px",
                                  fontWeight: 600,
                                  color: "#166534",
                                }}
                              >
                                📷 {extraction.photoName}
                              </span>
                              <ct-button
                                size="sm"
                                variant="ghost"
                                onClick={hidePhoto({
                                  hiddenPhotoIds,
                                  photoId: extraction.photo.id,
                                })}
                              >
                                ×
                              </ct-button>
                            </ct-hstack>

                            {ifElse(
                              extraction.pending,
                              <div
                                style={{
                                  fontSize: "12px",
                                  color: "#16a34a",
                                  fontStyle: "italic",
                                }}
                              >
                                Analyzing photo...
                              </div>,
                              ifElse(
                                extraction.error,
                                <div
                                  style={{
                                    fontSize: "12px",
                                    color: "#dc2626",
                                    fontStyle: "italic",
                                  }}
                                >
                                  Error analyzing photo. Please try removing and
                                  re-uploading.
                                </div>,
                                computed(() => {
                                  const extracted: {
                                    aisles: ExtractedAisle[];
                                  } = extraction.extractedAisles;
                                  const currentAisles = aisles.get();
                                  if (
                                    !extracted?.aisles ||
                                    extracted.aisles.length === 0
                                  ) {
                                    return (
                                      <div
                                        style={{
                                          fontSize: "12px",
                                          color: "#999",
                                        }}
                                      >
                                        No aisles detected in photo
                                      </div>
                                    );
                                  }

                                  // Helper function to check if aisle exists
                                  // Uses .some() directly on currentAisles (works with reactive proxies)
                                  const aisleExists = (name: string) => {
                                    try {
                                      return currentAisles.some(
                                        (existing: Aisle) =>
                                          existing?.name?.toLowerCase?.() ===
                                            name.toLowerCase(),
                                      );
                                    } catch {
                                      return false;
                                    }
                                  };

                                  // Count new aisles
                                  const newCount = extracted.aisles.filter(
                                    (e) => !aisleExists(e.name),
                                  ).length;

                                  return (
                                    <ct-vstack gap="1">
                                      {/* Batch add button */}
                                      {newCount > 0 && (
                                        <ct-button
                                          size="sm"
                                          variant="primary"
                                          onClick={addAllExtractedAisles({
                                            aisles,
                                            extractedList: extracted.aisles,
                                            hiddenPhotoIds,
                                            photoId: extraction.photo.id,
                                          })}
                                          style="margin-bottom: 0.5rem;"
                                        >
                                          + Add All {newCount} New Aisles
                                        </ct-button>
                                      )}

                                      {/* Individual aisle results */}
                                      {extracted.aisles.map(
                                        (extractedAisle: ExtractedAisle) => {
                                          const exists = aisleExists(
                                            extractedAisle.name,
                                          );
                                          return (
                                            <ct-hstack
                                              gap="2"
                                              align="center"
                                              style={`padding: 0.5rem; background: ${
                                                exists ? "#fef3c7" : "#dcfce7"
                                              }; border-radius: 4px;`}
                                            >
                                              <div style={{ flex: 1 }}>
                                                <strong>
                                                  Aisle {extractedAisle.name}
                                                </strong>
                                                {exists && (
                                                  <span
                                                    style={{
                                                      color: "#92400e",
                                                      marginLeft: "0.5rem",
                                                      fontSize: "11px",
                                                    }}
                                                  >
                                                    (exists)
                                                  </span>
                                                )}
                                                <div
                                                  style={{
                                                    fontSize: "12px",
                                                    color: "#6b7280",
                                                  }}
                                                >
                                                  {(extractedAisle.products ||
                                                    []).join(", ") ||
                                                    "(no products)"}
                                                </div>
                                              </div>
                                              {exists
                                                ? (
                                                  <ct-button
                                                    size="sm"
                                                    variant="secondary"
                                                    onClick={mergeExtractedAisle(
                                                      {
                                                        aisles,
                                                        extracted:
                                                          extractedAisle,
                                                      },
                                                    )}
                                                  >
                                                    Merge
                                                  </ct-button>
                                                )
                                                : (
                                                  <ct-button
                                                    size="sm"
                                                    variant="primary"
                                                    onClick={addExtractedAisle(
                                                      {
                                                        aisles,
                                                        extracted:
                                                          extractedAisle,
                                                      },
                                                    )}
                                                  >
                                                    Add
                                                  </ct-button>
                                                )}
                                            </ct-hstack>
                                          );
                                        },
                                      )}
                                    </ct-vstack>
                                  );
                                }),
                              ),
                            )}
                          </div>,
                        )
                      )}
                    </ct-vstack>
                  </ct-card>
                </ct-vstack>
              </ct-vscroll>
            </ct-tab-panel>

            {/* DEPARTMENTS SECTION */}
            <ct-tab-panel value="departments">
              <ct-vscroll flex showScrollbar fadeEdges>
                <ct-vstack gap="2" style="padding: 1rem; max-width: 800px;">
                  {/* Department list - unassigned shown first, assigned at bottom */}
                  {computed(() => {
                    const depts = departments.get();
                    // Sort: unassigned first, then assigned departments
                    return [...depts].sort((a, b) => {
                      const aAssigned = a.location !== "unassigned";
                      const bAssigned = b.location !== "unassigned";
                      if (aAssigned === bAssigned) return 0;
                      return aAssigned ? 1 : -1;
                    });
                  }).map((dept) => (
                    <ct-card>
                      <ct-vstack gap="2">
                        <ct-hstack gap="2" align="center">
                          <span style={{ fontSize: "1.5rem" }}>
                            {dept.icon}
                          </span>
                          <span style={{ fontWeight: 500, flex: 1 }}>
                            {dept.name}
                          </span>
                          <span
                            style={{
                              fontSize: "12px",
                              padding: "4px 8px",
                              borderRadius: "4px",
                              background: ifElse(
                                derive(
                                  dept.location,
                                  (l: string) => l === "unassigned",
                                ),
                                "var(--ct-color-yellow-100)",
                                "var(--ct-color-green-100)",
                              ),
                            }}
                          >
                            {dept.location}
                          </span>
                        </ct-hstack>
                        {/* Location button grid */}
                        <ct-vstack gap="1">
                          {/* Front wall */}
                          <div
                            style={{
                              display: "flex",
                              gap: "4px",
                              alignItems: "center",
                              flexWrap: "wrap",
                            }}
                          >
                            <span
                              style={{
                                width: "50px",
                                fontSize: "11px",
                                fontWeight: 600,
                                color: "#3b82f6",
                              }}
                            >
                              Front:
                            </span>
                            <ct-button
                              size="sm"
                              variant={derive(
                                dept.location,
                                (l) =>
                                  l === "front-left" ? "primary" : "outline",
                              )}
                              className="wall-btn-front"
                              onClick={setDepartmentLocation({
                                departments,
                                dept,
                                location: "front-left",
                              })}
                            >
                              Left
                            </ct-button>
                            <ct-button
                              size="sm"
                              variant={derive(
                                dept.location,
                                (l) =>
                                  l === "front-center" ? "primary" : "outline",
                              )}
                              className="wall-btn-front"
                              onClick={setDepartmentLocation({
                                departments,
                                dept,
                                location: "front-center",
                              })}
                            >
                              Center
                            </ct-button>
                            <ct-button
                              size="sm"
                              variant={derive(
                                dept.location,
                                (l) =>
                                  l === "front-right" ? "primary" : "outline",
                              )}
                              className="wall-btn-front"
                              onClick={setDepartmentLocation({
                                departments,
                                dept,
                                location: "front-right",
                              })}
                            >
                              Right
                            </ct-button>
                          </div>
                          {/* Back wall */}
                          <div
                            style={{
                              display: "flex",
                              gap: "4px",
                              alignItems: "center",
                              flexWrap: "wrap",
                            }}
                          >
                            <span
                              style={{
                                width: "50px",
                                fontSize: "11px",
                                fontWeight: 600,
                                color: "#f97316",
                              }}
                            >
                              Back:
                            </span>
                            <ct-button
                              size="sm"
                              variant={derive(
                                dept.location,
                                (l) =>
                                  l === "back-left" ? "primary" : "outline",
                              )}
                              className="wall-btn-back"
                              onClick={setDepartmentLocation({
                                departments,
                                dept,
                                location: "back-left",
                              })}
                            >
                              Left
                            </ct-button>
                            <ct-button
                              size="sm"
                              variant={derive(
                                dept.location,
                                (l) =>
                                  l === "back-center" ? "primary" : "outline",
                              )}
                              className="wall-btn-back"
                              onClick={setDepartmentLocation({
                                departments,
                                dept,
                                location: "back-center",
                              })}
                            >
                              Center
                            </ct-button>
                            <ct-button
                              size="sm"
                              variant={derive(
                                dept.location,
                                (l) =>
                                  l === "back-right" ? "primary" : "outline",
                              )}
                              className="wall-btn-back"
                              onClick={setDepartmentLocation({
                                departments,
                                dept,
                                location: "back-right",
                              })}
                            >
                              Right
                            </ct-button>
                          </div>
                          {/* Left wall */}
                          <div
                            style={{
                              display: "flex",
                              gap: "4px",
                              alignItems: "center",
                              flexWrap: "wrap",
                            }}
                          >
                            <span
                              style={{
                                width: "50px",
                                fontSize: "11px",
                                fontWeight: 600,
                                color: "#10b981",
                              }}
                            >
                              Left:
                            </span>
                            <ct-button
                              size="sm"
                              variant={derive(
                                dept.location,
                                (l) =>
                                  l === "left-front" ? "primary" : "outline",
                              )}
                              className="wall-btn-left"
                              onClick={setDepartmentLocation({
                                departments,
                                dept,
                                location: "left-front",
                              })}
                            >
                              Front
                            </ct-button>
                            <ct-button
                              size="sm"
                              variant={derive(
                                dept.location,
                                (l) =>
                                  l === "left-center" ? "primary" : "outline",
                              )}
                              className="wall-btn-left"
                              onClick={setDepartmentLocation({
                                departments,
                                dept,
                                location: "left-center",
                              })}
                            >
                              Center
                            </ct-button>
                            <ct-button
                              size="sm"
                              variant={derive(
                                dept.location,
                                (l) =>
                                  l === "left-back" ? "primary" : "outline",
                              )}
                              className="wall-btn-left"
                              onClick={setDepartmentLocation({
                                departments,
                                dept,
                                location: "left-back",
                              })}
                            >
                              Back
                            </ct-button>
                          </div>
                          {/* Right wall */}
                          <div
                            style={{
                              display: "flex",
                              gap: "4px",
                              alignItems: "center",
                              flexWrap: "wrap",
                            }}
                          >
                            <span
                              style={{
                                width: "50px",
                                fontSize: "11px",
                                fontWeight: 600,
                                color: "#a855f7",
                              }}
                            >
                              Right:
                            </span>
                            <ct-button
                              size="sm"
                              variant={derive(
                                dept.location,
                                (l) =>
                                  l === "right-front" ? "primary" : "outline",
                              )}
                              className="wall-btn-right"
                              onClick={setDepartmentLocation({
                                departments,
                                dept,
                                location: "right-front",
                              })}
                            >
                              Front
                            </ct-button>
                            <ct-button
                              size="sm"
                              variant={derive(
                                dept.location,
                                (l) =>
                                  l === "right-center" ? "primary" : "outline",
                              )}
                              className="wall-btn-right"
                              onClick={setDepartmentLocation({
                                departments,
                                dept,
                                location: "right-center",
                              })}
                            >
                              Center
                            </ct-button>
                            <ct-button
                              size="sm"
                              variant={derive(
                                dept.location,
                                (l) =>
                                  l === "right-back" ? "primary" : "outline",
                              )}
                              className="wall-btn-right"
                              onClick={setDepartmentLocation({
                                departments,
                                dept,
                                location: "right-back",
                              })}
                            >
                              Back
                            </ct-button>
                          </div>
                          {/* Special locations */}
                          <div
                            style={{
                              display: "flex",
                              gap: "4px",
                              alignItems: "center",
                              flexWrap: "wrap",
                            }}
                          >
                            <span
                              style={{
                                width: "50px",
                                fontSize: "11px",
                                fontWeight: 600,
                                color: "#6b7280",
                              }}
                            >
                              Other:
                            </span>
                            <ct-button
                              size="sm"
                              variant={derive(
                                dept.location,
                                (l) =>
                                  l === "in-center-aisle"
                                    ? "primary"
                                    : "outline",
                              )}
                              onClick={setDepartmentLocation({
                                departments,
                                dept,
                                location: "in-center-aisle",
                              })}
                            >
                              Normal Aisle
                            </ct-button>
                            <ct-button
                              size="sm"
                              variant={derive(
                                dept.location,
                                (l) =>
                                  l === "not-in-store" ? "primary" : "outline",
                              )}
                              onClick={setDepartmentLocation({
                                departments,
                                dept,
                                location: "not-in-store",
                              })}
                            >
                              N/A
                            </ct-button>
                          </div>
                        </ct-vstack>
                        <ct-input
                          $value={dept.description}
                          placeholder="Description (optional)"
                        />
                      </ct-vstack>
                    </ct-card>
                  ))}
                </ct-vstack>
              </ct-vscroll>
            </ct-tab-panel>

            {/* CORRECTIONS SECTION */}
            <ct-tab-panel value="corrections">
              <ct-vscroll flex showScrollbar fadeEdges>
                <ct-vstack gap="2" style="padding: 1rem; max-width: 800px;">
                  <ct-card>
                    <ct-vstack gap="2">
                      <span style={{ fontWeight: 500 }}>
                        Add Item Correction
                      </span>
                      <p
                        style={{
                          fontSize: "14px",
                          color: "var(--ct-color-gray-500)",
                        }}
                      >
                        Record where items are actually located for future
                        reference.
                      </p>
                      <ct-input
                        $value={newCorrectionItem}
                        placeholder="Item name (e.g., coffee)"
                      />
                      <ct-input
                        $value={newCorrectionAisle}
                        placeholder="Correct location (e.g., Aisle 9 or Bakery)"
                      />
                      <ct-button
                        variant="primary"
                        onClick={() => {
                          const item = newCorrectionItem.get().trim();
                          const aisle = newCorrectionAisle.get().trim();
                          if (item && aisle) {
                            const current = itemLocations.get();
                            const filtered = current.filter(
                              (loc) => loc.itemName.toLowerCase() !==
                                item.toLowerCase(),
                            );
                            filtered.push({
                              itemName: item,
                              correctAisle: aisle,
                              incorrectAisle: "",
                              timestamp: Date.now(),
                            });
                            itemLocations.set(filtered);
                            newCorrectionItem.set("");
                            newCorrectionAisle.set("");
                          }
                        }}
                      >
                        Save Correction
                      </ct-button>
                    </ct-vstack>
                  </ct-card>

                  {/* Existing corrections */}
                  {ifElse(
                    computed(() => itemLocations.get().length > 0),
                    <ct-card>
                      <ct-vstack gap="2">
                        <span style={{ fontWeight: 500 }}>
                          Saved Corrections
                        </span>
                        {itemLocations.map((loc) => (
                          <ct-hstack
                            gap="2"
                            align="center"
                            style="padding: 0.5rem; background: var(--ct-color-gray-50); border-radius: 6px;"
                          >
                            <span style={{ flex: 1 }}>
                              <strong>{loc.itemName}</strong> →{" "}
                              {loc.correctAisle}
                            </span>
                            <ct-button
                              variant="ghost"
                              onClick={() => {
                                const current = itemLocations.get();
                                const itemName = loc.itemName;
                                itemLocations.set(
                                  current.filter(
                                    (l) => l.itemName.toLowerCase() !==
                                      itemName.toLowerCase(),
                                  ),
                                );
                              }}
                            >
                              ×
                            </ct-button>
                          </ct-hstack>
                        ))}
                      </ct-vstack>
                    </ct-card>,
                    <div
                      style={{
                        textAlign: "center",
                        color: "var(--ct-color-gray-500)",
                        padding: "2rem",
                      }}
                    >
                      No corrections saved yet.
                    </div>,
                  )}
                </ct-vstack>
              </ct-vscroll>
            </ct-tab-panel>

            {/* OUTLINE SECTION */}
            <ct-tab-panel value="outline">
              <ct-vscroll flex showScrollbar fadeEdges>
                <ct-vstack gap="2" style="padding: 1rem; max-width: 800px;">
                  <ct-card>
                    <ct-vstack gap="2">
                      <span style={{ fontWeight: 500 }}>
                        Store Layout Outline
                      </span>
                      <p
                        style={{
                          fontSize: "14px",
                          color: "var(--ct-color-gray-500)",
                        }}
                      >
                        This outline is used by the Shopping List for AI-powered
                        aisle sorting.
                      </p>
                      <pre
                        style={{
                          background: "var(--ct-color-gray-50)",
                          padding: "1rem",
                          borderRadius: "6px",
                          fontSize: "13px",
                          whiteSpace: "pre-wrap",
                          overflowX: "auto",
                        }}
                      >
                        {outline}
                      </pre>
                    </ct-vstack>
                  </ct-card>
                </ct-vstack>
              </ct-vscroll>
            </ct-tab-panel>
          </ct-tabs>
        </ct-screen>
      ),
      storeName,
      aisles,
      departments,
      entrances,
      itemLocations,
      outline,
      aisleCount,
      deptCount,
      correctionCount,
    };
  },
);
