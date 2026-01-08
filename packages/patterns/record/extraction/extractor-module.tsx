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
  getDefinition,
  getFieldToTypeMapping as getFullFieldMapping,
  SUB_CHARM_REGISTRY,
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
  // Parent Record's title Cell - for extracting names to Record title
  parentTitle: Cell<string>;
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
  // Map of subCharm index (as string) -> original content for ALL selected Notes modules
  // NOTE: Uses string keys to avoid Cell coercing numeric keys to array indices
  notesContentSnapshot: Cell<
    Default<Record<string, string>, Record<string, never>>
  >;
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
  notesContentSnapshot?: Default<Record<string, string>, Record<string, never>>;
  cleanupApplyStatus?: Default<
    "pending" | "success" | "failed" | "skipped",
    "pending"
  >;
  applyInProgress?: Default<boolean, false>;
}

// ===== Constants =====

const EXTRACTION_SYSTEM_PROMPT =
  `You are a precise data extractor for STRUCTURED fields from text like signatures, bios, or vCards.

=== Field Ownership (fields belong to specific modules) ===
- Phone: "number" only (preserve formatting)
- Email: "address" only
- Address: "street", "city", "state", "zip"
- Social: "platform" (twitter/linkedin/github/instagram/facebook/youtube/tiktok/mastodon/bluesky), "handle" (without @), "profileUrl"
- Birthday: "birthMonth" (1-12), "birthDay" (1-31), "birthYear" (YYYY) as separate strings
- Location: "locationName", "locationAddress", "coordinates"
- Link: "url", "linkTitle", "description"
- Dietary: "restrictions" as array of {name, level} objects where:
  - name: the restriction item (e.g., "nightshades", "peanuts", "gluten", "vegetarian")
  - level: severity level based on context:
    - "absolute": Medical necessity, allergies, anaphylaxis risk, religious requirements - no exceptions ever
    - "strict": Strong avoidance, ethical commitment (e.g., vegan lifestyle) - very important but not medical
    - "prefer": General preference or mild intolerance - would rather avoid but can be flexible
    - "flexible": Slight preference - only if convenient
  - Examples: [{"name": "peanuts", "level": "absolute"}, {"name": "dairy", "level": "prefer"}]
  - Infer severity from context clues (allergies→absolute, preferences→prefer, etc.)

=== What TO Extract (structured data only) ===
- Email addresses, phone numbers, physical addresses
- Social media handles and profile URLs
- Specific dates (birthdays, anniversaries)
- Explicit dietary restrictions or allergies (e.g. "allergic to peanuts", "vegetarian", "gluten-free")
- URLs and links

=== What NOT to Extract (leave in Notes) ===
- Vague preferences: "loves coffee", "enjoys hiking", "likes rabbits"
- Opinions or personality traits: "is very friendly", "great sense of humor"
- Conversational text or context: "met at the conference", "works with Sarah"
- Gift ideas unless explicitly labeled: "loves bonny rabbits" is NOT a gift preference
- Hobby mentions: "plays guitar", "into photography"
- Food preferences that aren't restrictions: "loves Italian food", "favorite is pizza"

=== Rules ===
1. Only extract EXPLICITLY STRUCTURED data (emails, phones, dates, addresses, URLs)
2. Return null for missing fields - when in doubt, return null
3. Arrays (tags, restrictions): use simple string arrays like ["item1", "item2"]
4. DO NOT extract labels like "Mobile", "Work", "Personal" as separate fields - these are UI defaults
5. Normalize social platforms to lowercase (X/Twitter -> "twitter", Insta -> "instagram")
6. Preserve original formatting for phone numbers
7. Be VERY conservative - leave conversational/descriptive text for the user to read in Notes
8. "Loves X", "likes X", "enjoys X" should NEVER be extracted unless X is an explicit dietary restriction

Return JSON with extracted fields. Use null for missing data. Prefer leaving text in Notes over aggressive extraction.`;

const OCR_SYSTEM_PROMPT =
  `You are an OCR system. Extract all text from the provided image.
Return ONLY the extracted text, preserving formatting and line breaks.
Do not add any commentary, explanation, or formatting like markdown.
If no text is visible, return an empty string.`;

// NOTES_CLEANUP via extraction result:
// =====================================
// Instead of running a separate LLM cleanup call (which was broken - it only got
// field summaries like "email: john@example.com" but had no way to know which
// SPECIFIC text patterns like "Loves bunny rabbits" were NOT extracted), we now
// use the extraction result's `notes` or `content` field directly.
//
// The extraction schema (from registry.ts) includes a `notes` field via the
// Notes module's fieldMapping: ["content", "notes"]. This means when the LLM
// extracts structured data, it ALSO explicitly outputs what should remain in
// Notes via the `notes` field.
//
// This approach is:
// - Simpler: No extra LLM call needed
// - Faster: One LLM call instead of two
// - More accurate: The extraction LLM has full context and explicitly says
//   what should STAY in Notes (the `notes` field output)
// - Correct: We use what the LLM says to KEEP, not trying to infer what to REMOVE
//
// The extraction prompt already instructs the LLM what NOT to extract
// (preferences, personality traits, conversational text), so the `notes` field
// contains exactly what should stay in Notes after extraction.

// ===== Helper Functions =====

/**
 * Normalize LLM "null" string responses to actual null values.
 *
 * WORKAROUND: LLMs sometimes return the literal string "null" instead of JSON null.
 * This happens because nullable types in schemas are represented as anyOf with string,
 * and schema descriptions like "Null if X" cause the LLM to output "null" as text.
 * Since "null" is a valid JSON string, it passes validation but breaks downstream logic.
 *
 * See: community-docs/superstitions/2025-11-29-llm-generateObject-returns-string-null.md
 */
function normalizeNullString(value: unknown): unknown {
  if (typeof value === "string" && value.toLowerCase() === "null") {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeNullString);
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = normalizeNullString(v);
    }
    return result;
  }
  return value;
}

/**
 * Get the primary field name for a module type.
 * fieldMapping arrays list related fields; only fields NOT in the schema
 * are treated as aliases for the first entry.
 * E.g., notes has ["content", "notes"] where only "content" is in schema,
 * so "notes" maps to "content". But social has ["platform", "handle", "profileUrl"]
 * where all three are in schema, so each is used directly.
 */
function getPrimaryFieldName(
  fieldName: string,
  moduleType: string,
): string {
  const def = SUB_CHARM_REGISTRY[moduleType];
  if (!def?.fieldMapping || def.fieldMapping.length === 0) {
    return fieldName; // No mapping, use as-is
  }

  // If field exists in schema, use it directly (not an alias)
  if (def.schema && def.schema[fieldName]) {
    return fieldName;
  }

  // Only treat as alias if NOT in schema but IS in fieldMapping
  if (def.fieldMapping.includes(fieldName)) {
    return def.fieldMapping[0];
  }

  return fieldName; // Not in mapping, use as-is
}

// Anthropic Vision API limit is approximately 5MB for base64 images
// Base64 encoding increases size by ~33%, so limit raw data size
const MAX_IMAGE_SIZE_BYTES = 3_500_000; // ~3.5MB to be safe with base64 overhead

/**
 * Check if a base64 data URL is within size limits for vision API
 */
function isImageWithinSizeLimit(dataUrl: string): boolean {
  if (!dataUrl) return false;
  // Data URL format: data:image/...;base64,<data>
  const base64Index = dataUrl.indexOf(",");
  if (base64Index === -1) return true; // Not a data URL, assume it's a regular URL
  const base64Data = dataUrl.slice(base64Index + 1);
  // Base64 is ~4/3 of original size, so multiply by 0.75 to get approximate raw size
  const approximateSize = base64Data.length * 0.75;
  return approximateSize <= MAX_IMAGE_SIZE_BYTES;
}

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
 * Check if a value is "empty" (null, undefined, empty string, empty array, or "null" string)
 *
 * Note: Also treats the literal string "null" as empty (LLM workaround - see normalizeNullString)
 */
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (value === "") return true;
  // Treat "null" string as empty (LLM sometimes returns "null" instead of null)
  if (typeof value === "string" && value.toLowerCase() === "null") return true;
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
 *
 * Note: Normalizes "null" strings to null before validation (LLM workaround)
 */
function validateFieldValue(
  value: unknown,
  schema: JSONSchema | undefined,
): boolean {
  // Normalize "null" strings to actual null before validation
  const normalizedValue = normalizeNullString(value);

  // No schema = allow anything (permissive for dynamic fields)
  if (!schema || !schema.type) return true;

  // After normalization, null is always valid (field will be skipped in buildPreview)
  if (normalizedValue === null) return true;

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
 * @param currentTitle - Current Record title (for "record-title" pseudo-type)
 *
 * Note: Normalizes "null" strings to null before processing (LLM workaround)
 */
function buildPreview(
  extracted: Record<string, unknown>,
  subCharms: readonly SubCharmEntry[],
  currentTitle?: string,
): ExtractionPreview {
  // Normalize "null" strings to actual null in the entire extraction result
  const normalizedExtracted = normalizeNullString(extracted) as Record<
    string,
    unknown
  >;

  // Use FULL field-to-type mapping from registry - enables creating new modules
  const fieldToType = getFullFieldMapping();
  const fields: ExtractedField[] = [];
  const byModule: Record<string, ExtractedField[]> = {};

  for (
    const [fieldName, extractedValue] of Object.entries(normalizedExtracted)
  ) {
    // Skip null/undefined values (including normalized "null" strings)
    if (extractedValue === null || extractedValue === undefined) continue;

    const moduleType = fieldToType[fieldName];
    if (!moduleType) continue;

    // Special handling for "record-title" pseudo-type (name -> Record title)
    if (moduleType === "record-title") {
      // Compare against current Record title
      if (currentTitle === extractedValue) continue;

      const field: ExtractedField = {
        fieldName: "name",
        targetModule: "record-title",
        extractedValue,
        currentValue: currentTitle || undefined,
      };

      fields.push(field);

      if (!byModule["record-title"]) byModule["record-title"] = [];
      byModule["record-title"].push(field);
      continue;
    }

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

  // Handle array extraction mode (e.g., customFields for custom-field module)
  // Modules with extractionMode: "array" extract an array where each item
  // becomes a separate module instance
  for (const def of Object.values(SUB_CHARM_REGISTRY)) {
    if (def.extractionMode !== "array" || !def.fieldMapping) continue;

    // Get the array field name (first entry in fieldMapping)
    const arrayFieldName = def.fieldMapping[0];
    const extractedArray = normalizedExtracted[arrayFieldName];

    if (!Array.isArray(extractedArray) || extractedArray.length === 0) continue;

    // Each array item becomes a separate ExtractedField with isNewInstance flag
    for (const item of extractedArray) {
      if (!item || typeof item !== "object") continue;

      // For custom-field: item has fieldName, fieldValue, fieldType
      // Create a display name for the field
      const itemName = (item as Record<string, unknown>).fieldName ||
        (item as Record<string, unknown>).name ||
        "Custom Field";

      const field: ExtractedField = {
        fieldName: `${arrayFieldName}:${itemName}`,
        targetModule: def.type,
        extractedValue: item,
        currentValue: undefined, // New instances don't have current values
        isNewInstance: true,
      };

      fields.push(field);

      if (!byModule[def.type]) byModule[def.type] = [];
      byModule[def.type].push(field);
    }
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
        // Replace newlines with spaces for clean single-line preview display
        const cleanPreview = content.replace(/\n+/g, " ").trim();
        sources.push({
          index,
          type: "notes",
          icon: "\u{1F4DD}", // 📝
          label: "Notes",
          preview: cleanPreview.slice(0, 100) +
            (cleanPreview.length > 100 ? "..." : ""),
          content,
        });
      } else {
        // Include empty Notes so users know it's recognized but needs content
        sources.push({
          index,
          type: "notes",
          icon: "\u{1F4DD}", // 📝
          label: "Notes",
          preview: "(empty)",
          isEmpty: true,
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
        // Replace newlines with spaces for clean single-line preview display
        const cleanPreview = content.replace(/\n+/g, " ").trim();
        sources.push({
          index,
          type: "text-import",
          icon: "\u{1F4C4}", // 📄
          label,
          preview: cleanPreview.slice(0, 100) +
            (cleanPreview.length > 100 ? "..." : ""),
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
 * Toggle source handler - receives Cell as parameter for proper transaction context
 */
const toggleSourceHandler = handler<
  unknown,
  {
    index: number;
    sourceSelectionsCell: Cell<
      Default<Record<number, boolean>, Record<number, never>>
    >;
  }
>((_event, { index, sourceSelectionsCell }) => {
  const current = sourceSelectionsCell.get() || {};
  // Default is selected (true), so toggle means: if undefined or true -> false, if false -> true
  const currentValue = current[index] !== false;
  sourceSelectionsCell.set({
    ...current,
    [index]: !currentValue,
  });
});

/**
 * Toggle trash handler - receives Cell as parameter for proper transaction context
 */
const toggleTrashHandler = handler<
  unknown,
  {
    index: number;
    trashSelectionsCell: Cell<
      Default<Record<number, boolean>, Record<number, never>>
    >;
  }
>((_event, { index, trashSelectionsCell }) => {
  const current = trashSelectionsCell.get() || {};
  // Default is not selected (false)
  const currentValue = current[index] === true;
  trashSelectionsCell.set({
    ...current,
    [index]: !currentValue,
  });
});

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
    notesContentSnapshotCell: Cell<
      Default<Record<number, string>, Record<number, never>>
    >;
    // Read-only: computed() provides OpaqueRef, no Cell wrapper needed
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
    const ocrResultsMap = ocrResultsValue || {};

    // First pass: use scanExtractableSources to identify sources and their indices
    // This may return stale content for some sources
    const sources = scanExtractableSources(subCharmsData);

    // Build combined content from selected sources
    // For notes/text-import, use Cell.key() navigation to ensure we read live content
    const parts: string[] = [];
    // Map to store ALL selected Notes modules' content (index -> content)
    const notesSnapshots: Record<string, string> = {};

    for (const source of sources) {
      // Skip if explicitly deselected
      if (selectionsMap[source.index] === false) continue;

      if (source.type === "notes") {
        // Access charm content via .get() first to resolve links, then access properties
        // Cell.key() navigation doesn't work through link boundaries - charm is stored as a link
        const entry = (parentSubCharmsCell as Cell<SubCharmEntry[]>)
          .key(source.index)
          .get();
        const charm = entry?.charm as Record<string, unknown>;
        const contentCell = charm?.content;
        const liveContent = typeof contentCell === "object" &&
            contentCell !== null &&
            "get" in contentCell
          ? (contentCell as { get: () => unknown }).get()
          : contentCell;
        const content = typeof liveContent === "string" ? liveContent : "";

        if (content.trim()) {
          parts.push(`--- ${source.label} ---\n${content}`);
          // Store snapshot for this Notes module (keyed by index as string to avoid Cell array coercion)
          notesSnapshots[String(source.index)] = content;
        }
      } else if (source.type === "text-import") {
        // Same pattern for text-import
        const entry = (parentSubCharmsCell as Cell<SubCharmEntry[]>)
          .key(source.index)
          .get();
        const charm = entry?.charm as Record<string, unknown>;
        const contentCell = charm?.content;
        const liveContent = typeof contentCell === "object" &&
            contentCell !== null &&
            "get" in contentCell
          ? (contentCell as { get: () => unknown }).get()
          : contentCell;
        const content = typeof liveContent === "string" ? liveContent : "";

        if (content.trim()) {
          parts.push(`--- ${source.label} ---\n${content}`);
        }
      } else if (source.type === "photo") {
        // Include OCR text for photos
        const ocrText = ocrResultsMap[source.index];
        if (ocrText && ocrText.trim()) {
          parts.push(`--- ${source.label} (OCR) ---\n${ocrText}`);
        }
      }
    }

    const combinedContent = parts.join("\n\n");

    if (combinedContent.trim()) {
      // Snapshot ALL selected Notes content for cleanup (map of index -> content)
      notesContentSnapshotCell.set(notesSnapshots);
      extractionPromptCell.set(combinedContent);
      extractPhaseCell.set("extracting");
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
    parentTitleCell: Cell<string>;
    extractionResultValue: Record<string, unknown> | null;
    selectionsCell: Cell<
      Default<Record<string, boolean>, Record<string, never>>
    >;
    trashSelectionsCell: Cell<
      Default<Record<number, boolean>, Record<number, never>>
    >;
    cleanupEnabledValue: boolean;
    cleanedNotesValue: string;
    // Dereferenced value from notesContentSnapshot Cell (map of Notes module index as string -> original content)
    notesSnapshotMapValue: Record<string, string>;
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
      parentTitleCell,
      extractionResultValue,
      selectionsCell,
      trashSelectionsCell,
      cleanupEnabledValue,
      cleanedNotesValue,
      notesSnapshotMapValue,
      cleanupApplyStatusCell,
      applyInProgressCell,
    },
  ) => {
    // Prevent double-click race condition using Cell state
    if (applyInProgressCell.get()) {
      return;
    }
    applyInProgressCell.set(true);

    try {
      // Read Cells inside handler, filter out malformed entries
      const rawSubCharms = parentSubCharmsCell.get() || [];
      const subCharmsData = rawSubCharms.filter(
        (e): e is SubCharmEntry =>
          e != null && typeof e === "object" && "type" in e,
      );
      const extractionResult = extractionResultValue;
      if (!extractionResult) return;

      const currentTitle = parentTitleCell.get() || "";
      const previewData = buildPreview(
        extractionResult,
        subCharmsData,
        currentTitle,
      );
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
        // Special handling for "record-title" pseudo-type (name -> Record title)
        if (moduleType === "record-title") {
          for (const field of fields) {
            if (
              field.fieldName === "name" &&
              typeof field.extractedValue === "string"
            ) {
              try {
                parentTitleCell.set(field.extractedValue);
                anySuccess = true;
                console.debug(
                  `[Extract] Set Record title to: ${field.extractedValue}`,
                );
              } catch (e) {
                console.warn("[Extract] Failed to set Record title:", e);
              }
            }
          }
          continue; // Skip normal module processing
        }

        // Handle array extraction mode (e.g., custom-field)
        // Each field with isNewInstance creates a separate module instance
        const moduleDef = getDefinition(moduleType);
        if (moduleDef?.extractionMode === "array") {
          for (const field of fields) {
            if (!field.isNewInstance) continue;

            try {
              // extractedValue contains the array item (e.g., {fieldName, fieldValue, fieldType})
              const item = field.extractedValue as Record<string, unknown>;

              // Map array item properties to module input properties
              // For custom-field: fieldName -> name, fieldValue -> value, fieldType -> valueType
              const initialValues: Record<string, unknown> = {};
              if (moduleType === "custom-field") {
                initialValues.name = item.fieldName || "";
                initialValues.value = item.fieldValue || "";
                initialValues.valueType = item.fieldType || "text";
              } else {
                // Generic mapping for other array modules
                Object.assign(initialValues, item);
              }

              const newCharm = createSubCharm(moduleType, initialValues);
              const schema = getResultSchema(newCharm);
              newEntries.push({
                type: moduleType,
                pinned: false,
                charm: newCharm,
                schema,
              });
              anySuccess = true;
              console.debug(
                `[Extract] Created new ${moduleType} instance: ${
                  JSON.stringify(initialValues)
                }`,
              );
            } catch (e) {
              console.warn(
                `[Extract] Failed to create ${moduleType} instance:`,
                e,
              );
            }
          }
          continue; // Skip normal module processing for array extraction modules
        }

        const existingIndex = current.findIndex((e) => e?.type === moduleType);

        if (existingIndex >= 0) {
          // Module exists - use Cell navigation to update fields
          for (const field of fields) {
            // Get the primary field name (e.g., "notes" alias -> "content" primary)
            const actualFieldName = getPrimaryFieldName(
              field.fieldName,
              moduleType,
            );

            // Skip Notes content extraction when cleanup is enabled
            // The cleanup will handle setting the final Notes content (with extracted data removed)
            // If we don't skip, both extraction and cleanup try to set notes.content with different values
            if (
              moduleType === "notes" && actualFieldName === "content" &&
              cleanupEnabledValue
            ) {
              console.debug(
                "[Extract] Skipping notes.content extraction - cleanup will handle it",
              );
              continue;
            }

            // Validate extracted value against schema (use actual field name)
            const fieldSchema = getFieldSchema(
              subCharms,
              moduleType,
              actualFieldName,
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
                `[Extract] Type mismatch for ${moduleType}.${actualFieldName}: ` +
                  `expected ${fieldSchema?.type}, got ${actualType}. ` +
                  `Value: ${
                    JSON.stringify(field.extractedValue)
                  }. Skipping field.`,
              );
              continue; // Skip this field
            }

            try {
              // Only write if validation passed
              // Cast needed: Cell.key() navigation loses type info for dynamic nested paths
              // Use actualFieldName to write to the correct field (handles aliases)
              (parentSubCharmsCell as Cell<SubCharmEntry[]>).key(existingIndex)
                .key("charm").key(
                  actualFieldName,
                ).set(field.extractedValue);
              anySuccess = true;
            } catch (e) {
              console.warn(
                `Failed to set ${moduleType}.${actualFieldName}:`,
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
              // Get the primary field name (e.g., "notes" alias -> "content" primary)
              const actualFieldName = getPrimaryFieldName(
                field.fieldName,
                moduleType,
              );

              // Validate before adding to initialValues (use actual field name)
              const fieldSchema = getFieldSchema(
                subCharms,
                moduleType,
                actualFieldName,
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
                  `[Extract] Type mismatch for new module ${moduleType}.${actualFieldName}: ` +
                    `expected ${fieldSchema?.type}, got ${actualType}. ` +
                    `Value: ${
                      JSON.stringify(field.extractedValue)
                    }. Skipping field.`,
                );
                continue; // Skip this field
              }

              // Use actualFieldName to store in the correct field
              initialValues[actualFieldName] = field.extractedValue;
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

      // Only proceed with trashing if at least one update succeeded OR cleanup is pending
      // Notes cleanup counts as a "success" because the extraction worked - we have cleaned content to apply
      const cleanupWillApply = cleanupEnabledValue &&
        cleanedNotesValue !== undefined &&
        Object.keys(notesSnapshotMapValue || {}).length > 0;

      if (!anySuccess && !cleanupWillApply) {
        console.warn(
          "[Extract] No updates succeeded and no cleanup pending, keeping extractor for retry",
        );
        return;
      }

      // ===== Notes Cleanup: Dual-Approach Architecture =====
      //
      // PROBLEM: We need to update Notes.content from the Extractor module (cross-charm mutation).
      //
      // WHY TWO APPROACHES ARE NECESSARY:
      //
      // The correct CommonTools pattern for cross-charm mutations is Stream.send() (see docs/common/PATTERNS.md).
      // Direct Cell.set() on another charm's cells throws WriteIsolationError. However, Stream handlers
      // can be "lost" when accessing charms through reactive proxies in Cell<SubCharmEntry[]>.
      //
      // APPROACH 1: editContent.send() - Stream Handler (PREFERRED)
      //   - Uses the Notes pattern's exposed Stream<{ detail: { value: string } }> handler
      //   - This is the canonical cross-charm mutation pattern in CommonTools
      //   - The handler (handleEditContent in notes/note.tsx) calls content.set() within the Notes charm's scope
      //   - Guarantees UI reactivity: ct-code-editor subscriptions fire immediately
      //   - WHY IT CAN FAIL: Stream handlers may not be accessible when the Notes charm is accessed
      //     through notesEntry.charm (reactive proxy may strip the handler reference)
      //
      // APPROACH 2: Cell.key() Navigation (FALLBACK)
      //   - Directly navigates through parentSubCharmsCell.key(notesIndex).key("charm").key("content")
      //   - Sets the content field directly using Cell navigation (same underlying data as Approach 1)
      //   - This works because we're navigating through our INPUT Cell (parentSubCharms), not crossing
      //     charm boundaries (no WriteIsolationError)
      //   - WHY IT WORKS: Cell.key() creates a new Cell reference to the same underlying data
      //   - UI REACTIVITY: In practice, Lit's reactivity picks up the change without page refresh
      //     (the ct-code-editor's $value binding still updates), though Stream.send is more reliable
      //
      // FAILURE MODES:
      //   - If both approaches fail: cleanupApplyStatus -> "failed", user sees warning UI
      //   - Extraction still succeeds (new modules created), only Notes cleanup fails
      //   - User can manually edit Notes or retry extraction
      //
      // This dual-approach pattern is a pragmatic solution to the reactive proxy access issue.
      // If Stream handler access could be guaranteed, Approach 1 alone would be sufficient.
      //
      if (cleanupEnabledValue && cleanedNotesValue !== undefined) {
        // Get all Notes module indices that were used as extraction sources
        const notesIndices = Object.keys(notesSnapshotMapValue || {}).map(
          Number,
        );

        if (notesIndices.length === 0) {
          cleanupApplyStatusCell.set("skipped");
        } else {
          let allCleanupSucceeded = true;
          let anyCleanupAttempted = false;

          // Apply cleanup to ALL selected Notes modules
          for (const notesIndex of notesIndices) {
            const notesEntry = current[notesIndex];
            if (!notesEntry || notesEntry.type !== "notes") {
              console.warn(
                `[Extract] Notes entry at index ${notesIndex} not found or wrong type`,
              );
              allCleanupSucceeded = false;
              continue;
            }

            anyCleanupAttempted = true;
            let thisCleanupSucceeded = false;

            // Approach 1: Try editContent.send (best for UI reactivity)
            try {
              const notesCharm = notesEntry.charm as {
                editContent?: { send?: (data: unknown) => void };
              };
              if (notesCharm?.editContent?.send) {
                notesCharm.editContent.send({
                  detail: { value: cleanedNotesValue },
                });
                thisCleanupSucceeded = true;
                console.debug(
                  `[Extract] Applied Notes cleanup to index ${notesIndex} via editContent stream`,
                );
              }
            } catch (e) {
              console.warn(
                `[Extract] editContent.send failed for index ${notesIndex}:`,
                e,
              );
            }

            // Approach 2: Fallback to Cell key navigation
            if (!thisCleanupSucceeded) {
              try {
                // Cast needed: Cell.key() navigation loses type info for dynamic nested paths
                (parentSubCharmsCell as Cell<SubCharmEntry[]>).key(notesIndex)
                  .key("charm").key(
                    "content",
                  ).set(cleanedNotesValue);
                thisCleanupSucceeded = true;
                console.debug(
                  `[Extract] Applied Notes cleanup to index ${notesIndex} via Cell key navigation`,
                );
              } catch (e) {
                console.warn(
                  `[Extract] Cell key navigation failed for index ${notesIndex}:`,
                  e,
                );
              }
            }

            if (!thisCleanupSucceeded) {
              allCleanupSucceeded = false;
              console.warn(
                `[Extract] All cleanup approaches failed for Notes at index ${notesIndex}`,
              );
            }
          }

          if (!anyCleanupAttempted) {
            cleanupApplyStatusCell.set("failed");
            console.warn("[Extract] No valid Notes entries found for cleanup");
          } else {
            cleanupApplyStatusCell.set(
              allCleanupSucceeded ? "success" : "failed",
            );
          }
        }
      } else {
        cleanupApplyStatusCell.set("skipped");
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
      applyInProgressCell.set(false);
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
      parentTitle,
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

    // ===== TRANSFORMER BUG WORKAROUND =====
    // The TypeScript transformer has a bug where .map()/.filter()/.some() called on
    // a computed variable aren't properly transformed to their reactive equivalents.
    // See: packages/ts-transformers/test/fixtures/pending/computed-var-then-map.issue.md
    // GitHub Issue: https://github.com/commontoolsinc/labs/issues/2442
    //
    // WORKAROUND: Compute ALL source-derived data in a SINGLE computed block, then
    // expose individual values as simple property accesses. This avoids calling
    // scanExtractableSources() 10+ times in separate computed blocks.
    //
    // PERFORMANCE IMPACT: Before this fix, extraction took 2+ minutes with 113% CPU
    // due to O(n * 10) reactive operations. Now it's O(n) with a single scan.

    // Single computed that derives ALL source-related data
    const sourceData = computed(() => {
      const subCharms = parentSubCharms.get() || [];
      const sources = scanExtractableSources(subCharms);
      const selectionsMap = sourceSelections.get() || {};
      const trashMap = trashSelections.get() || {};

      // Build all derived data in a single pass
      const extractableSources: ExtractableSource[] = [];
      const photoSources: ExtractableSource[] = [];
      const trashCheckStates: Record<number, boolean> = {};
      let selectedCount = 0;
      let trashCount = 0;
      let hasAnyNonEmpty = false;
      let hasTrashable = false;

      for (const source of sources) {
        // Build extractable sources with selection state
        const isSelected = source.isEmpty
          ? false
          : selectionsMap[source.index] !== false;
        extractableSources.push({
          ...source,
          selected: isSelected,
        });

        // Count selected sources
        if (isSelected) {
          selectedCount++;
        }

        // Check for non-empty sources
        if (!source.isEmpty) {
          hasAnyNonEmpty = true;
        }

        // Build photo sources for OCR
        if (
          source.type === "photo" && source.requiresOCR &&
          selectionsMap[source.index] !== false
        ) {
          photoSources.push(source);
        }

        // Build trash check states and count (excluding Notes)
        if (source.type !== "notes") {
          hasTrashable = true;
          trashCheckStates[source.index] = trashMap[source.index] === true;
          if (trashMap[source.index] === true) {
            trashCount++;
          }
        }
      }

      return {
        sources: extractableSources,
        photoSources,
        trashCheckStates,
        selectedCount,
        trashCount,
        hasNoSourceModules: sources.length === 0,
        hasNoUsableSources: sources.length > 0 && !hasAnyNonEmpty,
        hasSelectedSources: selectedCount > 0,
        hasTrashableSources: hasTrashable,
      };
    });

    // Individual accessors for UI bindings (simple property access, no array methods needed)
    const extractableSources = computed(
      (): ExtractableSource[] => sourceData.sources,
    );
    const hasSelectedSources = computed(() => sourceData.hasSelectedSources);
    const selectedSourceCount = computed(() => sourceData.selectedCount);
    const photoSources = computed((): ExtractableSource[] =>
      sourceData.photoSources
    );

    // Build OCR calls for all selected photos using .map() on computed Cell
    // Each photo gets its own generateText call (framework caches per-item)
    // .map() on OpaqueRef works reactively - returns another OpaqueRef<Array>
    const ocrCalls = photoSources.map((photo: ExtractableSource) => {
      // Build prompt for this photo
      const prompt = computed(() => {
        if (!photo?.imageData) return undefined;

        const imageUrl = photo.imageData.data || photo.imageData.url;
        if (!imageUrl) return undefined;

        // Skip OCR for oversized images (Anthropic vision API limit ~5MB)
        if (!isImageWithinSizeLimit(imageUrl)) {
          return undefined;
        }

        return [
          { type: "image" as const, image: imageUrl },
          {
            type: "text" as const,
            text: "Extract all text from this image exactly as written.",
          },
        ];
      });

      return {
        index: photo.index,
        ocr: generateText({
          system: OCR_SYSTEM_PROMPT,
          prompt,
          model: "anthropic:claude-sonnet-4-5",
        }),
      };
    });

    // Check if any OCR is pending
    const ocrPending = computed(() => {
      // ocrCalls auto-dereferences inside computed()
      const calls = ocrCalls;
      if (!calls || calls.length === 0) return false;
      return calls.some(
        (call: { index: number; ocr: { pending: boolean } }) =>
          call.ocr.pending,
      );
    });

    // Get OCR results as a map (index -> text)
    const ocrResults = computed((): Record<number, string> => {
      // ocrCalls auto-dereferences inside computed()
      const calls = ocrCalls;
      const results: Record<number, string> = {};
      if (!calls || calls.length === 0) return results;

      for (const call of calls) {
        if (call.ocr.result) {
          results[call.index] = call.ocr.result as string;
        }
      }
      return results;
    });

    // Reactive extraction - only runs when extractionPrompt is set
    // Note: generateObject accepts Opaque<> which allows Cell-wrapped values
    const extraction = generateObject({
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: extractionPrompt,
      schema: extractSchema,
      model: "anthropic:claude-haiku-4-5",
    });

    // Computed to dereference extraction.result for passing to handlers
    // extraction.result is a reactive property that doesn't auto-dereference when passed directly
    // This ensures the handler receives the actual value, not a reactive proxy
    const extractionResultValue = computed(
      (): Record<string, unknown> | null => {
        const result = extraction.result;
        if (!result || typeof result !== "object") return null;
        return result as Record<string, unknown>;
      },
    );

    // Build preview from extraction result
    const preview = computed((): ExtractionPreview | null => {
      if (!extraction.result) return null;
      const subCharms = parentSubCharms.get() || [];
      const currentTitle = parentTitle.get() || "";
      const result = buildPreview(extraction.result, subCharms, currentTitle);
      return result;
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
    // Force reactive dependency on preview by assigning to local variable BEFORE any early returns
    // Without this, early return paths (pending/error) prevent preview from being tracked as dependency
    const currentPhase = computed(() => {
      const p = preview; // Establish reactive dependency before any conditionals
      const phase = extractPhase.get() || "select";
      if (phase === "extracting") {
        if (extraction.pending) return "extracting";
        if (extraction.error) return "error";
        if (p?.fields?.length) return "preview";
        if (extraction.result && !p?.fields?.length) return "no-results";
        return "extracting";
      }
      return phase;
    });

    // Format extracted fields as text for preview display
    const previewText = computed(() => {
      if (!extraction.result) return "No fields extracted";
      const subCharms = parentSubCharms.get() || [];
      const currentTitle = parentTitle.get() || "";
      const previewData = buildPreview(
        extraction.result,
        subCharms,
        currentTitle,
      );
      if (!previewData?.fields?.length) return "No fields extracted";
      return previewData.fields.map((f: ExtractedField) => {
        const current = formatValue(f.currentValue);
        const extracted = formatValue(f.extractedValue);
        // Show "Record Title" for record-title pseudo-type instead of module name
        const displayModule = f.targetModule === "record-title"
          ? "Record Title"
          : f.targetModule;
        return `${displayModule}.${f.fieldName}: ${current} -> ${extracted}`;
      }).join("\n");
    });

    // Notes cleanup now uses the extraction result's `notes` field directly.
    // No separate LLM call needed - the extraction schema includes a `notes` field
    // via the Notes module's fieldMapping: ["content", "notes"].
    // See comment at NOTES_CLEANUP_SYSTEM_PROMPT location for full explanation.

    // Check if Notes cleanup is pending - always false now (no separate LLM call)
    const cleanupPending = computed(() => false);

    // Check if cleanup has an error - always false now (no separate LLM call)
    const cleanupHasError = computed(() => false);

    // Get the cleaned Notes content from extraction result's `notes` field
    // Falls back to original content if cleanup disabled or no extraction result
    const cleanedNotesContent = computed(() => {
      const rawEnabled = cleanupNotesEnabled.get();
      const enabled = typeof rawEnabled === "boolean" ? rawEnabled : true;
      const rawSnapshot = notesContentSnapshot.get();
      const snapshotMap: Record<string, string> =
        (typeof rawSnapshot === "object" && rawSnapshot !== null &&
            !Array.isArray(rawSnapshot))
          ? rawSnapshot as Record<string, string>
          : {};

      // Combine all Notes snapshots for fallback
      const combinedSnapshot = Object.values(snapshotMap).join("\n\n---\n\n");

      if (!enabled) return combinedSnapshot;

      // Use extraction result's notes content directly
      // The extraction schema includes both `content` (primary) and `notes` (alias) fields
      // from Notes module's fieldMapping: ["content", "notes"]
      // The LLM may use either field name, so check both
      if (!extraction.result) return combinedSnapshot;
      const result = extraction.result as Record<string, unknown>;
      // Check both `notes` (alias) and `content` (primary) - LLM may use either
      const notesValue = result.notes ?? result.content;

      // If extraction didn't produce notes content, keep original
      if (notesValue === null || notesValue === undefined) {
        return combinedSnapshot;
      }

      // Validate result - should be string
      if (typeof notesValue !== "string") return combinedSnapshot;

      return notesValue.trim();
    });

    // Check if there are meaningful changes to Notes
    const hasNotesChanges = computed(() => {
      const rawSnapshot = notesContentSnapshot.get();
      const snapshotMap: Record<string, string> =
        (typeof rawSnapshot === "object" && rawSnapshot !== null &&
            !Array.isArray(rawSnapshot))
          ? rawSnapshot as Record<string, string>
          : {};

      const combinedSnapshot = Object.values(snapshotMap).join("\n\n---\n\n");
      if (!combinedSnapshot.trim()) return false;

      const cleaned = cleanedNotesContent;
      return cleaned !== combinedSnapshot;
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
    // Uses centralized sourceData to avoid redundant scanExtractableSources() calls
    const trashCount = computed(() => sourceData.trashCount);

    // Phase-related computed values (defined at statement level for stable node identity)
    const isPreviewPhase = computed(() => currentPhase === "preview");
    const isSelectPhase = computed(() => currentPhase === "select");
    const isExtractingPhase = computed(() => currentPhase === "extracting");
    const isErrorPhase = computed(() => currentPhase === "error");
    const isNoResultsPhase = computed(() => currentPhase === "no-results");
    // True when there are no source modules at all (Notes, Photo, Text Import)
    // Uses centralized sourceData to avoid redundant scanExtractableSources() calls
    const hasNoSourceModules = computed(() => sourceData.hasNoSourceModules);
    // True when all sources are empty (modules exist but have no content)
    // Uses centralized sourceData to avoid redundant scanExtractableSources() calls
    const hasNoUsableSources = computed(() => sourceData.hasNoUsableSources);
    // Dereference computed values properly to avoid comparing Cell objects to primitives
    const isSingleSource = computed(() => Number(selectedSourceCount) === 1);
    const extractButtonDisabled = computed(() =>
      !hasSelectedSources || ocrPending
    );
    const extractButtonBackground = computed(() =>
      hasSelectedSources && !ocrPending ? "#f59e0b" : "#d1d5db"
    );
    const extractButtonCursor = computed(() =>
      hasSelectedSources && !ocrPending ? "pointer" : "not-allowed"
    );
    const isCleanedNotesEmpty = computed(() =>
      String(cleanedNotesContent) === ""
    );
    const hasMultipleChanges = computed(() => Number(totalChangesCount) !== 1);
    const hasTrashItems = computed(() => Number(trashCount) > 0);

    // Pre-computed trash selection state map
    // Uses centralized sourceData to avoid redundant scanExtractableSources() calls
    const trashCheckStates = computed(() => sourceData.trashCheckStates);

    // Preview phase computed values
    const hasNotesSnapshot = computed(() => {
      const rawSnapshot = notesContentSnapshot.get();
      const snapshotMap: Record<string, string> =
        (typeof rawSnapshot === "object" && rawSnapshot !== null &&
            !Array.isArray(rawSnapshot))
          ? rawSnapshot as Record<string, string>
          : {};
      return Object.keys(snapshotMap).length > 0;
    });
    const showCleanupPreview = computed(() => {
      const rawEnabled = cleanupNotesEnabled.get();
      const enabled = typeof rawEnabled === "boolean" ? rawEnabled : true;
      return enabled && Boolean(hasNotesChanges);
    });
    const cleanupDisabled = computed(() => {
      const rawEnabled = cleanupNotesEnabled.get();
      const enabled = typeof rawEnabled === "boolean" ? rawEnabled : true;
      return !enabled;
    });
    // Computed to dereference notesContentSnapshot Cell for handler params
    // NOTE: Must use Record<string, string> not Record<number, string> - numeric keys
    // cause Cell runtime to coerce the object to an array, losing all data
    const notesSnapshotMapValue = computed(() => {
      const rawSnapshot = notesContentSnapshot.get();
      return (typeof rawSnapshot === "object" && rawSnapshot !== null &&
          !Array.isArray(rawSnapshot))
        ? rawSnapshot as Record<string, string>
        : {};
    });
    // Uses centralized sourceData to avoid redundant scanExtractableSources() calls
    const hasTrashableSources = computed(() => sourceData.hasTrashableSources);
    const cleanupFailed = computed(() => {
      const status = cleanupApplyStatus.get();
      return status === "failed";
    });
    // Combined snapshot string for display in "Before:" preview
    // Must dereference the Cell to show actual content, not Cell reference
    const combinedSnapshotDisplay = computed(() => {
      const rawSnapshot = notesContentSnapshot.get();
      const snapshotMap: Record<string, string> =
        (typeof rawSnapshot === "object" && rawSnapshot !== null &&
            !Array.isArray(rawSnapshot))
          ? rawSnapshot as Record<string, string>
          : {};
      return Object.values(snapshotMap).join("\n\n---\n\n");
    });
    const applyButtonDisabled = computed(() =>
      cleanupPending || applyInProgress.get() === true
    );
    const applyButtonBackground = computed(() =>
      applyButtonDisabled ? "#d1d5db" : "#059669"
    );
    const applyButtonCursor = computed(() =>
      applyButtonDisabled ? "not-allowed" : "pointer"
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
              {ifElse(isPreviewPhase, "Review Changes", "Select Sources")}
            </span>
            {ifElse(
              isExtractingPhase,
              null,
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
              </button>,
            )}
          </div>

          {/* Select Sources Phase */}
          {ifElse(
            isSelectPhase,
            <div
              style={{ display: "flex", flexDirection: "column", gap: "12px" }}
            >
              {ifElse(
                hasNoSourceModules,
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
                    {ifElse(
                      hasNoUsableSources,
                      "Add content to sources below:",
                      "Select sources to extract from:",
                    )}
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
                          opacity: source.isEmpty ? 0.5 : 1,
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={source.selected === true}
                          onChange={toggleSourceHandler({
                            index: source.index,
                            sourceSelectionsCell: sourceSelections,
                          })}
                          disabled={source.isEmpty}
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
                              style={{
                                fontWeight: "500",
                                color: source.isEmpty ? "#9ca3af" : "#374151",
                              }}
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
                              fontStyle: source.isEmpty ? "italic" : "normal",
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
                        // Read-only value from computed() - no Cell wrapper needed
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
                          cleanupNotesEnabled.set(!current);
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
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "8px",
                          }}
                        >
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
                                {combinedSnapshotDisplay}
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
                                  <span
                                    style={{
                                      fontStyle: "italic",
                                      color: "#9ca3af",
                                    }}
                                  >
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
                    .filter((source: ExtractableSource) =>
                      source.type !== "notes"
                    )
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
                          checked={trashCheckStates[source.index] === true}
                          onChange={toggleTrashHandler({
                            index: source.index,
                            trashSelectionsCell: trashSelections,
                          })}
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
                    The extracted fields were applied successfully, but the
                    Notes module could not be cleaned up. The original content
                    remains unchanged. Check the console for details.
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
                  disabled={applyButtonDisabled}
                  onClick={applySelected({
                    parentSubCharmsCell: parentSubCharms,
                    parentTrashedSubCharmsCell: parentTrashedSubCharms,
                    parentTitleCell: parentTitle,
                    // Pass computed that dereferences extraction.result (reactive properties
                    // don't auto-dereference when passed directly to handlers)
                    extractionResultValue: extractionResultValue,
                    selectionsCell: selections,
                    trashSelectionsCell: trashSelections,
                    cleanupEnabledValue: (() => {
                      const rawEnabled = cleanupNotesEnabled.get();
                      return typeof rawEnabled === "boolean"
                        ? rawEnabled
                        : true;
                    })(),
                    // Pass computed directly - auto-dereferences when accessed in handler
                    // (IIFEs with String() dont properly dereference reactive proxies)
                    cleanedNotesValue: cleanedNotesContent,
                    // Pass computed that dereferences the Cell (Cells don't dereference in handlers)
                    notesSnapshotMapValue: notesSnapshotMapValue,
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
                    applyButtonDisabled,
                    ifElse(
                      cleanupPending,
                      "Preparing cleanup...",
                      "Applying changes...",
                    ),
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
