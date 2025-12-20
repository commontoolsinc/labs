/// <cts-enable />
/**
 * Extractor Module - Controller sub-charm for LLM-assisted field extraction
 *
 * This is a "controller module" that acts on the parent Record's state.
 * It receives the parent's Cells as INPUT, extracts data from pasted text,
 * shows a diff preview, and updates existing modules when confirmed.
 *
 * Key architecture:
 * - Receives parentSubCharms and parentTrashedSubCharms as INPUT Cells
 * - Uses generateObject() with registry's buildExtractionSchema()
 * - Shows diff view: currentValue → extractedValue for each field
 * - Writes to modules via charm.key(fieldName).set(value)
 * - Auto-trashes itself after successful apply
 */

import {
  Cell,
  computed,
  type Default,
  generateObject,
  handler,
  ifElse,
  NAME,
  recipe,
  UI,
} from "commontools";
import {
  buildExtractionSchema,
  getDefinition,
  getFieldToTypeMapping,
} from "../registry.ts";
import type { SubCharmEntry, TrashedSubCharmEntry } from "../types.ts";
import type { ExtractedField, ExtractionPreview } from "./types.ts";

// ===== Types =====

interface ExtractorModuleInput {
  // Parent's Cells - passed as INPUT so they survive serialization
  parentSubCharms: Cell<SubCharmEntry[]>;
  parentTrashedSubCharms: Cell<TrashedSubCharmEntry[]>;
  // Internal state
  inputText?: Default<string, "">;
  selections?: Default<Record<string, boolean>, {}>;
}

interface ExtractorModuleOutput {
  inputText?: Default<string, "">;
  selections?: Default<Record<string, boolean>, {}>;
}

// ===== Constants =====

const EXTRACTION_SYSTEM_PROMPT = `You are a precise data extractor. Extract structured fields from unstructured text like email signatures, bios, vCards, or notes.

Rules:
1. Only extract data that is explicitly stated or clearly implied
2. Return null for fields where no relevant information is found
3. For dates, use ISO format (YYYY-MM-DD) when possible
4. For partial dates (e.g., "March 15"), use MM-DD format
5. For arrays (tags, favorites), extract as arrays of strings
6. Preserve original formatting for phone numbers
7. Be conservative - only extract what you're confident about

Return a JSON object with the extracted fields. Use null for fields without data.`;

// ===== Helper Functions =====

/**
 * Get current value from an existing module for diff display
 */
function getCurrentValue(entry: SubCharmEntry, fieldName: string): unknown {
  try {
    const charm = entry.charm as Record<string, unknown>;
    const field = charm[fieldName];
    // Try .get() for Cell, otherwise use value directly
    if (field && typeof (field as { get?: () => unknown }).get === "function") {
      return (field as { get: () => unknown }).get();
    }
    return field;
  } catch {
    return undefined;
  }
}

/**
 * Check if a value is "empty" (null, undefined, empty string, empty array)
 */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/**
 * Format a value for display in the diff view
 */
function formatValue(value: unknown): string {
  if (isEmpty(value)) return "(empty)";
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Build extraction preview from raw LLM result and existing modules
 */
function buildPreview(
  extracted: Record<string, unknown>,
  subCharms: readonly SubCharmEntry[]
): ExtractionPreview {
  const fieldToType = getFieldToTypeMapping();
  const fields: ExtractedField[] = [];
  const byModule: Record<string, ExtractedField[]> = {};

  for (const [fieldName, extractedValue] of Object.entries(extracted)) {
    // Skip null/undefined values
    if (extractedValue === null || extractedValue === undefined) continue;

    const moduleType = fieldToType[fieldName];
    if (!moduleType) continue;

    // Find existing module of this type
    const entry = subCharms.find((e) => e?.type === moduleType);
    const currentValue = entry ? getCurrentValue(entry, fieldName) : undefined;

    // Skip if value hasn't changed
    if (JSON.stringify(currentValue) === JSON.stringify(extractedValue)) continue;

    const field: ExtractedField = {
      fieldName,
      targetModule: moduleType,
      extractedValue,
      currentValue,
    };

    fields.push(field);

    if (!byModule[moduleType]) byModule[moduleType] = [];
    byModule[moduleType].push(field);
  }

  return { fields, byModule };
}

// ===== Handlers =====

/**
 * Dismiss the extractor without applying (user can restore from trash)
 */
const dismiss = handler<
  unknown,
  {
    parentSubCharms: Cell<SubCharmEntry[]>;
    parentTrashedSubCharms: Cell<TrashedSubCharmEntry[]>;
  }
>((_event, { parentSubCharms, parentTrashedSubCharms }) => {
  const current = parentSubCharms.get() || [];
  const selfEntry = current.find((e) => e?.type === "extractor");
  if (!selfEntry) return;

  parentSubCharms.set(current.filter((e) => e?.type !== "extractor"));
  parentTrashedSubCharms.push({
    ...selfEntry,
    trashedAt: new Date().toISOString(),
  });
});

/**
 * Toggle a field selection on/off
 */
const toggleField = handler<
  unknown,
  { selections: Cell<Record<string, boolean>>; fieldKey: string }
>((_event, { selections, fieldKey }) => {
  const current = selections.get() || {};
  selections.set({
    ...current,
    [fieldKey]: !current[fieldKey],
  });
});

/**
 * Apply selected extractions to modules, then auto-trash self
 */
const applySelected = handler<
  unknown,
  {
    parentSubCharms: Cell<SubCharmEntry[]>;
    parentTrashedSubCharms: Cell<TrashedSubCharmEntry[]>;
    preview: ExtractionPreview;
    selections: Cell<Record<string, boolean>>;
  }
>((_event, { parentSubCharms, parentTrashedSubCharms, preview, selections }) => {
  const current = parentSubCharms.get() || [];
  const selected = selections.get() || {};

  // Apply each selected field
  for (const field of preview.fields) {
    const fieldKey = `${field.targetModule}.${field.fieldName}`;
    // Default to selected (true) unless explicitly unchecked
    if (selected[fieldKey] === false) continue;

    const entry = current.find((e) => e?.type === field.targetModule);
    if (!entry?.charm) continue;

    try {
      // Use .key().set() to write to the module's field
      const charm = entry.charm as { key: (k: string) => { set: (v: unknown) => void } };
      charm.key(field.fieldName).set(field.extractedValue);
    } catch (e) {
      console.warn(`Failed to set ${field.targetModule}.${field.fieldName}:`, e);
    }
  }

  // Auto-trash self
  const selfEntry = current.find((e) => e?.type === "extractor");
  if (selfEntry) {
    parentSubCharms.set(current.filter((e) => e?.type !== "extractor"));
    parentTrashedSubCharms.push({
      ...selfEntry,
      trashedAt: new Date().toISOString(),
    });
  }
});

// ===== The Pattern =====

export const ExtractorModule = recipe<ExtractorModuleInput, ExtractorModuleOutput>(
  "ExtractorModule",
  ({ parentSubCharms, parentTrashedSubCharms, inputText, selections }) => {
    // Build the extraction schema from registry
    const extractionSchema = buildExtractionSchema();

    // Check if we have enough text to extract
    const hasText = computed(() => (inputText?.trim()?.length || 0) > 20);

    // Reactive extraction - only runs when inputText has content
    // The framework caches by content hash, so same text won't re-extract
    const extraction = generateObject<Record<string, unknown>>({
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: computed(() => (hasText ? inputText?.trim() : "")),
      schema: extractionSchema as Record<string, unknown>,
    });

    // Build preview from extraction result
    const preview = computed((): ExtractionPreview | null => {
      if (!extraction.result) return null;
      const subCharms = parentSubCharms.get() || [];
      return buildPreview(extraction.result, subCharms);
    });

    // Count selected fields for button text
    const selectedCount = computed(() => {
      const p = preview;
      if (!p?.fields) return 0;
      const sel = selections || {};
      return p.fields.filter((f) => {
        const key = `${f.targetModule}.${f.fieldName}`;
        return sel[key] !== false; // Default is selected
      }).length;
    });

    // Determine current phase
    const phase = computed(() => {
      if (!hasText) return "idle";
      if (extraction.pending) return "extracting";
      if (extraction.error) return "error";
      if (preview?.fields?.length) return "preview";
      return "idle";
    });

    return {
      [NAME]: "AI Extract",
      [UI]: (
        <div
          style={{
            background: "linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)",
            borderRadius: "8px",
            padding: "16px",
          }}
        >
          {/* Header */}
          <div
            style={{
              marginBottom: "12px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ color: "#92400e", fontWeight: "500" }}>
              {ifElse(
                computed(() => phase === "preview"),
                "Review Changes",
                "Extract from Text"
              )}
            </span>
            <button
              onClick={dismiss({ parentSubCharms, parentTrashedSubCharms })}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "#6b7280",
                fontSize: "16px",
                padding: "4px",
              }}
              title="Dismiss"
            >
              ✕
            </button>
          </div>

          {/* Idle state - text input */}
          {ifElse(
            computed(() => phase === "idle" || phase === "error"),
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <ct-textarea
                $value={inputText}
                placeholder="Paste an email signature, bio, vCard, or any text with contact/profile information..."
                style={{
                  width: "100%",
                  minHeight: "100px",
                }}
              />
              {ifElse(
                computed(() => phase === "error"),
                <div
                  style={{
                    padding: "8px 12px",
                    background: "#fee2e2",
                    borderRadius: "6px",
                    color: "#991b1b",
                    fontSize: "13px",
                  }}
                >
                  Extraction failed. Try different text or check the format.
                </div>,
                null
              )}
              <div style={{ fontSize: "12px", color: "#6b7280" }}>
                {ifElse(
                  hasText,
                  "Ready to extract...",
                  "Enter at least 20 characters"
                )}
              </div>
            </div>,
            null
          )}

          {/* Extracting state */}
          {ifElse(
            computed(() => phase === "extracting"),
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                padding: "24px",
              }}
            >
              <ct-loader size="sm" show-elapsed />
              <span style={{ color: "#92400e" }}>Extracting data...</span>
            </div>,
            null
          )}

          {/* Preview state - diff view */}
          {ifElse(
            computed(() => phase === "preview"),
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              {/* Module groups */}
              {computed(() => {
                const p = preview;
                if (!p) return null;

                return Object.entries(p.byModule).map(([moduleType, fields]) => {
                  const def = getDefinition(moduleType);
                  const icon = def?.icon || "📋";
                  const label = def?.label || moduleType;

                  return (
                    <div
                      style={{
                        background: "white",
                        borderRadius: "6px",
                        border: "1px solid #e5e7eb",
                        overflow: "hidden",
                      }}
                    >
                      {/* Module header */}
                      <div
                        style={{
                          padding: "8px 12px",
                          background: "#f9fafb",
                          borderBottom: "1px solid #e5e7eb",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <span style={{ fontWeight: "500" }}>
                          {icon} {label}
                        </span>
                        <span
                          style={{
                            fontSize: "11px",
                            padding: "2px 6px",
                            background: "#dbeafe",
                            color: "#1d4ed8",
                            borderRadius: "4px",
                          }}
                        >
                          UPDATE
                        </span>
                      </div>

                      {/* Field list */}
                      <div style={{ padding: "8px 12px" }}>
                        {fields.map((field: ExtractedField) => {
                          const key = `${moduleType}.${field.fieldName}`;
                          const isSelected = computed(() => {
                            const sel = selections || {};
                            return sel[key] !== false;
                          });
                          const currentFormatted = formatValue(field.currentValue);
                          const extractedFormatted = formatValue(field.extractedValue);
                          const isAdding = isEmpty(field.currentValue);

                          return (
                            <div
                              style={{
                                display: "flex",
                                alignItems: "flex-start",
                                gap: "8px",
                                padding: "6px 0",
                                borderBottom: "1px solid #f3f4f6",
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() =>
                                  toggleField({ selections, fieldKey: key })
                                }
                                style={{ marginTop: "2px" }}
                              />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                  style={{
                                    fontSize: "13px",
                                    fontWeight: "500",
                                    color: "#374151",
                                  }}
                                >
                                  {field.fieldName}
                                </div>
                                <div
                                  style={{
                                    fontSize: "12px",
                                    color: isAdding ? "#059669" : "#d97706",
                                    wordBreak: "break-word",
                                  }}
                                >
                                  {currentFormatted}{" "}
                                  <span style={{ color: "#9ca3af" }}>→</span>{" "}
                                  {extractedFormatted}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                });
              })}

              {/* Action buttons */}
              <div
                style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}
              >
                <button
                  onClick={dismiss({ parentSubCharms, parentTrashedSubCharms })}
                  style={{
                    padding: "8px 16px",
                    background: "white",
                    border: "1px solid #d1d5db",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "14px",
                  }}
                >
                  Discard
                </button>
                <button
                  onClick={applySelected({
                    parentSubCharms,
                    parentTrashedSubCharms,
                    preview: preview as ExtractionPreview,
                    selections,
                  })}
                  style={{
                    padding: "8px 16px",
                    background: "#059669",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "14px",
                    fontWeight: "500",
                  }}
                >
                  Apply {selectedCount} Change{ifElse(
                    computed(() => selectedCount !== 1),
                    "s",
                    ""
                  )}
                </button>
              </div>
            </div>,
            null
          )}
        </div>
      ),
      inputText,
      selections,
    };
  }
);

export default ExtractorModule;
