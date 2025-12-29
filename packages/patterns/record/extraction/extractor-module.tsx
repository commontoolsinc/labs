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
import { getModuleUrl } from "../registry.ts";
import { fetchAndRunPattern } from "../../system/common-tools.tsx";
import type { SubCharmEntry, TrashedSubCharmEntry } from "../types.ts";
import type { ExtractedField, ExtractionPreview } from "./types.ts";
import type { JSONSchema } from "./schema-utils.ts";
import {
  buildExtractionSchemaFromCell,
  getFieldToTypeMapping,
  getSchemaForType,
} from "./schema-utils.ts";
import { SmartTextInput } from "./smart-text-input.tsx";

// ===== Types =====

interface ExtractorModuleInput {
  // Parent's Cells - passed as INPUT so they survive serialization
  parentSubCharms: Cell<SubCharmEntry[]>;
  parentTrashedSubCharms: Cell<TrashedSubCharmEntry[]>;
  // Internal state
  inputText?: Default<string, "">;
  extractionPrompt?: Default<string, "">; // Only set when user clicks Extract
  selections?: Default<Record<string, boolean>, Record<string, never>>;
}

interface ExtractorModuleOutput {
  inputText?: Default<string, "">;
  extractionPrompt?: Default<string, "">;
  selections?: Default<Record<string, boolean>, Record<string, never>>;
}

// ===== Constants =====

const EXTRACTION_SYSTEM_PROMPT =
  `You are a precise data extractor. Extract structured fields from unstructured text like email signatures, bios, vCards, or notes.

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
 * Validate that an extracted value matches the expected JSON Schema type
 */
function validateFieldValue(
  value: unknown,
  schema: JSONSchema | undefined,
): boolean {
  // No schema = allow anything (permissive for dynamic fields)
  if (!schema || !schema.type) return true;

  const schemaType = schema.type;

  // Handle array types
  if (schemaType === "array") {
    return Array.isArray(value);
  }

  // Handle integer (stricter than number)
  if (schemaType === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }

  // Handle number (includes integers and floats)
  if (schemaType === "number") {
    return typeof value === "number" && !isNaN(value);
  }

  // Handle boolean
  if (schemaType === "boolean") {
    return typeof value === "boolean";
  }

  // Handle string
  if (schemaType === "string") {
    return typeof value === "string";
  }

  // Handle object
  if (schemaType === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // Handle null
  if (schemaType === "null") {
    return value === null;
  }

  // Unknown schema type - be permissive
  return true;
}

/**
 * Get schema for a specific field from sub-charms
 */
function getFieldSchema(
  subCharms: readonly SubCharmEntry[],
  moduleType: string,
  fieldName: string,
): JSONSchema | undefined {
  const entry = subCharms.find((e) => e?.type === moduleType);
  if (!entry) return undefined;

  // Try stored schema first
  const storedSchema = entry.schema as JSONSchema | undefined;
  if (storedSchema?.properties?.[fieldName]) {
    return storedSchema.properties[fieldName];
  }

  // Fallback to registry schema (for legacy entries)
  try {
    const registrySchema = getSchemaForType(moduleType);
    if (registrySchema?.properties?.[fieldName]) {
      return registrySchema.properties[fieldName];
    }
  } catch {
    // getSchemaForType may fail if registry isn't available
  }

  return undefined;
}

/**
 * Build extraction preview from raw LLM result and existing modules
 */
function buildPreview(
  extracted: Record<string, unknown>,
  subCharms: readonly SubCharmEntry[],
): ExtractionPreview {
  // Use dynamic field-to-type mapping from stored schemas (falls back to registry)
  const fieldToType = getFieldToTypeMapping(subCharms);
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
    if (JSON.stringify(currentValue) === JSON.stringify(extractedValue)) {
      continue;
    }

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
 * Note: Currently unused but kept for future per-field toggle UI
 */
const _toggleField = handler<
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
 * Trigger extraction - copies inputText to extractionPrompt
 * This is the only way extraction starts (not automatic on typing)
 */
const triggerExtraction = handler<
  unknown,
  { inputText: Cell<string>; extractionPrompt: Cell<string> }
>((_event, { inputText, extractionPrompt }) => {
  const text = inputText.get() || "";
  extractionPrompt.set(text);
});

/**
 * Apply selected extractions to modules, then auto-trash self
 * Creates missing modules automatically if needed
 */
const applySelected = handler<
  unknown,
  {
    parentSubCharms: Cell<SubCharmEntry[]>;
    parentTrashedSubCharms: Cell<TrashedSubCharmEntry[]>;
    preview: ExtractionPreview;
    selections: Cell<Record<string, boolean>>;
  }
>((
  _event,
  { parentSubCharms, parentTrashedSubCharms, preview, selections },
) => {
  const current: SubCharmEntry[] = [...(parentSubCharms.get() || [])];
  const subCharms = current; // For schema lookups
  const selected = selections.get() || {};

  // Group fields by target module
  const fieldsByModule: Record<string, ExtractedField[]> = {};
  for (const field of preview.fields) {
    const fieldKey = `${field.targetModule}.${field.fieldName}`;
    if (selected[fieldKey] === false) continue;

    if (!fieldsByModule[field.targetModule]) {
      fieldsByModule[field.targetModule] = [];
    }
    fieldsByModule[field.targetModule].push(field);
  }

  // Collect new entries to add (batched to avoid multiple set() calls)
  const newEntries: SubCharmEntry[] = [];

  // Process each module type
  for (const [moduleType, fields] of Object.entries(fieldsByModule)) {
    const existingIndex = current.findIndex((e) => e?.type === moduleType);

    if (existingIndex >= 0) {
      // Module exists - use Cell navigation to update fields
      for (const field of fields) {
        // Validate extracted value against schema
        const fieldSchema = getFieldSchema(
          subCharms,
          moduleType,
          field.fieldName,
        );
        const isValid = validateFieldValue(field.extractedValue, fieldSchema);

        if (!isValid) {
          const actualType = Array.isArray(field.extractedValue)
            ? "array"
            : typeof field.extractedValue;
          console.warn(
            `[Extract] Type mismatch for ${moduleType}.${field.fieldName}: ` +
              `expected ${fieldSchema?.type}, got ${actualType}. ` +
              `Value: ${JSON.stringify(field.extractedValue)}. Skipping field.`,
          );
          continue; // Skip this field
        }

        try {
          // Only write if validation passed
          (parentSubCharms as any).key(existingIndex).key("charm").key(
            field.fieldName,
          ).set(field.extractedValue);
        } catch (e) {
          console.warn(`Failed to set ${moduleType}.${field.fieldName}:`, e);
        }
      }
    } else if (moduleType !== "notes") {
      // Module doesn't exist - create it with initial values
      // Notes module is special (needs linkPattern), skip auto-creation
      try {
        // Build initial values object from extracted fields
        const initialValues: Record<string, unknown> = {};
        for (const field of fields) {
          // Validate before adding to initialValues
          const fieldSchema = getFieldSchema(
            subCharms,
            moduleType,
            field.fieldName,
          );
          const isValid = validateFieldValue(field.extractedValue, fieldSchema);

          if (!isValid) {
            const actualType = Array.isArray(field.extractedValue)
              ? "array"
              : typeof field.extractedValue;
            console.warn(
              `[Extract] Type mismatch for new module ${moduleType}.${field.fieldName}: ` +
                `expected ${fieldSchema?.type}, got ${actualType}. ` +
                `Value: ${
                  JSON.stringify(field.extractedValue)
                }. Skipping field.`,
            );
            continue; // Skip this field
          }

          initialValues[field.fieldName] = field.extractedValue;
        }
        // Create module with initial values passed to the recipe

        // Only create module if we have at least one valid field
        if (Object.keys(initialValues).length > 0) {
          // Get module URL and load dynamically
          const loadInfo = getModuleUrl(moduleType);
          if ("error" in loadInfo) {
            console.warn(
              `Cannot create module "${moduleType}": ${loadInfo.error}`,
            );
            continue;
          }

          // Create module with initial values via fetchAndRunPattern
          // Store loaded directly - it's a reactive reference that updates when pattern loads
          const loaded = fetchAndRunPattern({
            url: loadInfo.url,
            args: Cell.of(initialValues),
          });

          newEntries.push({
            type: moduleType,
            pinned: false,
            charm: loaded, // Store directly, extract .cell at render time
          });
        }
      } catch (e) {
        console.warn(`Failed to create module ${moduleType}:`, e);
      }
    }
  }

  // Batch: add all new modules and remove self in a single set()
  const selfEntry = current.find((e) => e?.type === "extractor");
  const withoutSelf = current.filter((e) => e?.type !== "extractor");
  const final = [...withoutSelf, ...newEntries];
  parentSubCharms.set(final);

  // Trash self
  if (selfEntry) {
    parentTrashedSubCharms.push({
      ...selfEntry,
      trashedAt: new Date().toISOString(),
    });
  }
});

// ===== The Pattern =====

export const ExtractorModule = recipe<
  ExtractorModuleInput,
  ExtractorModuleOutput
>(
  "ExtractorModule",
  (
    {
      parentSubCharms,
      parentTrashedSubCharms,
      inputText,
      extractionPrompt,
      selections,
    },
  ) => {
    // Dynamic schema discovery - builds schema from stored entry.schema (with registry fallback)
    const extractSchema = computed(() => {
      return buildExtractionSchemaFromCell(parentSubCharms);
    });

    // SmartTextInput - provides text, file upload, and image OCR input
    const smartTextInput = SmartTextInput({
      $value: inputText,
      placeholder:
        "Paste text, upload a file, or snap a photo of a business card...",
      rows: 4,
    });

    // Reactive extraction - only runs when extractionPrompt is set (user clicked Extract)
    // The framework caches by content hash, so same text won't re-extract
    const extraction = generateObject({
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: extractionPrompt, // Only triggers when user clicks Extract button
      schema: extractSchema as any, // Dynamic schema from stored entry.schema
      model: "anthropic:claude-haiku-4-5", // Fast & cheap model for extraction
    } as any);

    // Check if we have any text to extract (for UI display)
    // inputText is a reactive reference - must use computed() to track changes
    const hasText = computed(() => {
      const text = inputText || "";
      return text.trim().length > 0;
    });

    // Check if extraction has been triggered
    const hasTriggered = computed(() => {
      const prompt = extractionPrompt || "";
      return prompt.trim().length > 0;
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
      // If no text entered yet, stay idle
      if (!hasText) return "idle";
      // If text entered but not triggered, show "ready" state with Extract button
      if (!hasTriggered) return "ready";
      // After triggering, show extraction states
      if (extraction.pending) return "extracting";
      if (extraction.error) return "error";
      if (preview?.fields?.length) return "preview";
      return "idle";
    });

    // Show extract button when ready (text entered but not triggered)
    const showExtractButton = computed(() => hasText && !hasTriggered);

    // Format extracted fields as text for preview display
    // Build directly from extraction.result to avoid double-computed issues
    const previewText = computed(() => {
      if (!extraction.result) return "No fields extracted";
      const subCharms = parentSubCharms.get() || [];
      const previewData = buildPreview(extraction.result, subCharms);
      if (!previewData?.fields?.length) return "No fields extracted";
      return previewData.fields.map((f: ExtractedField) => {
        const current = formatValue(f.currentValue);
        const extracted = formatValue(f.extractedValue);
        return `${f.targetModule}.${f.fieldName}: ${current} → ${extracted}`;
      }).join("\n");
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
                "Extract from Text",
              )}
            </span>
            <button
              type="button"
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

          {/* Idle/Ready state - text input with Extract button */}
          {ifElse(
            computed(() =>
              phase === "idle" || phase === "ready" || phase === "error"
            ),
            <div
              style={{ display: "flex", flexDirection: "column", gap: "12px" }}
            >
              {/* SmartTextInput: supports text, file upload, and image OCR */}
              {smartTextInput.ui.complete}
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
                null,
              )}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div style={{ fontSize: "12px", color: "#6b7280" }}>
                  {ifElse(
                    hasText,
                    "Ready to extract",
                    "Enter some text to extract from",
                  )}
                </div>
                {ifElse(
                  showExtractButton,
                  <button
                    type="button"
                    onClick={triggerExtraction({ inputText, extractionPrompt })}
                    style={{
                      padding: "8px 16px",
                      background: "#f59e0b",
                      color: "white",
                      border: "none",
                      borderRadius: "6px",
                      cursor: "pointer",
                      fontSize: "14px",
                      fontWeight: "500",
                    }}
                  >
                    ✨ Extract
                  </button>,
                  null,
                )}
              </div>
            </div>,
            null,
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
            null,
          )}

          {/* Preview state - diff view */}
          {ifElse(
            computed(() => phase === "preview"),
            <div
              style={{ display: "flex", flexDirection: "column", gap: "16px" }}
            >
              {/* Simple field list - render flat list of extracted fields */}
              <div
                style={{
                  background: "white",
                  borderRadius: "6px",
                  border: "1px solid #e5e7eb",
                  padding: "12px",
                }}
              >
                <div
                  style={{
                    marginBottom: "8px",
                    fontWeight: "500",
                    color: "#374151",
                  }}
                >
                  Extracted Fields:
                </div>
                <div
                  style={{
                    fontSize: "13px",
                    color: "#6b7280",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {previewText}
                </div>
              </div>

              {/* Action buttons */}
              <div
                style={{
                  display: "flex",
                  gap: "8px",
                  justifyContent: "flex-end",
                }}
              >
                <button
                  type="button"
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
                  type="button"
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
                    "",
                  )}
                </button>
              </div>
            </div>,
            null,
          )}
        </div>
      ),
      inputText,
      extractionPrompt,
      selections,
    };
  },
);

export default ExtractorModule;
