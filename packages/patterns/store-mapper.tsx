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
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  Writable,
} from "commontools";

// Types for store layout
interface Aisle {
  name: string; // Just the number, e.g., "1", "2", "5A"
  description: Default<string, "">;
}

interface Department {
  name: string;
  icon: string;
  location: Default<string, "unassigned">; // wall position or "unassigned" | "not-in-store" | "in-center-aisle"
  description: Default<string, "">;
}

interface Entrance {
  position: string; // e.g., "front-left", "front-center"
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

const loadDefaultDepartments = handler<
  unknown,
  { departments: Writable<Department[]> }
>((_event, { departments }) => {
  const current = departments.get();
  const existingNames = new Set(current.map((d) => d.name));

  const newDepts = DEFAULT_DEPARTMENTS.filter(
    (d) => !existingNames.has(d.name),
  ).map((d) => ({
    ...d,
    location: "unassigned" as const,
    description: "",
  }));

  departments.set([...current, ...newDepts]);
});

export default pattern<Input, Output>(
  ({ storeName, aisles, departments, entrances, itemLocations }) => {
    // UI state
    const currentSection = Writable.of<
      "aisles" | "departments" | "corrections" | "outline"
    >("aisles");
    const newCorrectionItem = Writable.of("");
    const newCorrectionAisle = Writable.of("");

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
    const outline = derive(
      [sortedAisles, departments, itemLocations],
      (
        [aislesSorted, depts, corrections]: [
          Aisle[],
          Department[],
          ItemLocation[],
        ],
      ) => {
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
      },
    );

    // Counts for reactive arrays
    const aisleCount = computed(() => aisles.get().length);
    const deptCount = computed(() => departments.get().length);
    const correctionCount = computed(() => itemLocations.get().length);

    // Gap detection for aisles
    const detectedGaps = derive(aisles, (aisleList: Aisle[]) => {
      const numbers = aisleList
        .map((a) => parseInt(a.name.match(/^\d+/)?.[0] || "", 10))
        .filter((n) => !isNaN(n))
        .sort((a, b) => a - b);

      const gaps: number[] = [];
      for (let i = 1; i < numbers.length; i++) {
        const expected = numbers[i - 1] + 1;
        if (expected < numbers[i]) {
          gaps.push(expected);
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
              {aisleCount} aisles • {deptCount} departments
            </div>
          </div>

          {/* Navigation tabs */}
          <ct-hstack
            gap="1"
            style="padding: 0.5rem 1rem; border-bottom: 1px solid var(--ct-color-gray-200);"
          >
            <ct-button
              variant={ifElse(
                computed(() => currentSection.get() === "aisles"),
                "primary",
                "ghost",
              )}
              onClick={() => currentSection.set("aisles")}
            >
              Aisles
            </ct-button>
            <ct-button
              variant={ifElse(
                computed(() => currentSection.get() === "departments"),
                "primary",
                "ghost",
              )}
              onClick={() => currentSection.set("departments")}
            >
              Departments
            </ct-button>
            <ct-button
              variant={ifElse(
                computed(() => currentSection.get() === "corrections"),
                "primary",
                "ghost",
              )}
              onClick={() => currentSection.set("corrections")}
            >
              Corrections
            </ct-button>
            <ct-button
              variant={ifElse(
                computed(() => currentSection.get() === "outline"),
                "primary",
                "ghost",
              )}
              onClick={() => currentSection.set("outline")}
            >
              Outline
            </ct-button>
          </ct-hstack>

          {/* Main content */}
          <ct-vscroll flex showScrollbar fadeEdges>
            <ct-vstack gap="2" style="padding: 1rem; max-width: 800px;">
              {/* AISLES SECTION */}
              {ifElse(
                computed(() => currentSection.get() === "aisles"),
                <ct-vstack gap="2">
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
                          <ct-input
                            $value={aisle.description}
                            placeholder="Description (e.g., Bread & Cereal)"
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
                </ct-vstack>,
                null,
              )}

              {/* DEPARTMENTS SECTION */}
              {ifElse(
                computed(() => currentSection.get() === "departments"),
                <ct-vstack gap="2">
                  {/* Load defaults button */}
                  {ifElse(
                    computed(() => departments.get().length === 0),
                    <ct-button
                      variant="primary"
                      onClick={loadDefaultDepartments({ departments })}
                    >
                      Load Common Departments
                    </ct-button>,
                    null,
                  )}

                  {/* Department list */}
                  {departments.map((dept) => (
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
                        <ct-select
                          $value={dept.location}
                          items={[
                            { label: "Unassigned", value: "unassigned" },
                            { label: "Front Left", value: "front-left" },
                            { label: "Front Center", value: "front-center" },
                            { label: "Front Right", value: "front-right" },
                            { label: "Back Left", value: "back-left" },
                            { label: "Back Center", value: "back-center" },
                            { label: "Back Right", value: "back-right" },
                            { label: "Left Front", value: "left-front" },
                            { label: "Left Center", value: "left-center" },
                            { label: "Left Back", value: "left-back" },
                            { label: "Right Front", value: "right-front" },
                            { label: "Right Center", value: "right-center" },
                            { label: "Right Back", value: "right-back" },
                            {
                              label: "In Center Aisles",
                              value: "in-center-aisle",
                            },
                            { label: "Not In Store", value: "not-in-store" },
                          ]}
                        />
                        <ct-input
                          $value={dept.description}
                          placeholder="Description (optional)"
                        />
                      </ct-vstack>
                    </ct-card>
                  ))}

                  {ifElse(
                    computed(() => departments.get().length === 0),
                    <div
                      style={{
                        textAlign: "center",
                        color: "var(--ct-color-gray-500)",
                        padding: "2rem",
                      }}
                    >
                      No departments yet. Click "Load Common Departments" to
                      start.
                    </div>,
                    null,
                  )}
                </ct-vstack>,
                null,
              )}

              {/* CORRECTIONS SECTION */}
              {ifElse(
                computed(() => currentSection.get() === "corrections"),
                <ct-vstack gap="2">
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
                              (loc) =>
                                loc.itemName.toLowerCase() !==
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
                </ct-vstack>,
                null,
              )}

              {/* OUTLINE SECTION */}
              {ifElse(
                computed(() => currentSection.get() === "outline"),
                <ct-vstack gap="2">
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
                </ct-vstack>,
                null,
              )}
            </ct-vstack>
          </ct-vscroll>
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
