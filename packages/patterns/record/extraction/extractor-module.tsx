/// <cts-enable />
/**
 * Extractor Module - Controller sub-charm for LLM-assisted field extraction
 *
 * This is a "controller module" that acts on the parent Record's state.
 * It scans existing Notes, Text Imports, and Photos in the Record,
 * extracts structured data from their content, and updates modules.
 *
 * Key architecture:
 * - Receives parentSubCharms and parentTrashedSubCharms as INPUT Cells
 * - Scans for extractable sources: notes, text-import (text), photo (OCR)
 * - Uses generateObject() with dynamic schema from existing modules
 * - Shows diff view: currentValue -> extractedValue for each field
 * - Optionally trashes source modules after successful extraction
 * - Auto-trashes itself after successful apply
 */

import {
  Cell,
  computed,
  type Default,
  generateObject,
  generateText,
  handler,
  ifElse,
  type ImageData,
  NAME,
  recipe,
  UI,
} from "commontools";
import {
  buildExtractionSchema as buildFullSchema,
  createSubCharm,
  getFieldToTypeMapping as getFullFieldMapping,
} from "../registry.ts";
import type { SubCharmEntry, TrashedSubCharmEntry } from "../types.ts";
import type {
  ExtractableSource,
  ExtractedField,
  ExtractionPreview,
} from "./types.ts";
import type { JSONSchema } from "./schema-utils.ts";
import { getResultSchema, getSchemaForType } from "./schema-utils.ts";

// ===== Types =====

interface ExtractorModuleInput {
  // Parent's Cells - passed as INPUT so they survive serialization
  parentSubCharms: Cell<SubCharmEntry[]>;
  parentTrashedSubCharms: Cell<TrashedSubCharmEntry[]>;
  // Source selection state (index -> selected, default true)
  sourceSelections: Cell<
    Default<Record<number, boolean>, Record<number, never>>
  >;
  // Trash selection state (index -> should trash, default false)
  trashSelections: Cell<
    Default<Record<number, boolean>, Record<number, never>>
  >;
  // Field selections for preview
  selections: Cell<Default<Record<string, boolean>, Record<string, never>>>;
  // Extraction phase
  extractPhase: Cell<Default<"select" | "extracting" | "preview", "select">>;
  // Combined content for extraction (built from sources)
  extractionPrompt: Cell<Default<string, "">>;
  // Notes cleanup state
  cleanupNotesEnabled: Cell<Default<boolean, true>>;
  // Snapshot of Notes content at extraction start (for cleanup comparison)
  notesContentSnapshot: Cell<Default<string, "">>;
  // Cleanup application status tracking
  cleanupApplyStatus: Cell<
    Default<"pending" | "success" | "failed" | "skipped", "pending">
  >;
  // Apply in progress guard (prevents double-click race condition)
  applyInProgress: Cell<Default<boolean, false>>;
}

interface ExtractorModuleOutput {
  sourceSelections?: Default<Record<number, boolean>, Record<number, never>>;
  trashSelections?: Default<Record<number, boolean>, Record<number, never>>;
  selections?: Default<Record<string, boolean>, Record<string, never>>;
  extractPhase?: Default<"select" | "extracting" | "preview", "select">;
  extractionPrompt?: Default<string, "">;
  cleanupNotesEnabled?: Default<boolean, true>;
  notesContentSnapshot?: Default<string, "">;
  cleanupApplyStatus?: Default<
    "pending" | "success" | "failed" | "skipped",
    "pending"
  >;
  applyInProgress?: Default<boolean, false>;
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

const OCR_SYSTEM_PROMPT =
  `You are an OCR system. Extract all text from the provided image.
Return ONLY the extracted text, preserving formatting and line breaks.
Do not add any commentary, explanation, or formatting like markdown.
If no text is visible, return an empty string.`;

const NOTES_CLEANUP_SYSTEM_PROMPT =
  `You are a notes cleanup tool. Your ONLY output must be the cleaned text itself - nothing else.

Given original notes and a list of extracted fields, output a cleaned version with extracted data removed.

Rules:
1. Remove lines containing ONLY extracted data (e.g., "Email: john@example.com", "Phone: 555-1234")
2. Keep narrative text not captured in extracted fields
3. Keep formatting (headers, bullets, blank lines) where they make sense
4. If notes become empty, output empty string

CRITICAL: Output ONLY the cleaned text. No explanations, no markdown formatting, no commentary, no "here is the result", no thinking out loud. Just the cleaned content.`;

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
  // Use FULL field-to-type mapping from registry - enables creating new modules
  const fieldToType = getFullFieldMapping();
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

/**
 * Scan sub-charms for extractable content sources
 */
function scanExtractableSources(
  subCharms: readonly SubCharmEntry[],
): ExtractableSource[] {
  const sources: ExtractableSource[] = [];

  subCharms.forEach((entry, index) => {
    if (!entry) return;

    if (entry.type === "notes") {
      // Notes module - extract content
      const charm = entry.charm as Record<string, unknown>;
      const contentCell = charm?.content;
      const content = typeof contentCell === "object" &&
          contentCell !== null &&
          "get" in contentCell
        ? (contentCell as { get: () => unknown }).get()
        : contentCell;

      if (content && typeof content === "string" && content.trim()) {
        sources.push({
          index,
          type: "notes",
          icon: "\u{1F4DD}", // 📝
          label: "Notes",
          preview: content.slice(0, 100) + (content.length > 100 ? "..." : ""),
          content,
        });
      }
    } else if (entry.type === "text-import") {
      // Text Import module - extract content and filename
      const charm = entry.charm as Record<string, unknown>;
      const contentCell = charm?.content;
      const filenameCell = charm?.filename;

      const content = typeof contentCell === "object" &&
          contentCell !== null &&
          "get" in contentCell
        ? (contentCell as { get: () => unknown }).get()
        : contentCell;

      const filename = typeof filenameCell === "object" &&
          filenameCell !== null &&
          "get" in filenameCell
        ? (filenameCell as { get: () => unknown }).get()
        : filenameCell;

      if (content && typeof content === "string" && content.trim()) {
        const label = (filename && typeof filename === "string")
          ? filename
          : "Text Import";
        sources.push({
          index,
          type: "text-import",
          icon: "\u{1F4C4}", // 📄
          label,
          preview: content.slice(0, 100) + (content.length > 100 ? "..." : ""),
          content,
        });
      }
    } else if (entry.type === "photo") {
      // Photo module - needs OCR
      const charm = entry.charm as Record<string, unknown>;
      const imageCell = charm?.image;
      const labelCell = charm?.label;

      const image = typeof imageCell === "object" &&
          imageCell !== null &&
          "get" in imageCell
        ? (imageCell as { get: () => unknown }).get() as ImageData | null
        : imageCell as ImageData | null;

      const label = typeof labelCell === "object" &&
          labelCell !== null &&
          "get" in labelCell
        ? (labelCell as { get: () => unknown }).get()
        : labelCell;

      if (image && (image.data || image.url)) {
        sources.push({
          index,
          type: "photo",
          icon: "\u{1F4F7}", // 📷
          label: (label && typeof label === "string") ? label : "Photo",
          preview: "[Image - will use OCR]",
          requiresOCR: true,
          imageData: image,
        });
      }
    }
  });

  return sources;
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
 * Create a toggle source handler for a specific index
 */
function createToggleSourceHandler(
  index: number,
  sourceSelections: Cell<
    Default<Record<number, boolean>, Record<number, never>>
  >,
) {
  return handler<unknown, Record<string, never>>(
    () => {
      const current = sourceSelections.get() || {};
      // Default is selected (true), so toggle means: if undefined or true -> false, if false -> true
      const currentValue = current[index] !== false;
      sourceSelections.set({
        ...current,
        [index]: !currentValue,
      });
    },
  );
}

/**
 * Create a toggle trash handler for a specific index
 */
function createToggleTrashHandler(
  index: number,
  trashSelections: Cell<
    Default<Record<number, boolean>, Record<number, never>>
  >,
) {
  return handler<unknown, Record<string, never>>(
    () => {
      const current = trashSelections.get() || {};
      // Default is not selected (false)
      const currentValue = current[index] === true;
      trashSelections.set({
        ...current,
        [index]: !currentValue,
      });
    },
  );
}

/**
 * Handler to start extraction - defined at module scope
 */
const startExtraction = handler<
  unknown,
  {
    sourceSelectionsCell: Cell<
      Default<Record<number, boolean>, Record<number, never>>
    >;
    parentSubCharmsCell: Cell<SubCharmEntry[]>;
    extractionPromptCell: Cell<Default<string, "">>;
    extractPhaseCell: Cell<
      Default<"select" | "extracting" | "preview", "select">
    >;
    notesContentSnapshotCell: Cell<Default<string, "">>;
    ocrResultsValue: Record<number, string>;
  }
>(
  (
    _event,
    {
      sourceSelectionsCell,
      parentSubCharmsCell,
      extractionPromptCell,
      extractPhaseCell,
      notesContentSnapshotCell,
      ocrResultsValue,
    },
  ) => {
    // Use .get() to read Cell values inside handler
    const selectionsMap = sourceSelectionsCell.get() || {};
    const subCharmsData = parentSubCharmsCell.get() || [];
    const sources = scanExtractableSources(subCharmsData);

    // Build combined content from selected sources
    const parts: string[] = [];
    let notesContent = "";

    for (const source of sources) {
      // Skip if explicitly deselected
      if (selectionsMap[source.index] === false) continue;

      if (source.type === "notes" || source.type === "text-import") {
        if (source.content) {
          parts.push(`--- ${source.label} ---\n${source.content}`);
          // Capture Notes content for cleanup preview
          if (source.type === "notes") {
            notesContent = source.content;
          }
        }
      } else if (source.type === "photo") {
        // Include OCR text for photos
        const ocrText = ocrResultsValue[source.index];
        if (ocrText && ocrText.trim()) {
          parts.push(`--- ${source.label} (OCR) ---\n${ocrText}`);
        }
      }
    }

    const combinedContent = parts.join("\n\n");

    if (combinedContent.trim()) {
      // Snapshot Notes content for cleanup comparison
      notesContentSnapshotCell.set(notesContent as any);
      extractionPromptCell.set(combinedContent as any);
      extractPhaseCell.set("extracting" as any);
    }
  },
);

/**
 * Handler to apply selected extractions - defined at module scope
 */
const applySelected = handler<
  unknown,
  {
    parentSubCharmsCell: Cell<SubCharmEntry[]>;
    parentTrashedSubCharmsCell: Cell<TrashedSubCharmEntry[]>;
    extractionResultValue: Record<string, unknown> | null;
    selectionsCell: Cell<
      Default<Record<string, boolean>, Record<string, never>>
    >;
    trashSelectionsCell: Cell<
      Default<Record<number, boolean>, Record<number, never>>
    >;
    cleanupEnabledValue: boolean;
    cleanedNotesValue: string;
    cleanupApplyStatusCell: Cell<
      Default<"pending" | "success" | "failed" | "skipped", "pending">
    >;
    applyInProgressCell: Cell<Default<boolean, false>>;
  }
>(
  (
    _event,
    {
      parentSubCharmsCell,
      parentTrashedSubCharmsCell,
      extractionResultValue,
      selectionsCell,
      trashSelectionsCell,
      cleanupEnabledValue,
      cleanedNotesValue,
      cleanupApplyStatusCell,
      applyInProgressCell,
    },
  ) => {
    // Prevent double-click race condition using Cell state
    if (applyInProgressCell.get()) {
      console.debug("[Extract] Apply already in progress, ignoring");
      return;
    }
    applyInProgressCell.set(true as any);

    try {
      // Read Cells inside handler, filter out malformed entries
      const rawSubCharms = parentSubCharmsCell.get() || [];
      const subCharmsData = rawSubCharms.filter(
        (e): e is SubCharmEntry =>
          e != null && typeof e === "object" && "type" in e,
      );
      const extractionResult = extractionResultValue;
      if (!extractionResult) return;

      const previewData = buildPreview(extractionResult, subCharmsData);
      const sourcesData = scanExtractableSources(subCharmsData);

      if (!previewData || !previewData.fields) return;

      // Filter current entries too (defensive)
      const current: SubCharmEntry[] = (parentSubCharmsCell.get() || []).filter(
        (e): e is SubCharmEntry =>
          e != null && typeof e === "object" && "type" in e,
      );
      const subCharms = current; // For schema lookups
      const selected = selectionsCell.get() || {};
      const toTrash = trashSelectionsCell.get() || {};

      // Group fields by target module
      const fieldsByModule: Record<string, ExtractedField[]> = {};
      for (const field of previewData.fields) {
        const fieldKey = `${field.targetModule}.${field.fieldName}`;
        if (selected[fieldKey] === false) continue;

        if (!fieldsByModule[field.targetModule]) {
          fieldsByModule[field.targetModule] = [];
        }
        fieldsByModule[field.targetModule].push(field);
      }

      // Track success - only trash extractor if at least one update succeeded
      let anySuccess = false;

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
            const isValid = validateFieldValue(
              field.extractedValue,
              fieldSchema,
            );

            if (!isValid) {
              const actualType = Array.isArray(field.extractedValue)
                ? "array"
                : typeof field.extractedValue;
              console.warn(
                `[Extract] Type mismatch for ${moduleType}.${field.fieldName}: ` +
                  `expected ${fieldSchema?.type}, got ${actualType}. ` +
                  `Value: ${
                    JSON.stringify(field.extractedValue)
                  }. Skipping field.`,
              );
              continue; // Skip this field
            }

            try {
              // Only write if validation passed
              (parentSubCharmsCell as any).key(existingIndex).key("charm").key(
                field.fieldName,
              ).set(field.extractedValue);
              anySuccess = true;
            } catch (e) {
              console.warn(
                `Failed to set ${moduleType}.${field.fieldName}:`,
                e,
              );
            }
          }
        } else if (moduleType !== "notes") {
          // Module doesn't exist - create it with initial values
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
              const isValid = validateFieldValue(
                field.extractedValue,
                fieldSchema,
              );

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

            // Only create module if we have at least one valid field
            if (Object.keys(initialValues).length > 0) {
              const newCharm = createSubCharm(moduleType, initialValues);
              // Capture schema at creation time for dynamic discovery
              const schema = getResultSchema(newCharm);
              newEntries.push({
                type: moduleType,
                pinned: false,
                charm: newCharm,
                schema,
              });
              anySuccess = true;
            }
          } catch (e) {
            console.warn(`Failed to create module ${moduleType}:`, e);
          }
        }
      }

      // Only proceed with trashing if at least one update succeeded
      if (!anySuccess) {
        console.warn(
          "[Extract] No updates succeeded, keeping extractor for retry",
        );
        return;
      }

      // Apply Notes cleanup if enabled and we have cleaned content
      // We try multiple approaches:
      // 1. editContent stream handler (preferred - triggers UI reactivity)
      // 2. Cell key navigation fallback (data saves, UI may need refresh)
      if (cleanupEnabledValue && cleanedNotesValue !== undefined) {
        const notesIndex = current.findIndex((e) => e?.type === "notes");
        const notesEntry = notesIndex >= 0 ? current[notesIndex] : undefined;
        if (notesEntry) {
          let cleanupSucceeded = false;

          // Approach 1: Try editContent.send (best for UI reactivity)
          try {
            const notesCharm = notesEntry.charm as {
              editContent?: { send?: (data: unknown) => void };
            };
            if (notesCharm?.editContent?.send) {
              notesCharm.editContent.send({ detail: { value: cleanedNotesValue } });
              cleanupSucceeded = true;
              console.debug("[Extract] Applied Notes cleanup via editContent stream");
            }
          } catch (e) {
            console.warn("[Extract] editContent.send failed:", e);
          }

          // Approach 2: Fallback to Cell key navigation
          if (!cleanupSucceeded) {
            try {
              (parentSubCharmsCell as any).key(notesIndex).key("charm").key(
                "content",
              ).set(cleanedNotesValue);
              cleanupSucceeded = true;
              console.debug(
                "[Extract] Applied Notes cleanup via Cell key navigation (UI may need refresh)",
              );
            } catch (e) {
              console.warn("[Extract] Cell key navigation failed:", e);
            }
          }

          cleanupApplyStatusCell.set(
            cleanupSucceeded ? ("success" as any) : ("failed" as any),
          );
          if (!cleanupSucceeded) {
            console.warn(
              "[Extract] All Notes cleanup approaches failed",
            );
          }
        } else {
          cleanupApplyStatusCell.set("failed" as any);
          console.warn("[Extract] Notes entry not found for cleanup");
        }
      } else {
        cleanupApplyStatusCell.set("skipped" as any);
      }

      // Collect indices to trash (sources + self, excluding Notes)
      const indicesToTrash: number[] = [];

      // Add selected source indices to trash list (excluding Notes - Notes is never trashed)
      for (const source of sourcesData) {
        if (source.type === "notes") continue; // Never trash Notes
        if (toTrash[source.index] === true) {
          indicesToTrash.push(source.index);
        }
      }

      // Find self (extractor) index - only trash if updates succeeded
      const selfIndex = current.findIndex((e) => e?.type === "extractor");
      if (selfIndex >= 0) {
        indicesToTrash.push(selfIndex);
      }

      // Sort descending to preserve indices when removing
      indicesToTrash.sort((a, b) => b - a);

      // Move items to trash
      for (const idx of indicesToTrash) {
        const entry = current[idx];
        if (entry) {
          parentTrashedSubCharmsCell.push({
            ...entry,
            trashedAt: new Date().toISOString(),
          });
        }
      }

      // Build final list: remove trashed items, add new entries
      const remaining = current.filter((_, i) => !indicesToTrash.includes(i));
      const final = [...remaining, ...newEntries];
      parentSubCharmsCell.set(final);
    } finally {
      applyInProgressCell.set(false as any);
    }
  },
);

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
      sourceSelections,
      trashSelections,
      selections,
      extractPhase,
      extractionPrompt,
      cleanupNotesEnabled,
      notesContentSnapshot,
      cleanupApplyStatus,
      applyInProgress,
    },
  ) => {
    // Use FULL registry schema - enables extraction to create new modules
    // This includes all available module types, not just existing ones
    const extractSchema = computed(() => {
      return buildFullSchema() as JSONSchema;
    });

    // Scan for extractable sources
    const extractableSources = computed((): ExtractableSource[] => {
      const subCharms = parentSubCharms.get() || [];
      return scanExtractableSources(subCharms);
    });

    // Check if any sources are selected
    const hasSelectedSources = computed(() => {
      const sources = extractableSources;
      const selectionsMap = sourceSelections.get() || {};
      if (!sources || sources.length === 0) return false;
      // At least one source must not be explicitly deselected
      return sources.some((s: ExtractableSource) =>
        selectionsMap[s.index] !== false
      );
    });

    // Count selected sources
    const selectedSourceCount = computed(() => {
      const sources = extractableSources;
      const selectionsMap = sourceSelections.get() || {};
      if (!sources) return 0;
      return sources.filter((s: ExtractableSource) =>
        selectionsMap[s.index] !== false
      ).length;
    });

    // Build OCR prompts for selected photos
    const photoSources = computed(() => {
      const sources = extractableSources;
      const selectionsMap = sourceSelections.get() || {};
      if (!sources) return [];
      return sources.filter(
        (s: ExtractableSource) =>
          s.type === "photo" && s.requiresOCR &&
          selectionsMap[s.index] !== false,
      );
    });

    // Build OCR prompt for the first selected photo
    // For simplicity, we handle one photo at a time
    const ocrPrompt = computed(() => {
      const photos = photoSources;
      if (!photos || photos.length === 0) return undefined;

      // Get the first selected photo
      const photo = photos[0];
      if (!photo?.imageData) return undefined;

      const imageUrl = photo.imageData.data || photo.imageData.url;
      if (!imageUrl) return undefined;

      return [
        { type: "image" as const, image: imageUrl },
        {
          type: "text" as const,
          text: "Extract all text from this image exactly as written.",
        },
      ];
    });

    // Single OCR call for the first photo
    const ocr = generateText({
      system: OCR_SYSTEM_PROMPT,
      prompt: ocrPrompt,
      model: "anthropic:claude-sonnet-4-5",
    });

    // Check if OCR is pending
    const ocrPending = computed(() => {
      const photos = photoSources;
      if (!photos || photos.length === 0) return false;
      return Boolean(ocr.pending);
    });

    // Get OCR results as a map (index -> text)
    const ocrResults = computed((): Record<number, string> => {
      const photos = photoSources;
      const results: Record<number, string> = {};
      if (!photos || photos.length === 0) return results;

      // For the first photo, use the OCR result
      if (photos[0] && ocr.result) {
        results[photos[0].index] = ocr.result as string;
      }
      return results;
    });

    // Reactive extraction - only runs when extractionPrompt is set
    const extraction = generateObject({
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: extractionPrompt,
      schema: extractSchema as any,
      model: "anthropic:claude-haiku-4-5",
    } as any);

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
      const sel = selections.get() || {};
      return p.fields.filter((f: ExtractedField) => {
        const key = `${f.targetModule}.${f.fieldName}`;
        return sel[key] !== false; // Default is selected
      }).length;
    });

    // Determine current phase based on state
    const currentPhase = computed(() => {
      const phase = extractPhase.get() || "select";
      if (phase === "extracting") {
        if (extraction.pending) return "extracting";
        if (extraction.error) return "error";
        if (preview?.fields?.length) return "preview";
        if (extraction.result && !preview?.fields?.length) return "no-results";
        return "extracting";
      }
      return phase;
    });

    // Format extracted fields as text for preview display
    const previewText = computed(() => {
      if (!extraction.result) return "No fields extracted";
      const subCharms = parentSubCharms.get() || [];
      const previewData = buildPreview(extraction.result, subCharms);
      if (!previewData?.fields?.length) return "No fields extracted";
      return previewData.fields.map((f: ExtractedField) => {
        const current = formatValue(f.currentValue);
        const extracted = formatValue(f.extractedValue);
        return `${f.targetModule}.${f.fieldName}: ${current} -> ${extracted}`;
      }).join("\n");
    });

    // Build cleanup prompt for Notes - only when extraction succeeds and Notes was used
    const cleanupPrompt = computed(() => {
      const rawSnapshot = notesContentSnapshot.get();
      // Handle Default type - may be object or string
      const snapshot = typeof rawSnapshot === "string" ? rawSnapshot : "";
      const rawPhase = extractPhase.get();
      const phase = typeof rawPhase === "string" ? rawPhase : "select";

      // Only generate cleanup when we have extraction results and Notes content
      if (phase !== "extracting" && phase !== "preview") return undefined;
      if (!extraction.result) return undefined;
      if (!snapshot.trim()) return undefined;

      // Build a summary of what was extracted
      const extractedSummary: string[] = [];
      const result = extraction.result as Record<string, unknown>;
      for (const [key, value] of Object.entries(result)) {
        if (value !== null && value !== undefined) {
          const formattedValue = Array.isArray(value)
            ? value.join(", ")
            : String(value);
          extractedSummary.push(`- ${key}: ${formattedValue}`);
        }
      }

      if (extractedSummary.length === 0) return undefined;

      return `Original notes:
${snapshot}

Extracted fields to remove:
${extractedSummary.join("\n")}`;
    });

    // Cleanup call - runs in parallel with extraction review
    const notesCleanup = generateText({
      system: NOTES_CLEANUP_SYSTEM_PROMPT,
      prompt: cleanupPrompt,
      model: "anthropic:claude-haiku-4-5",
    });

    // Check if Notes cleanup is pending
    const cleanupPending = computed(() => {
      const rawSnapshot = notesContentSnapshot.get();
      const snapshot = typeof rawSnapshot === "string" ? rawSnapshot : "";
      if (!snapshot.trim()) return false;
      return Boolean(notesCleanup.pending);
    });

    // Check if cleanup has an error
    const cleanupHasError = computed(() => {
      return Boolean(notesCleanup.error);
    });

    // Get the cleaned Notes content (or original if cleanup disabled/failed)
    const cleanedNotesContent = computed(() => {
      const rawEnabled = cleanupNotesEnabled.get();
      const enabled = typeof rawEnabled === "boolean" ? rawEnabled : true;
      const rawSnapshot = notesContentSnapshot.get();
      const snapshot = typeof rawSnapshot === "string" ? rawSnapshot : "";

      if (!enabled) return snapshot;
      if (notesCleanup.error) return snapshot;
      if (!notesCleanup.result) return snapshot;

      // Validate result - should be string
      const result = notesCleanup.result;
      if (typeof result !== "string") return snapshot;

      return result.trim();
    });

    // Check if there are meaningful changes to Notes
    const hasNotesChanges = computed(() => {
      const rawSnapshot = notesContentSnapshot.get();
      const snapshot = typeof rawSnapshot === "string" ? rawSnapshot : "";
      if (!snapshot.trim()) return false;

      const cleaned = cleanedNotesContent;
      return cleaned !== snapshot;
    });

    // Total changes count includes Notes cleanup when enabled
    const totalChangesCount = computed(() => {
      // Dereference selectedCount to get the actual number value
      const baseCount = Number(selectedCount) || 0;
      // Add 1 for Notes cleanup if enabled and has actual changes
      const rawEnabled = cleanupNotesEnabled.get();
      const enabled = typeof rawEnabled === "boolean" ? rawEnabled : true;
      const hasChanges = Boolean(hasNotesChanges);
      if (enabled && hasChanges) {
        return baseCount + 1;
      }
      return baseCount;
    });

    // Count sources selected for trash (excluding Notes - Notes is never trashed)
    const trashCount = computed(() => {
      const sources = extractableSources;
      const trashMap = trashSelections.get() || {};
      if (!sources) return 0;
      return sources.filter((s: ExtractableSource) =>
        s.type !== "notes" && trashMap[s.index] === true
      ).length;
    });

    // Phase-related computed values (defined at statement level for stable node identity)
    const isPreviewPhase = computed(() => currentPhase === "preview");
    const isSelectPhase = computed(() => currentPhase === "select");
    const isExtractingPhase = computed(() => currentPhase === "extracting");
    const isErrorPhase = computed(() => currentPhase === "error");
    const isNoResultsPhase = computed(() => currentPhase === "no-results");
    const hasNoSources = computed(() => extractableSources.length === 0);
    const isSingleSource = computed(() => selectedSourceCount === 1);
    const extractButtonDisabled = computed(() => !hasSelectedSources || ocrPending);
    const extractButtonBackground = computed(() =>
      hasSelectedSources && !ocrPending ? "#f59e0b" : "#d1d5db"
    );
    const extractButtonCursor = computed(() =>
      hasSelectedSources && !ocrPending ? "pointer" : "not-allowed"
    );
    const isCleanedNotesEmpty = computed(() => cleanedNotesContent === "");
    const hasMultipleChanges = computed(() => totalChangesCount !== 1);
    const hasTrashItems = computed(() => trashCount > 0);

    // Preview phase computed values
    const hasNotesSnapshot = computed(() => {
      const rawSnapshot = notesContentSnapshot.get();
      const snapshot = typeof rawSnapshot === "string" ? rawSnapshot : "";
      return snapshot.trim().length > 0;
    });
    const showCleanupPreview = computed(() => {
      const rawEnabled = cleanupNotesEnabled.get();
      const enabled = typeof rawEnabled === "boolean" ? rawEnabled : true;
      return enabled && hasNotesChanges;
    });
    const cleanupDisabled = computed(() => {
      const rawEnabled = cleanupNotesEnabled.get();
      const enabled = typeof rawEnabled === "boolean" ? rawEnabled : true;
      return !enabled;
    });
    const hasTrashableSources = computed(() =>
      extractableSources.filter((s: ExtractableSource) => s.type !== "notes").length > 0
    );
    const cleanupFailed = computed(() => {
      const status = cleanupApplyStatus.get();
      return status === "failed";
    });
    const applyButtonBackground = computed(() =>
      cleanupPending ? "#d1d5db" : "#059669"
    );
    const applyButtonCursor = computed(() =>
      cleanupPending ? "not-allowed" : "pointer"
    );

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
              {ifElse(isPreviewPhase, "Review Changes", "AI Extract")}
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
              x
            </button>
          </div>

          {/* Select Sources Phase */}
          {ifElse(
            isSelectPhase,
            <div
              style={{ display: "flex", flexDirection: "column", gap: "12px" }}
            >
              {ifElse(
                hasNoSources,
                <div
                  style={{
                    padding: "16px",
                    background: "white",
                    borderRadius: "6px",
                    textAlign: "center",
                    color: "#6b7280",
                  }}
                >
                  <div style={{ marginBottom: "8px" }}>
                    No extractable sources found.
                  </div>
                  <div style={{ fontSize: "13px" }}>
                    Add Notes, Text Import, or Photo modules first.
                  </div>
                </div>,
                <div>
                  <div
                    style={{
                      marginBottom: "8px",
                      fontSize: "13px",
                      color: "#6b7280",
                    }}
                  >
                    Select sources to extract from:
                  </div>
                  <div
                    style={{
                      background: "white",
                      borderRadius: "6px",
                      border: "1px solid #e5e7eb",
                      overflow: "hidden",
                    }}
                  >
                    {extractableSources.map((source: ExtractableSource) => (
                      <div
                        key={source.index}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: "8px",
                          padding: "10px 12px",
                          borderBottom: "1px solid #f3f4f6",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={computed(
                            () =>
                              (sourceSelections.get() || {})[source.index] !==
                                false,
                          )}
                          onChange={createToggleSourceHandler(
                            source.index,
                            sourceSelections,
                          )({})}
                          style={{ marginTop: "2px" }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              marginBottom: "4px",
                            }}
                          >
                            <span>{source.icon}</span>
                            <span
                              style={{ fontWeight: "500", color: "#374151" }}
                            >
                              {source.label}
                            </span>
                            {source.requiresOCR && (
                              <span
                                style={{
                                  fontSize: "11px",
                                  color: "#6b7280",
                                  background: "#f3f4f6",
                                  padding: "1px 6px",
                                  borderRadius: "4px",
                                }}
                              >
                                OCR
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: "12px",
                              color: "#9ca3af",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {source.preview}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* OCR pending indicator */}
                  {ifElse(
                    ocrPending,
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "8px",
                        background: "#f3f4f6",
                        borderRadius: "6px",
                        fontSize: "13px",
                        color: "#6b7280",
                      }}
                    >
                      <ct-loader size="sm" />
                      <span>Running OCR on photos...</span>
                    </div>,
                    null,
                  )}

                  {/* Extract button */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      marginTop: "8px",
                    }}
                  >
                    <button
                      type="button"
                      disabled={extractButtonDisabled}
                      onClick={startExtraction({
                        sourceSelectionsCell: sourceSelections,
                        parentSubCharmsCell: parentSubCharms,
                        extractionPromptCell: extractionPrompt,
                        extractPhaseCell: extractPhase,
                        notesContentSnapshotCell: notesContentSnapshot,
                        ocrResultsValue: ocrResults,
                      })}
                      style={{
                        padding: "8px 16px",
                        background: extractButtonBackground,
                        color: "white",
                        border: "none",
                        borderRadius: "6px",
                        cursor: extractButtonCursor,
                        fontSize: "14px",
                        fontWeight: "500",
                      }}
                    >
                      Extract from {selectedSourceCount} source
                      {ifElse(isSingleSource, "", "s")}
                    </button>
                  </div>
                </div>,
              )}
            </div>,
            null,
          )}

          {/* Extracting state */}
          {ifElse(
            isExtractingPhase,
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

          {/* Error state */}
          {ifElse(
            isErrorPhase,
            <div
              style={{ display: "flex", flexDirection: "column", gap: "12px" }}
            >
              <div
                style={{
                  padding: "12px",
                  background: "#fee2e2",
                  borderRadius: "6px",
                  color: "#991b1b",
                  fontSize: "13px",
                }}
              >
                Extraction failed. Try again or add more content.
              </div>
              <button
                type="button"
                onClick={() => {
                  extractPhase.set("select");
                  extractionPrompt.set("");
                }}
                style={{
                  padding: "8px 16px",
                  background: "#f59e0b",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                Try Again
              </button>
            </div>,
            null,
          )}

          {/* No results state */}
          {ifElse(
            isNoResultsPhase,
            <div
              style={{ display: "flex", flexDirection: "column", gap: "12px" }}
            >
              <div
                style={{
                  padding: "12px",
                  background: "#f3f4f6",
                  borderRadius: "6px",
                  color: "#6b7280",
                  fontSize: "13px",
                  textAlign: "center",
                }}
              >
                No structured data found in the selected sources.
              </div>
              <button
                type="button"
                onClick={() => {
                  extractPhase.set("select");
                  extractionPrompt.set("");
                }}
                style={{
                  padding: "8px 16px",
                  background: "white",
                  border: "1px solid #d1d5db",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                Back to Sources
              </button>
            </div>,
            null,
          )}

          {/* Preview state - diff view */}
          {ifElse(
            isPreviewPhase,
            <div
              style={{ display: "flex", flexDirection: "column", gap: "16px" }}
            >
              {/* Extracted fields */}
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
                    fontFamily: "monospace",
                  }}
                >
                  {previewText}
                </div>
              </div>

              {/* Notes cleanup section */}
              {ifElse(
                hasNotesSnapshot,
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
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: "8px",
                    }}
                  >
                    <div
                      style={{
                        fontWeight: "500",
                        color: "#374151",
                        fontSize: "13px",
                      }}
                    >
                      Clean up Notes
                    </div>
                    <label
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        fontSize: "12px",
                        color: "#6b7280",
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={cleanupNotesEnabled}
                        onChange={() => {
                          const rawCurrent = cleanupNotesEnabled.get();
                          const current = typeof rawCurrent === "boolean"
                            ? rawCurrent
                            : true;
                          cleanupNotesEnabled.set(!current as any);
                        }}
                      />
                      Enable cleanup
                    </label>
                  </div>

                  {/* Cleanup pending indicator */}
                  {ifElse(
                    cleanupPending,
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "8px",
                        background: "#f3f4f6",
                        borderRadius: "6px",
                        fontSize: "13px",
                        color: "#6b7280",
                      }}
                    >
                      <ct-loader size="sm" />
                      <span>Generating cleanup preview...</span>
                    </div>,
                    <div>
                      {/* Cleanup error message */}
                      {ifElse(
                        cleanupHasError,
                        <div
                          style={{
                            padding: "8px",
                            background: "#fee2e2",
                            borderRadius: "6px",
                            fontSize: "13px",
                            color: "#991b1b",
                            marginBottom: "8px",
                          }}
                        >
                          Cleanup failed - Notes will remain unchanged
                        </div>,
                        null,
                      )}

                      {/* Before/After preview when cleanup enabled */}
                      {ifElse(
                        showCleanupPreview,
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                          <div
                            style={{
                              fontSize: "12px",
                              color: "#9ca3af",
                            }}
                          >
                            Extracted data will be removed from Notes:
                          </div>
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "1fr 1fr",
                              gap: "8px",
                            }}
                          >
                            <div>
                              <div
                                style={{
                                  fontSize: "11px",
                                  color: "#ef4444",
                                  fontWeight: "500",
                                  marginBottom: "4px",
                                }}
                              >
                                Before:
                              </div>
                              <div
                                style={{
                                  fontSize: "12px",
                                  color: "#6b7280",
                                  background: "#fef2f2",
                                  padding: "8px",
                                  borderRadius: "4px",
                                  whiteSpace: "pre-wrap",
                                  maxHeight: "120px",
                                  overflow: "auto",
                                  fontFamily: "monospace",
                                }}
                              >
                                {notesContentSnapshot}
                              </div>
                            </div>
                            <div>
                              <div
                                style={{
                                  fontSize: "11px",
                                  color: "#22c55e",
                                  fontWeight: "500",
                                  marginBottom: "4px",
                                }}
                              >
                                After:
                              </div>
                              <div
                                style={{
                                  fontSize: "12px",
                                  color: "#6b7280",
                                  background: "#f0fdf4",
                                  padding: "8px",
                                  borderRadius: "4px",
                                  whiteSpace: "pre-wrap",
                                  maxHeight: "120px",
                                  overflow: "auto",
                                  fontFamily: "monospace",
                                }}
                              >
                                {ifElse(
                                  isCleanedNotesEmpty,
                                  <span style={{ fontStyle: "italic", color: "#9ca3af" }}>
                                    (empty)
                                  </span>,
                                  cleanedNotesContent,
                                )}
                              </div>
                            </div>
                          </div>
                        </div>,
                        <div
                          style={{
                            fontSize: "12px",
                            color: "#9ca3af",
                            fontStyle: "italic",
                          }}
                        >
                          {ifElse(
                            cleanupDisabled,
                            "Cleanup disabled - Notes will remain unchanged",
                            "No changes needed to Notes content",
                          )}
                        </div>,
                      )}
                    </div>,
                  )}
                </div>,
                null,
              )}

              {/* Trash imported sources section (Photos, Text Imports only - not Notes) */}
              {ifElse(
                hasTrashableSources,
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
                      fontSize: "13px",
                    }}
                  >
                    Trash imported sources?
                  </div>
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#9ca3af",
                      marginBottom: "8px",
                    }}
                  >
                    Select imported files to move to trash:
                  </div>
                  {extractableSources
                    .filter((source: ExtractableSource) => source.type !== "notes")
                    .map((source: ExtractableSource) => (
                      <div
                        key={source.index + 1000}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          padding: "6px 0",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={computed(
                            () =>
                              (trashSelections.get() || {})[source.index] ===
                                true,
                          )}
                          onChange={createToggleTrashHandler(
                            source.index,
                            trashSelections,
                          )({})}
                        />
                        <span style={{ fontSize: "13px", color: "#6b7280" }}>
                          {source.icon} {source.label}
                        </span>
                      </div>
                    ))}
                </div>,
                null,
              )}

              {/* Cleanup failure warning */}
              {ifElse(
                cleanupFailed,
                <div
                  style={{
                    padding: "12px",
                    background: "#fef2f2",
                    border: "1px solid #fecaca",
                    borderRadius: "6px",
                    color: "#991b1b",
                    fontSize: "13px",
                  }}
                >
                  <div style={{ fontWeight: "500", marginBottom: "4px" }}>
                    Warning: Notes cleanup failed
                  </div>
                  <div style={{ fontSize: "12px", color: "#dc2626" }}>
                    The extracted fields were applied successfully, but the Notes
                    module could not be cleaned up. The original content remains
                    unchanged. Check the console for details.
                  </div>
                </div>,
                null,
              )}

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
                  onClick={() => {
                    extractPhase.set("select");
                    extractionPrompt.set("");
                  }}
                  style={{
                    padding: "8px 16px",
                    background: "white",
                    border: "1px solid #d1d5db",
                    borderRadius: "6px",
                    cursor: "pointer",
                    fontSize: "14px",
                  }}
                >
                  Back
                </button>
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
                  disabled={cleanupPending}
                  onClick={applySelected({
                    parentSubCharmsCell: parentSubCharms,
                    parentTrashedSubCharmsCell: parentTrashedSubCharms,
                    extractionResultValue: extraction.result as
                      | Record<string, unknown>
                      | null,
                    selectionsCell: selections,
                    trashSelectionsCell: trashSelections,
                    cleanupEnabledValue: (() => {
                      const rawEnabled = cleanupNotesEnabled.get();
                      return typeof rawEnabled === "boolean" ? rawEnabled : true;
                    })(),
                    cleanedNotesValue: (() => {
                      // Dereference the computed value
                      const value = cleanedNotesContent;
                      return typeof value === "string" ? value : "";
                    })(),
                    cleanupApplyStatusCell: cleanupApplyStatus,
                    applyInProgressCell: applyInProgress,
                  })}
                  style={{
                    padding: "8px 16px",
                    background: applyButtonBackground,
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    cursor: applyButtonCursor,
                    fontSize: "14px",
                    fontWeight: "500",
                  }}
                >
                  {ifElse(
                    cleanupPending,
                    "Preparing cleanup...",
                    <>
                      Apply {totalChangesCount} Change{ifElse(
                        hasMultipleChanges,
                        "s",
                        "",
                      )}
                      {ifElse(
                        hasTrashItems,
                        <span>& Trash {trashCount}</span>,
                        "",
                      )}
                    </>,
                  )}
                </button>
              </div>
            </div>,
            null,
          )}
        </div>
      ),
      sourceSelections,
      trashSelections,
      selections,
      extractPhase,
      extractionPrompt,
      cleanupNotesEnabled,
      notesContentSnapshot,
      cleanupApplyStatus,
      applyInProgress,
    };
  },
);

export default ExtractorModule;
