/// <cts-enable />
/**
 * Extractor Module - Controller sub-piece for LLM-assisted field extraction
 *
 * This is a "controller module" that acts on the parent Record's state.
 * It scans existing Notes, Text Imports, and Photos in the Record,
 * extracts structured data from their content, and updates modules.
 *
 * Key architecture:
 * - Receives parentSubPieces and parentTrashedSubPieces as INPUT Cells
 * - Scans for extractable sources: notes, text-import (text), photo (OCR)
 * - Uses generateObject() with dynamic schema from existing modules
 * - Shows diff view: currentValue -> extractedValue for each field
 * - Optionally trashes source modules after successful extraction
 * - Auto-trashes itself after successful apply
 */

import {
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
  Writable,
} from "commontools";
import {
  createSubPiece,
  getDefinition,
  getFieldToTypeMapping as getFullFieldMapping,
  SUB_CHARM_REGISTRY,
} from "../registry.ts";
import type { SubPieceEntry, TrashedSubPieceEntry } from "../types.ts";
import type {
  ExtractableSource,
  ExtractedField,
  ExtractionPreview,
  ExtractionRecommendation,
  RecommendationsResult,
  SourceExtraction,
  SourceExtractionStatus,
  ValidationIssue,
} from "./types.ts";
import { getConfidenceLevel, SOURCE_PRECEDENCE } from "./types.ts";
import type { JSONSchema } from "./schema-utils.ts";
import { getResultSchema, getSchemaForType } from "./schema-utils.ts";
import { getCellValue } from "./schema-utils-pure.ts";

// ===== Types =====

interface ExtractorModuleInput {
  // Parent's Cells - passed as INPUT so they survive serialization
  parentSubPieces: Writable<SubPieceEntry[]>;
  parentTrashedSubPieces: Writable<TrashedSubPieceEntry[]>;
  // Parent Record's title Cell - for extracting names to Record title
  parentTitle: Writable<string>;
  // Source selection state (index -> selected, default true)
  sourceSelections: Writable<
    Default<Record<number, boolean>, Record<number, never>>
  >;
  // Trash selection state (index -> should trash, default false)
  trashSelections: Writable<
    Default<Record<number, boolean>, Record<number, never>>
  >;
  // Field selections for preview
  selections: Writable<Default<Record<string, boolean>, Record<string, never>>>;
  // Extraction phase
  extractPhase: Writable<
    Default<"select" | "extracting" | "preview", "select">
  >;
  // Combined content for extraction (built from sources)
  extractionPrompt: Writable<Default<string, "">>;
  // Notes cleanup state
  cleanupNotesEnabled: Writable<Default<boolean, true>>;
  // Snapshot of Notes content at extraction start (for cleanup comparison)
  // Map of subPiece index (as string) -> original content for ALL selected Notes modules
  // NOTE: Uses string keys to avoid Cell coercing numeric keys to array indices
  notesContentSnapshot: Writable<
    Default<Record<string, string>, Record<string, never>>
  >;
  // Cleanup application status tracking
  cleanupApplyStatus: Writable<
    Default<"pending" | "success" | "failed" | "skipped", "pending">
  >;
  // Apply in progress guard (prevents double-click race condition)
  applyInProgress: Writable<Default<boolean, false>>;
  // Error details expanded state (for showing full error in UI)
  errorDetailsExpanded: Writable<Default<boolean, false>>;
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
  errorDetailsExpanded?: Default<boolean, false>;
}

// ===== Constants =====

const EXTRACTION_SYSTEM_PROMPT =
  `You are a precise data extractor that returns recommendations with confidence scores.

=== OUTPUT FORMAT ===
Return a JSON object with a "recommendations" array. Each recommendation represents ONE module type:
{
  "recommendations": [
    {
      "type": "email",           // Module type (email, phone, birthday, address, social, dietary, notes)
      "score": 95,               // Confidence 0-100
      "explanation": "Found explicit email address in signature",
      "extractedData": { "address": "john@example.com" },
      "sourceExcerpt": "Email: john@example.com"
    }
  ]
}

=== CONFIDENCE SCORING ===
- 80-100 (HIGH): Explicit, unambiguous data. Clear labels like "Email:", "Phone:", exact formats.
- 50-79 (MEDIUM): Likely correct but some inference needed. Unlabeled but recognizable patterns.
- 0-49 (LOW): Uncertain extraction. Context-dependent, ambiguous, or partial data.

Examples:
- "Email: john@example.com" → score: 95 (explicit label + valid format)
- "john@example.com" (no label) → score: 70 (valid format but no label)
- "reach me at john at example dot com" → score: 40 (requires interpretation)

=== FIELD PATTERNS ===

PHONE (type: "phone", field: "number"):
- PRESERVE original formatting exactly
- Example: "Cell: (415) 555-1234" → score: 95, extractedData: {"number": "(415) 555-1234"}

EMAIL (type: "email", field: "address"):
- Extract complete email address only
- Example: "john.doe@acme.com" → score: 90, extractedData: {"address": "john.doe@acme.com"}

BIRTHDAY (type: "birthday", fields: "birthMonth", "birthDay", "birthYear"):
- Extract as SEPARATE string components
- Example: "Born March 15, 1990" → score: 85, extractedData: {"birthMonth": "3", "birthDay": "15", "birthYear": "1990"}

ADDRESS (type: "address", fields: "street", "city", "state", "zip"):
- state: Use 2-letter US abbreviation
- Example: "123 Main St, San Francisco, CA 94102" → score: 90

SOCIAL MEDIA (type: "social", fields: "platform", "handle", "profileUrl"):
- platform: Normalize to lowercase (twitter, linkedin, github, etc.)
- handle: WITHOUT the @ prefix
- Example: "@alice_smith on Twitter" → score: 95, extractedData: {"platform": "twitter", "handle": "alice_smith"}

DIETARY (type: "dietary", field: "restrictions"):
- Array of {name, level} objects
- Levels: "absolute" (allergies), "strict" (ethical), "prefer" (mild), "flexible" (slight)
- Example: "allergic to peanuts" → score: 95, extractedData: {"restrictions": [{"name": "peanuts", "level": "absolute"}]}

NAME (type: "record-title", field: "name"):
- Extract person's full name for Record title
- Example: "John Smith" in signature → score: 80, extractedData: {"name": "John Smith"}

NOTES (type: "notes", field: "content"):
- Content that should REMAIN in notes after extraction (non-structured content)
- This is what's LEFT OVER, not what's extracted

=== WHAT TO EXTRACT ===
- Email addresses, phone numbers, physical addresses
- Social media handles and profile URLs
- Specific dates (birthdays, anniversaries)
- Explicit dietary restrictions or allergies
- Names (when clearly a person's name)

=== WHAT NOT TO EXTRACT ===
- Vague preferences: "loves coffee", "enjoys hiking" → Keep in notes
- Personality traits: "is very friendly" → Keep in notes
- Conversational text: "met at conference" → Keep in notes
- Food preferences (not restrictions): "loves pizza" → Keep in notes

=== RULES ===
1. Return ONLY recommendations with score > 0
2. One recommendation per module type
3. Include sourceExcerpt showing the text that led to extraction
4. When uncertain, use lower confidence score rather than omitting
5. Always include a "notes" recommendation for remaining content`;

const OCR_SYSTEM_PROMPT =
  `You are an OCR system. Extract all text from the provided image.
Return ONLY the extracted text, preserving formatting and line breaks.
Do not add any commentary, explanation, or formatting like markdown.
If no text is visible, return an empty string.`;

/**
 * Schema for recommendations-based extraction.
 * Instead of a flat field extraction, the LLM returns an array of recommendations
 * with confidence scores and explanations.
 */
// Use `as const` for schema literal to satisfy generateObject's type expectations.
// Do NOT annotate with JSONSchema - that type is incompatible with generateObject's schema param.
const RECOMMENDATIONS_SCHEMA = {
  type: "object",
  properties: {
    recommendations: {
      type: "array",
      description: "Array of extraction recommendations, one per module type",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "Module type: email, phone, birthday, address, social, dietary, notes, record-title",
          },
          score: {
            type: "number",
            description:
              "Confidence score 0-100. High: 90-100, Medium: 50-89, Low: 0-49",
          },
          explanation: {
            type: "string",
            description:
              "Brief explanation of why this was extracted and confidence level",
          },
          extractedData: {
            type: "object",
            description: "The extracted field values for this module type",
            additionalProperties: true,
          },
          sourceExcerpt: {
            type: "string",
            description:
              "The text snippet from the source that led to this extraction",
          },
        },
        required: ["type", "score", "explanation", "extractedData"],
      },
    },
  },
  required: ["recommendations"],
} as const;

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
function getCurrentValue(entry: SubPieceEntry, fieldName: string): unknown {
  try {
    const piece = entry.piece as Record<string, unknown>;
    const field = piece[fieldName];
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
 * Merge extraction results from multiple sources using precedence rules.
 * Higher precedence sources (photos > text-import > notes) overwrite lower ones.
 * Null/undefined values are skipped (don't overwrite existing values).
 *
 * @param sourceExtractions - Array of per-source extraction results
 * @returns Combined extraction result with highest-precedence values
 */
function mergeExtractionResults(
  sourceExtractions: SourceExtraction[],
): Record<string, unknown> {
  // Sort by precedence (lowest first, so higher precedence overwrites)
  const sorted = [...sourceExtractions]
    .filter((s) => s.status === "complete" && s.extractedFields !== null)
    .sort(
      (a, b) =>
        SOURCE_PRECEDENCE[a.sourceType] - SOURCE_PRECEDENCE[b.sourceType],
    );

  const merged: Record<string, unknown> = {};

  for (const source of sorted) {
    const fields = source.extractedFields;
    if (!fields) continue;

    for (const [key, value] of Object.entries(fields)) {
      // Skip null/undefined values - don't overwrite existing data
      if (value === null || value === undefined) continue;
      // Also skip "null" string values (LLM workaround)
      if (typeof value === "string" && value.toLowerCase() === "null") continue;
      // Skip empty strings
      if (typeof value === "string" && value.trim() === "") continue;
      // Skip empty arrays
      if (Array.isArray(value) && value.length === 0) continue;

      // Overwrite with this source's value (higher precedence wins due to sort order)
      merged[key] = value;
    }
  }

  return merged;
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
 * Get schema for a specific field from sub-pieces
 */
function getFieldSchema(
  subPieces: readonly SubPieceEntry[],
  moduleType: string,
  fieldName: string,
): JSONSchema | undefined {
  const entry = subPieces.find((e) => e?.type === moduleType);
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
 * Validate an extracted field value and return a ValidationIssue if there's a problem.
 * Checks for type mismatches, invalid email format, and invalid phone format.
 */
function validateExtractedField(
  fieldName: string,
  extractedValue: unknown,
  expectedSchema: JSONSchema | undefined,
): ValidationIssue | undefined {
  // Type mismatch validation
  if (expectedSchema?.type) {
    const actualType = Array.isArray(extractedValue)
      ? "array"
      : typeof extractedValue;
    const expectedType = expectedSchema.type;

    // Check for type mismatch (allow strings where numbers expected since LLMs often return strings)
    if (expectedType === "array" && actualType !== "array") {
      return {
        code: "TYPE_MISMATCH",
        message: `Expected array, got ${actualType}`,
        severity: "error",
      };
    }
    if (
      expectedType === "object" && actualType !== "object" &&
      extractedValue !== null
    ) {
      return {
        code: "TYPE_MISMATCH",
        message: `Expected object, got ${actualType}`,
        severity: "error",
      };
    }
    if (expectedType === "boolean" && actualType !== "boolean") {
      return {
        code: "TYPE_MISMATCH",
        message: `Expected boolean, got ${actualType}`,
        severity: "error",
      };
    }
  }

  // Email format validation (check for @ symbol)
  if (
    fieldName === "address" || fieldName === "email" ||
    fieldName.toLowerCase().includes("email")
  ) {
    if (typeof extractedValue === "string" && extractedValue.trim()) {
      if (!extractedValue.includes("@")) {
        return {
          code: "INVALID_FORMAT",
          message: "Invalid email format (missing @)",
          severity: "warning",
        };
      }
    }
  }

  // Phone format validation (basic check for digits)
  if (
    fieldName === "number" || fieldName === "phone" ||
    fieldName.toLowerCase().includes("phone")
  ) {
    if (typeof extractedValue === "string" && extractedValue.trim()) {
      // Remove common phone formatting characters and check if there are at least some digits
      const digitsOnly = extractedValue.replace(/[\s\-\(\)\+\.]/g, "");
      const digitCount = (digitsOnly.match(/\d/g) || []).length;
      if (digitCount < 7) {
        return {
          code: "INVALID_FORMAT",
          message: "Phone number appears too short",
          severity: "warning",
        };
      }
    }
  }

  return undefined;
}

/**
 * Check if extraction result is in recommendations format
 */
function isRecommendationsResult(
  result: unknown,
): result is RecommendationsResult {
  if (!result || typeof result !== "object") return false;
  const obj = result as Record<string, unknown>;
  return Array.isArray(obj.recommendations);
}

/**
 * Convert recommendations to flat field format for merging with legacy code.
 * Also returns a map of field keys to their confidence/explanation metadata.
 */
function flattenRecommendations(
  recommendations: ExtractionRecommendation[],
): {
  flatFields: Record<string, unknown>;
  fieldMetadata: Record<
    string,
    { confidence: number; explanation: string; sourceExcerpt?: string }
  >;
} {
  const flatFields: Record<string, unknown> = {};
  const fieldMetadata: Record<
    string,
    { confidence: number; explanation: string; sourceExcerpt?: string }
  > = {};

  for (const rec of recommendations) {
    const moduleType = rec.type;
    const extractedData = rec.extractedData || {};

    for (const [fieldName, value] of Object.entries(extractedData)) {
      if (value === null || value === undefined) continue;

      // Store flat field
      flatFields[fieldName] = value;

      // Store metadata keyed by "moduleType.fieldName"
      const fieldKey = `${moduleType}.${fieldName}`;
      fieldMetadata[fieldKey] = {
        confidence: rec.score,
        explanation: rec.explanation,
        sourceExcerpt: rec.sourceExcerpt,
      };
    }
  }

  return { flatFields, fieldMetadata };
}

/**
 * Build extraction preview from raw LLM result and existing modules.
 * Supports both legacy flat field format and new recommendations format.
 *
 * @param currentTitle - Current Record title (for "record-title" pseudo-type)
 * @param fieldMetadata - Optional metadata from recommendations (confidence, explanation)
 *
 * Note: Normalizes "null" strings to null before processing (LLM workaround)
 */
function buildPreview(
  extracted: Record<string, unknown>,
  subPieces: readonly SubPieceEntry[],
  currentTitle?: string,
  fieldMetadata?: Record<
    string,
    { confidence: number; explanation: string; sourceExcerpt?: string }
  >,
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

  // Track validation issue counts
  let errorCount = 0;
  let warningCount = 0;

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

      // Look up confidence metadata if available
      const fieldKey = `${moduleType}.name`;
      const meta = fieldMetadata?.[fieldKey];

      const field: ExtractedField = {
        fieldName: "name",
        targetModule: "record-title",
        extractedValue,
        currentValue: currentTitle || undefined,
        confidence: meta?.confidence,
        confidenceLevel: meta?.confidence !== undefined
          ? getConfidenceLevel(meta.confidence)
          : undefined,
        explanation: meta?.explanation,
        sourceExcerpt: meta?.sourceExcerpt,
      };

      fields.push(field);

      if (!byModule["record-title"]) byModule["record-title"] = [];
      byModule["record-title"].push(field);
      continue;
    }

    // Find existing module of this type
    const entry = subPieces.find((e) => e?.type === moduleType);
    const currentValue = entry ? getCurrentValue(entry, fieldName) : undefined;

    // Skip if value hasn't changed
    if (JSON.stringify(currentValue) === JSON.stringify(extractedValue)) {
      continue;
    }

    // Get field schema for validation
    const fieldSchema = getFieldSchema(subPieces, moduleType, fieldName);

    // Validate the extracted field
    const validationIssue = validateExtractedField(
      fieldName,
      extractedValue,
      fieldSchema,
    );

    // Count validation issues
    if (validationIssue) {
      if (validationIssue.severity === "error") {
        errorCount++;
      } else {
        warningCount++;
      }
    }

    // Look up confidence metadata if available
    const fieldKey = `${moduleType}.${fieldName}`;
    const meta = fieldMetadata?.[fieldKey];

    const field: ExtractedField = {
      fieldName,
      targetModule: moduleType,
      extractedValue,
      currentValue,
      validationIssue,
      confidence: meta?.confidence,
      confidenceLevel: meta?.confidence !== undefined
        ? getConfidenceLevel(meta.confidence)
        : undefined,
      explanation: meta?.explanation,
      sourceExcerpt: meta?.sourceExcerpt,
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

  // Sort fields by confidence (high first), then by module type
  fields.sort((a, b) => {
    // Fields with confidence come before those without
    if (a.confidence !== undefined && b.confidence === undefined) return -1;
    if (a.confidence === undefined && b.confidence !== undefined) return 1;
    // Sort by confidence descending
    if (a.confidence !== undefined && b.confidence !== undefined) {
      return b.confidence - a.confidence;
    }
    // Fall back to alphabetical by module type
    return a.targetModule.localeCompare(b.targetModule);
  });

  return {
    fields,
    byModule,
    validationSummary: {
      errorCount,
      warningCount,
    },
  };
}

/**
 * Scan sub-pieces for extractable content sources
 */
function scanExtractableSources(
  subPieces: readonly SubPieceEntry[],
): ExtractableSource[] {
  const sources: ExtractableSource[] = [];

  subPieces.forEach((entry, index) => {
    if (!entry) return;

    if (entry.type === "notes") {
      // Notes module - extract content
      const piece = entry.piece as Record<string, unknown>;
      const content = getCellValue<unknown>(piece?.content);

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
      const piece = entry.piece as Record<string, unknown>;
      const content = getCellValue<unknown>(piece?.content);
      const filename = getCellValue<unknown>(piece?.filename);

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
      const piece = entry.piece as Record<string, unknown>;
      const image = getCellValue<ImageData | null>(piece?.image);
      const label = getCellValue<unknown>(piece?.label);

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
    parentSubPieces: Writable<SubPieceEntry[]>;
    parentTrashedSubPieces: Writable<TrashedSubPieceEntry[]>;
  }
>((_event, { parentSubPieces, parentTrashedSubPieces }) => {
  const current = parentSubPieces.get() || [];
  const selfEntry = current.find((e) => e?.type === "extractor");
  if (!selfEntry) return;

  parentSubPieces.set(current.filter((e) => e?.type !== "extractor"));
  parentTrashedSubPieces.push({
    ...selfEntry,
    trashedAt: Temporal.Now.instant().toString(),
  });
});

/**
 * Toggle source handler - receives Cell as parameter for proper transaction context
 */
const toggleSourceHandler = handler<
  unknown,
  {
    index: number;
    sourceSelectionsCell: Writable<
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
    trashSelectionsCell: Writable<
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
 * Toggle field selection handler - for preview checkboxes
 */
const toggleFieldHandler = handler<
  unknown,
  {
    fieldKey: string;
    selectionsCell: Writable<
      Default<Record<string, boolean>, Record<string, never>>
    >;
    defaultSelected: boolean;
  }
>((_event, { fieldKey, selectionsCell, defaultSelected }) => {
  const current = selectionsCell.get() || {};
  // Use default if not explicitly set
  const currentValue = current[fieldKey] !== undefined
    ? current[fieldKey] !== false
    : defaultSelected;
  selectionsCell.set({
    ...current,
    [fieldKey]: !currentValue,
  });
});

/**
 * Handler to start extraction - defined at module scope
 *
 * With per-source extraction architecture, this handler only needs to:
 * 1. Snapshot Notes content for cleanup comparison
 * 2. Set phase to "extracting" - prompts are built reactively per-source
 */
const startExtraction = handler<
  unknown,
  {
    sourceSelectionsCell: Writable<
      Default<Record<number, boolean>, Record<number, never>>
    >;
    parentSubPiecesCell: Writable<SubPieceEntry[]>;
    extractPhaseCell: Writable<
      Default<"select" | "extracting" | "preview", "select">
    >;
    notesContentSnapshotCell: Writable<
      Default<Record<number, string>, Record<number, never>>
    >;
  }
>(
  (
    _event,
    {
      sourceSelectionsCell,
      parentSubPiecesCell,
      extractPhaseCell,
      notesContentSnapshotCell,
    },
  ) => {
    // Use .get() to read Cell values inside handler
    const selectionsMap = sourceSelectionsCell.get() || {};
    const subPiecesData = parentSubPiecesCell.get() || [];

    // Scan sources to find selected Notes for snapshot
    const sources = scanExtractableSources(subPiecesData);

    // Map to store ALL selected Notes modules' content (index -> content)
    // This is used for cleanup comparison after extraction
    const notesSnapshots: Record<string, string> = {};
    let hasSelectedSources = false;

    for (const source of sources) {
      // Skip if explicitly deselected or empty
      if (selectionsMap[source.index] === false) continue;
      if (source.isEmpty) continue;

      hasSelectedSources = true;

      if (source.type === "notes") {
        // Access piece content via .get() first to resolve links, then access properties
        // Cell.key() navigation doesn't work through link boundaries - piece is stored as a link
        const entry = (parentSubPiecesCell as Writable<SubPieceEntry[]>)
          .key(source.index)
          .get();
        const piece = entry?.piece as Record<string, unknown>;
        const liveContent = getCellValue<unknown>(piece?.content);
        const content = typeof liveContent === "string" ? liveContent : "";

        if (content.trim()) {
          // Store snapshot for this Notes module (keyed by index as string to avoid Cell array coercion)
          notesSnapshots[String(source.index)] = content;
        }
      }
      // Note: text-import and photo sources don't need special handling here
      // Per-source extraction architecture builds prompts reactively for each source
    }

    if (hasSelectedSources) {
      // Snapshot ALL selected Notes content for cleanup (map of index -> content)
      notesContentSnapshotCell.set(notesSnapshots);
      // Set phase to extracting - per-source prompts are built reactively
      extractPhaseCell.set("extracting");
    }
  },
);

// ===== applySelected Helper Functions =====

/**
 * Apply a single extracted value to an existing module field.
 * Validates the value against the schema before applying.
 *
 * @returns true if the field was successfully applied, false otherwise
 */
function applyFieldToModule(
  parentSubPiecesCell: Writable<SubPieceEntry[]>,
  existingIndex: number,
  moduleType: string,
  fieldName: string,
  extractedValue: unknown,
  subPieces: readonly SubPieceEntry[],
): boolean {
  // Get the primary field name (e.g., "notes" alias -> "content" primary)
  const actualFieldName = getPrimaryFieldName(fieldName, moduleType);

  // Validate extracted value against schema (use actual field name)
  const fieldSchema = getFieldSchema(subPieces, moduleType, actualFieldName);
  const isValid = validateFieldValue(extractedValue, fieldSchema);

  if (!isValid) {
    const actualType = Array.isArray(extractedValue)
      ? "array"
      : typeof extractedValue;
    console.warn(
      `[Extract] Type mismatch for ${moduleType}.${actualFieldName}: ` +
        `expected ${fieldSchema?.type}, got ${actualType}. ` +
        `Value: ${JSON.stringify(extractedValue)}. Skipping field.`,
    );
    return false;
  }

  try {
    // Only write if validation passed
    // Cast needed: Cell.key() navigation loses type info for dynamic nested paths
    // Use actualFieldName to write to the correct field (handles aliases)
    (parentSubPiecesCell as Writable<SubPieceEntry[]>)
      .key(existingIndex)
      .key("piece")
      .key(actualFieldName)
      .set(extractedValue);
    return true;
  } catch (e) {
    console.warn(`Failed to set ${moduleType}.${actualFieldName}:`, e);
    return false;
  }
}

/**
 * Create a new sub-piece module with extracted fields.
 * Validates each field before adding to initial values.
 *
 * @returns The new SubPieceEntry or null if no valid fields
 */
function createModuleWithFields(
  moduleType: string,
  fields: ExtractedField[],
  subPieces: readonly SubPieceEntry[],
): SubPieceEntry | null {
  // Build initial values object from extracted fields
  const initialValues: Record<string, unknown> = {};

  for (const field of fields) {
    // Get the primary field name (e.g., "notes" alias -> "content" primary)
    const actualFieldName = getPrimaryFieldName(field.fieldName, moduleType);

    // Validate before adding to initialValues (use actual field name)
    const fieldSchema = getFieldSchema(subPieces, moduleType, actualFieldName);
    const isValid = validateFieldValue(field.extractedValue, fieldSchema);

    if (!isValid) {
      const actualType = Array.isArray(field.extractedValue)
        ? "array"
        : typeof field.extractedValue;
      console.warn(
        `[Extract] Type mismatch for new module ${moduleType}.${actualFieldName}: ` +
          `expected ${fieldSchema?.type}, got ${actualType}. ` +
          `Value: ${JSON.stringify(field.extractedValue)}. Skipping field.`,
      );
      continue;
    }

    // Use actualFieldName to store in the correct field
    initialValues[actualFieldName] = field.extractedValue;
  }

  // Only create module if we have at least one valid field
  if (Object.keys(initialValues).length === 0) {
    return null;
  }

  try {
    const newPiece = createSubPiece(moduleType, initialValues);
    // Capture schema at creation time for dynamic discovery
    const schema = getResultSchema(newPiece);
    return {
      type: moduleType,
      pinned: false,
      piece: newPiece,
      schema,
    };
  } catch (e) {
    console.warn(`Failed to create module ${moduleType}:`, e);
    return null;
  }
}

/**
 * Parameters for Notes cleanup operation.
 */
interface NotesCleanupParams {
  parentSubPiecesCell: Writable<SubPieceEntry[]>;
  current: SubPieceEntry[];
  cleanupEnabledValue: boolean;
  cleanedNotesValue: string;
  notesSnapshotMapValue: Record<string, string>;
  cleanupApplyStatusCell: Writable<
    Default<"pending" | "success" | "failed" | "skipped", "pending">
  >;
}

/**
 * Apply Notes cleanup by updating the Notes module content.
 * Uses a dual-approach architecture for reliability:
 *
 * 1. Stream.send() - Preferred method for cross-piece mutation
 * 2. Cell.key() navigation - Fallback when stream is unavailable
 *
 * @returns true if any cleanup was successfully applied
 */
function applyNotesCleanup(params: NotesCleanupParams): boolean {
  const {
    parentSubPiecesCell,
    current,
    cleanupEnabledValue,
    cleanedNotesValue,
    notesSnapshotMapValue,
    cleanupApplyStatusCell,
  } = params;

  if (!cleanupEnabledValue || cleanedNotesValue === undefined) {
    cleanupApplyStatusCell.set("skipped");
    return false;
  }

  // Get all Notes module indices that were used as extraction sources
  const notesIndices = Object.keys(notesSnapshotMapValue || {}).map(Number);

  if (notesIndices.length === 0) {
    cleanupApplyStatusCell.set("skipped");
    return false;
  }

  let allCleanupSucceeded = true;
  let anyCleanupAttempted = false;
  let anyCleanupSucceeded = false;

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
      const notesPiece = notesEntry.piece as {
        editContent?: { send?: (data: unknown) => void };
      };
      if (notesPiece?.editContent?.send) {
        notesPiece.editContent.send({
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
        // Cast needed: Writable.key() navigation loses type info for dynamic nested paths
        (parentSubPiecesCell as Writable<SubPieceEntry[]>)
          .key(notesIndex)
          .key("piece")
          .key("content")
          .set(cleanedNotesValue);
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

    if (thisCleanupSucceeded) {
      anyCleanupSucceeded = true;
    } else {
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
    cleanupApplyStatusCell.set(allCleanupSucceeded ? "success" : "failed");
  }

  return anyCleanupSucceeded;
}

/**
 * Build a list of indices to trash based on source selections.
 * Excludes Notes modules (they are never trashed).
 *
 * @param sources - All extractable sources
 * @param trashSelections - Map of source index to trash selection state
 * @param selfIndex - Index of the extractor module (always included in trash list)
 * @returns Array of indices to trash, sorted descending for safe removal
 */
function buildTrashList(
  sources: ExtractableSource[],
  trashSelections: Record<number, boolean>,
  selfIndex: number,
): number[] {
  const indicesToTrash: number[] = [];

  // Add selected source indices to trash list (excluding Notes - Notes is never trashed)
  for (const source of sources) {
    if (source.type === "notes") continue; // Never trash Notes
    if (trashSelections[source.index] === true) {
      indicesToTrash.push(source.index);
    }
  }

  // Add self (extractor) index
  if (selfIndex >= 0) {
    indicesToTrash.push(selfIndex);
  }

  // Sort descending to preserve indices when removing
  indicesToTrash.sort((a, b) => b - a);

  return indicesToTrash;
}

/**
 * Handler to apply selected extractions - defined at module scope
 */
const applySelected = handler<
  unknown,
  {
    parentSubPiecesCell: Writable<SubPieceEntry[]>;
    parentTrashedSubPiecesCell: Writable<TrashedSubPieceEntry[]>;
    parentTitleCell: Writable<string>;
    extractionResultValue: Record<string, unknown> | null;
    // Field metadata from extraction (confidence scores, explanations)
    extractionFieldMetadataValue: Record<
      string,
      { confidence: number; explanation: string; sourceExcerpt?: string }
    >;
    selectionsCell: Writable<
      Default<Record<string, boolean>, Record<string, never>>
    >;
    trashSelectionsCell: Writable<
      Default<Record<number, boolean>, Record<number, never>>
    >;
    cleanupEnabledValue: boolean;
    cleanedNotesValue: string;
    // Dereferenced value from notesContentSnapshot Cell (map of Notes module index as string -> original content)
    notesSnapshotMapValue: Record<string, string>;
    cleanupApplyStatusCell: Writable<
      Default<"pending" | "success" | "failed" | "skipped", "pending">
    >;
    applyInProgressCell: Writable<Default<boolean, false>>;
  }
>(
  (
    _event,
    {
      parentSubPiecesCell,
      parentTrashedSubPiecesCell,
      parentTitleCell,
      extractionResultValue,
      extractionFieldMetadataValue,
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
      const rawSubPieces = parentSubPiecesCell.get() || [];
      const subPiecesData = rawSubPieces.filter(
        (e): e is SubPieceEntry =>
          e != null && typeof e === "object" && "type" in e,
      );
      const extractionResult = extractionResultValue;
      if (!extractionResult) return;

      const currentTitle = parentTitleCell.get() || "";
      const previewData = buildPreview(
        extractionResult,
        subPiecesData,
        currentTitle,
        extractionFieldMetadataValue,
      );
      const sourcesData = scanExtractableSources(subPiecesData);

      if (!previewData || !previewData.fields) return;

      // Filter current entries too (defensive)
      const current: SubPieceEntry[] = (parentSubPiecesCell.get() || []).filter(
        (e): e is SubPieceEntry =>
          e != null && typeof e === "object" && "type" in e,
      );
      const subPieces = current; // For schema lookups
      const selected = selectionsCell.get() || {};
      const toTrash = trashSelectionsCell.get() || {};

      // Group fields by target module
      const fieldsByModule: Record<string, ExtractedField[]> = {};
      for (const field of previewData.fields) {
        const fieldKey = `${field.targetModule}.${field.fieldName}`;
        // Check explicit selection state first
        if (selected[fieldKey] !== undefined) {
          if (selected[fieldKey] === false) continue;
        } else {
          // Default: skip low confidence fields (not explicitly selected)
          if (field.confidenceLevel === "low") continue;
        }

        if (!fieldsByModule[field.targetModule]) {
          fieldsByModule[field.targetModule] = [];
        }
        fieldsByModule[field.targetModule].push(field);
      }

      // Track success - only trash extractor if at least one update succeeded
      let anySuccess = false;

      // Collect new entries to add (batched to avoid multiple set() calls)
      const newEntries: SubPieceEntry[] = [];

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

              const newPiece = createSubPiece(moduleType, initialValues);
              const schema = getResultSchema(newPiece);
              newEntries.push({
                type: moduleType,
                pinned: false,
                piece: newPiece,
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
          // Module exists - use helper to update fields
          for (const field of fields) {
            // Get the primary field name for skip-check
            const actualFieldName = getPrimaryFieldName(
              field.fieldName,
              moduleType,
            );

            // Skip Notes content extraction when cleanup is enabled
            // The cleanup will handle setting the final Notes content (with extracted data removed)
            if (
              moduleType === "notes" &&
              actualFieldName === "content" &&
              cleanupEnabledValue
            ) {
              console.debug(
                "[Extract] Skipping notes.content extraction - cleanup will handle it",
              );
              continue;
            }

            // Apply field using helper function
            const success = applyFieldToModule(
              parentSubPiecesCell,
              existingIndex,
              moduleType,
              field.fieldName,
              field.extractedValue,
              subPieces,
            );
            if (success) {
              anySuccess = true;
            }
          }
        } else if (moduleType !== "notes") {
          // Module doesn't exist - use helper to create it with initial values
          const newEntry = createModuleWithFields(
            moduleType,
            fields,
            subPieces,
          );
          if (newEntry) {
            newEntries.push(newEntry);
            anySuccess = true;
          }
        }
      }

      // Only proceed with trashing if at least one update succeeded OR cleanup will change content
      // Notes cleanup counts as a "success" because the extraction worked - we have cleaned content to apply
      const combinedSnapshot = Object.values(notesSnapshotMapValue || {}).join(
        "\n\n---\n\n",
      );
      const cleanupWillApply = cleanupEnabledValue &&
        cleanedNotesValue !== undefined &&
        Object.keys(notesSnapshotMapValue || {}).length > 0 &&
        cleanedNotesValue !== combinedSnapshot;

      if (!anySuccess && !cleanupWillApply) {
        console.warn(
          "[Extract] No updates succeeded and no cleanup pending, keeping extractor for retry",
        );
        return;
      }

      // Apply Notes cleanup using helper function
      // See applyNotesCleanup for dual-approach architecture details
      applyNotesCleanup({
        parentSubPiecesCell,
        current,
        cleanupEnabledValue,
        cleanedNotesValue,
        notesSnapshotMapValue,
        cleanupApplyStatusCell,
      });

      // Build trash list using helper function
      const selfIndex = current.findIndex((e) => e?.type === "extractor");
      const indicesToTrash = buildTrashList(sourcesData, toTrash, selfIndex);

      // Move items to trash
      for (const idx of indicesToTrash) {
        const entry = current[idx];
        if (entry) {
          parentTrashedSubPiecesCell.push({
            ...entry,
            trashedAt: Temporal.Now.instant().toString(),
          });
        }
      }

      // Build final list: remove trashed items, add new entries
      const remaining = current.filter((_, i) => !indicesToTrash.includes(i));
      const final = [...remaining, ...newEntries];
      parentSubPiecesCell.set(final);
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
      parentSubPieces,
      parentTrashedSubPieces,
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
      errorDetailsExpanded,
    },
  ) => {
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
      const subPieces = parentSubPieces.get() || [];
      const sources = scanExtractableSources(subPieces);
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
        (call: { index: number; ocr?: { pending?: boolean } }) =>
          call.ocr?.pending,
      );
    });

    // Get OCR results as a map (index -> text)
    const ocrResults = computed((): Record<number, string> => {
      // ocrCalls auto-dereferences inside computed()
      const calls = ocrCalls;
      const results: Record<number, string> = {};
      if (!calls || calls.length === 0) return results;

      for (const call of calls) {
        if (call.ocr?.result) {
          results[call.index] = call.ocr.result as string;
        }
      }
      return results;
    });

    // Get OCR errors as a map (index -> error message)
    const ocrErrors = computed((): Record<number, string> => {
      const calls = ocrCalls;
      const errors: Record<number, string> = {};
      if (!calls || calls.length === 0) return errors;

      for (const call of calls) {
        const error = call.ocr?.error as { message?: string } | undefined;
        if (error) {
          errors[call.index] = String(error.message || error);
        }
      }
      return errors;
    });

    // Check if any OCR failed
    const hasOcrErrors = computed(() => {
      const errors = ocrErrors;
      return Object.keys(errors).length > 0;
    });

    // ===== PER-SOURCE EXTRACTION ARCHITECTURE =====
    // Each selected source gets its own generateObject() call, then results are merged.
    // This enables:
    // - Independent extraction from each source (notes, text-import, photo)
    // - Precedence-based merging (photos > text-import > notes)
    // - Per-source status tracking in UI

    // Get selected sources that are ready for extraction
    // Only include sources after phase transitions to "extracting"
    const selectedSourcesForExtraction = computed((): ExtractableSource[] => {
      const phase = extractPhase.get() || "select";
      if (phase !== "extracting") return [];

      const sources = sourceData.sources;
      return sources.filter((s: ExtractableSource) => s.selected && !s.isEmpty);
    });

    // ===== SINGLE COMBINED EXTRACTION =====
    // Build a single combined prompt from all sources to avoid the complexity
    // of per-source extraction with .map() which can cause reactive issues.
    // This is simpler and avoids the problem of creating computed() nodes
    // inside .map() callbacks.
    const combinedExtractionPrompt = computed((): string | undefined => {
      const phase = extractPhase.get() || "select";
      if (phase !== "extracting") return undefined;

      const sources = selectedSourcesForExtraction;
      const ocrMap = ocrResults;
      const promptParts: string[] = [];

      for (const source of sources) {
        if (source.type === "photo") {
          // For photos, use OCR result
          const ocrText = ocrMap[source.index];
          if (ocrText && ocrText.trim()) {
            promptParts.push(`--- ${source.label} (OCR) ---\n${ocrText}`);
          }
        } else {
          // Use content from source object directly
          const content = source.content || "";
          if (content.trim()) {
            promptParts.push(`--- ${source.label} ---\n${content}`);
          }
        }
      }

      if (promptParts.length === 0) return undefined;
      return promptParts.join("\n\n");
    });

    // Single extraction call for all sources combined
    const singleExtraction = generateObject({
      system: EXTRACTION_SYSTEM_PROMPT,
      prompt: combinedExtractionPrompt,
      schema: RECOMMENDATIONS_SCHEMA,
      model: "anthropic:claude-haiku-4-5",
    });

    // Build a synthetic perSourceExtractions array for compatibility with existing code
    // This wraps the single extraction result as if it came from multiple sources
    // NOTE: Use for loop instead of .map() to avoid transformer issues inside computed()
    const perSourceExtractions = computed(() => {
      const sources = selectedSourcesForExtraction;
      if (!sources || sources.length === 0) return [];

      // All sources share the same extraction result
      const result: Array<{
        sourceIndex: number;
        sourceType: "notes" | "text-import" | "photo";
        sourceLabel: string;
        extraction: typeof singleExtraction;
      }> = [];

      for (const source of sources) {
        result.push({
          sourceIndex: source.index,
          sourceType: source.type,
          sourceLabel: source.label,
          extraction: singleExtraction,
        });
      }

      return result;
    });

    // ===== EXTRACTION STATE TRACKING =====
    // Access reactive properties directly inside computed() to establish proper subscriptions.
    // This follows the same pattern as ocrPending and ocrResults which access call.ocr?.pending
    // and call.ocr?.result directly inside computed().
    //
    // IMPORTANT: Do NOT use intermediate .map() arrays outside computed() - they create
    // non-reactive plain arrays that don't update when the underlying reactive properties change.

    // Build SourceExtraction array with status from per-source calls
    // Also collect field metadata (confidence, explanation) for preview
    // Access extraction.pending, extraction.result, extraction.error directly to establish subscriptions
    const sourceExtractionsWithMetadata = computed((): {
      extractions: SourceExtraction[];
      allFieldMetadata: Record<
        string,
        { confidence: number; explanation: string; sourceExcerpt?: string }
      >;
    } => {
      const calls = perSourceExtractions;

      if (!calls || calls.length === 0) {
        return { extractions: [], allFieldMetadata: {} };
      }

      const extractionList: SourceExtraction[] = [];
      const allFieldMetadata: Record<
        string,
        { confidence: number; explanation: string; sourceExcerpt?: string }
      > = {};

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        let status: SourceExtractionStatus = "pending";
        let extractedFields: Record<string, unknown> | null = null;
        let error: string | undefined;
        let fieldCount = 0;

        // Access extraction state directly from the call object (reactive)
        // This establishes proper reactive subscriptions, just like ocrPending/ocrResults do
        const isPending = call.extraction?.pending;
        const extractionResult = call.extraction?.result;
        const extractionError = call.extraction?.error;

        // Determine status based on extraction state
        if (isPending === undefined && !extractionResult && !extractionError) {
          // Extraction not initialized yet
          status = "pending";
        } else if (isPending) {
          status = "extracting";
        } else if (extractionError) {
          status = "error";
          const errorObj = extractionError as { message?: string };
          error = String(errorObj.message || extractionError);
        } else if (
          !isPending && !extractionResult && !extractionError
        ) {
          // No pending, no result, no error = extraction hasn't started (prompt undefined)
          // This happens when waiting for OCR or content is empty
          // Mark as pending so UI shows loading state
          status = "pending";
        } else if (extractionResult) {
          status = "complete";
          const result = extractionResult;

          // Check if result is in recommendations format
          if (isRecommendationsResult(result)) {
            // Convert recommendations to flat fields and collect metadata
            const { flatFields, fieldMetadata } = flattenRecommendations(
              result.recommendations,
            );
            extractedFields = normalizeNullString(flatFields) as Record<
              string,
              unknown
            >;
            // Merge metadata from this source
            Object.assign(allFieldMetadata, fieldMetadata);
          } else {
            // Legacy flat field format - normalize null strings
            extractedFields = normalizeNullString(
              result as Record<string, unknown>,
            ) as Record<string, unknown>;
          }

          // Count non-null fields
          fieldCount = Object.values(extractedFields).filter(
            (v) => v !== null && v !== undefined,
          ).length;
        }

        extractionList.push({
          sourceIndex: call.sourceIndex as number,
          sourceType: call.sourceType as "notes" | "text-import" | "photo",
          sourceLabel: call.sourceLabel as string,
          status,
          extractedFields,
          error,
          fieldCount,
        });
      }

      return { extractions: extractionList, allFieldMetadata };
    });

    // Accessor for just the extractions array
    const sourceExtractions = computed(
      (): SourceExtraction[] => sourceExtractionsWithMetadata.extractions,
    );

    // Accessor for field metadata (for buildPreview)
    const extractionFieldMetadata = computed(
      (): Record<
        string,
        { confidence: number; explanation: string; sourceExcerpt?: string }
      > => sourceExtractionsWithMetadata.allFieldMetadata,
    );

    // Per-source status tracking computed values
    const anySourcePending = computed((): boolean => {
      const extractions = sourceExtractions;
      if (!extractions || extractions.length === 0) return false;
      return extractions.some(
        (e: SourceExtraction) =>
          e.status === "pending" || e.status === "extracting",
      );
    });

    // Merge all per-source extraction results using precedence
    const mergedExtractionResult = computed(
      (): Record<string, unknown> | null => {
        const extractions = sourceExtractions;
        if (!extractions || extractions.length === 0) return null;

        // Wait until all sources are complete
        const allComplete = extractions.every(
          (e: SourceExtraction) =>
            e.status === "complete" || e.status === "error" ||
            e.status === "skipped",
        );
        if (!allComplete) return null;

        // Merge using precedence rules
        return mergeExtractionResults(extractions);
      },
    );

    // Check if any per-source extraction has an error
    const anyExtractionError = computed((): boolean => {
      const extractions = sourceExtractions;
      if (!extractions) return false;
      return extractions.some((e: SourceExtraction) => e.status === "error");
    });

    // Get first error message for display
    const firstExtractionError = computed((): string | null => {
      const extractions = sourceExtractions;
      if (!extractions) return null;
      const errorSource = extractions.find(
        (e: SourceExtraction) => e.status === "error",
      );
      return errorSource?.error || null;
    });

    // Computed to dereference extraction result for passing to handlers
    // extraction.result is a reactive property that doesn't auto-dereference when passed directly
    // This ensures the handler receives the actual value, not a reactive proxy
    const extractionResultValue = computed(
      (): Record<string, unknown> | null => {
        const result = mergedExtractionResult;
        if (!result || typeof result !== "object") return null;
        return result as Record<string, unknown>;
      },
    );

    // Computed to dereference field metadata for passing to handlers
    const extractionFieldMetadataValue = computed(
      (): Record<
        string,
        { confidence: number; explanation: string; sourceExcerpt?: string }
      > => {
        return extractionFieldMetadata || {};
      },
    );

    // Build preview from merged extraction result
    const preview = computed((): ExtractionPreview | null => {
      if (!mergedExtractionResult) return null;
      const subPieces = parentSubPieces.get() || [];
      const currentTitle = parentTitle.get() || "";
      const metadata = extractionFieldMetadata;
      const result = buildPreview(
        mergedExtractionResult,
        subPieces,
        currentTitle,
        metadata,
      );
      return result;
    });

    // Count selected fields for button text
    // Low confidence fields (< 50) are deselected by default
    const selectedCount = computed(() => {
      const p = preview;
      if (!p?.fields) return 0;
      const sel = selections.get() || {};
      return p.fields.filter((f: ExtractedField) => {
        const key = `${f.targetModule}.${f.fieldName}`;
        // Check explicit selection state first
        if (sel[key] !== undefined) {
          return sel[key] !== false;
        }
        // Default: deselect low confidence fields (< 50)
        if (f.confidenceLevel === "low") {
          return false;
        }
        return true; // Default is selected for high/medium confidence
      }).length;
    });

    // Determine current phase based on state
    // Force reactive dependency on preview by assigning to local variable BEFORE any early returns
    // Without this, early return paths (pending/error) prevent preview from being tracked as dependency
    const currentPhase = computed(() => {
      const p = preview; // Establish reactive dependency before any conditionals
      const pending = anySourcePending;
      const hasError = anyExtractionError;
      const mergedResult = mergedExtractionResult;
      const phase = extractPhase.get() || "select";
      if (phase === "extracting") {
        if (pending) return "extracting";
        if (hasError) return "error";
        if (p?.fields?.length) return "preview";
        if (mergedResult && !p?.fields?.length) return "no-results";
        return "extracting";
      }
      return phase;
    });

    // Validation summary computed values
    const validationErrorCount = computed(() => {
      const p = preview;
      return p?.validationSummary?.errorCount || 0;
    });
    const validationWarningCount = computed(() => {
      const p = preview;
      return p?.validationSummary?.warningCount || 0;
    });
    const hasValidationIssues = computed(() => {
      const errors = Number(validationErrorCount);
      const warnings = Number(validationWarningCount);
      return errors > 0 || warnings > 0;
    });
    const validationSummaryText = computed(() => {
      const errors = Number(validationErrorCount);
      const warnings = Number(validationWarningCount);
      const parts: string[] = [];
      if (errors > 0) {
        parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
      }
      if (warnings > 0) {
        parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
      }
      return parts.join(", ");
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
      if (!mergedExtractionResult) return combinedSnapshot;
      const result = mergedExtractionResult as Record<string, unknown>;
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

    // Error message parsing for specific error feedback
    // Parse the extraction error to show user-friendly messages based on error type
    const errorMessage = computed((): string => {
      const error = firstExtractionError;
      if (!error) return "Extraction failed. Try again or add more content.";

      const errorStr = String(error).toLowerCase();

      // Rate limiting errors (429, rate limit)
      if (errorStr.includes("rate") || errorStr.includes("429")) {
        return "Rate limited - please wait a moment and try again";
      }

      // Timeout errors
      if (errorStr.includes("timeout")) {
        return "Request timed out - try with less content";
      }

      // Parse/validation errors
      if (errorStr.includes("invalid") || errorStr.includes("parse")) {
        return "Invalid response from AI - try again";
      }

      // Default: Show actual error message (truncated if needed)
      if (error.length > 100) {
        return error.slice(0, 100) + "...";
      }
      return error;
    });

    // Full error details for expandable section
    const fullErrorDetails = computed((): string => {
      const error = firstExtractionError;
      if (!error) return "";
      return error;
    });

    // Check if error details are expanded
    const showErrorDetails = computed(() =>
      errorDetailsExpanded.get() === true
    );

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

    // Pre-computed field selection state map for preview checkboxes
    // Low confidence fields are deselected by default
    const fieldCheckStates = computed((): Record<string, boolean> => {
      const p = preview;
      if (!p?.fields) return {};
      const sel = selections.get() || {};
      const result: Record<string, boolean> = {};
      for (const f of p.fields) {
        const key = `${f.targetModule}.${f.fieldName}`;
        // Check explicit selection state first
        if (sel[key] !== undefined) {
          result[key] = sel[key] !== false;
        } else {
          // Default: deselect low confidence fields (< 50)
          result[key] = f.confidenceLevel !== "low";
        }
      }
      return result;
    });

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

    // Progress feedback computed values for extracting phase
    const photoSourceCount = computed(() => sourceData.photoSources.length);

    // Progress message for extracting phase
    const extractingProgressMessage = computed(() => {
      const photosCount = Number(photoSourceCount);
      const ocrInProgress = Boolean(ocrPending);

      if (photosCount > 0 && ocrInProgress) {
        // OCR is still running
        if (photosCount > 1) {
          return `Processing ${photosCount} photos (OCR)...`;
        }
        return "Processing photo (OCR)...";
      }
      // OCR done (or no photos), extraction is running
      return "Extracting structured data...";
    });

    // Progress icon for extracting phase
    const extractingProgressIcon = computed(() => {
      const photosCount = Number(photoSourceCount);
      const ocrInProgress = Boolean(ocrPending);

      if (photosCount > 0 && ocrInProgress) {
        return "\u{1F4F7}"; // camera emoji
      }
      return "\u{1F50D}"; // magnifying glass emoji
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
              {ifElse(isPreviewPhase, "Review Changes", "Select Sources")}
            </span>
            {ifElse(
              isExtractingPhase,
              null,
              <button
                type="button"
                onClick={dismiss({ parentSubPieces, parentTrashedSubPieces })}
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
                          {source.isEmpty && (
                            <div
                              style={{
                                fontSize: "11px",
                                color: "#6b7280",
                                marginTop: "4px",
                              }}
                            >
                              Add content to enable extraction
                            </div>
                          )}
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

                  {/* OCR error indicator */}
                  {ifElse(
                    hasOcrErrors,
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        padding: "8px",
                        background: "#fef2f2",
                        borderRadius: "6px",
                        fontSize: "13px",
                        color: "#dc2626",
                        border: "1px solid #fecaca",
                      }}
                    >
                      <span style={{ fontSize: "16px" }}>⚠️</span>
                      <span>
                        OCR failed for some photos. Extraction will continue
                        with available text.
                      </span>
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
                        parentSubPiecesCell: parentSubPieces,
                        extractPhaseCell: extractPhase,
                        notesContentSnapshotCell: notesContentSnapshot,
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
              <span style={{ color: "#92400e" }}>
                {extractingProgressIcon} {extractingProgressMessage}
              </span>
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
                {errorMessage}
              </div>
              {/* Expandable error details section */}
              <div>
                <button
                  type="button"
                  onClick={() => {
                    const current = errorDetailsExpanded.get() === true;
                    errorDetailsExpanded.set(!current);
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    fontSize: "12px",
                    color: "#6b7280",
                    padding: "4px 0",
                    textDecoration: "underline",
                  }}
                >
                  {ifElse(showErrorDetails, "Hide details", "Show details")}
                </button>
                {ifElse(
                  showErrorDetails,
                  <div
                    style={{
                      marginTop: "8px",
                      padding: "8px",
                      background: "#fef2f2",
                      borderRadius: "4px",
                      fontSize: "11px",
                      color: "#7f1d1d",
                      fontFamily: "monospace",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: "120px",
                      overflow: "auto",
                    }}
                  >
                    {fullErrorDetails}
                  </div>,
                  null,
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  extractPhase.set("select");
                  extractionPrompt.set("");
                  errorDetailsExpanded.set(false);
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
              {/* Extracted fields with confidence badges */}
              <div
                style={{
                  background: "white",
                  borderRadius: "6px",
                  border: "1px solid #e5e7eb",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "12px",
                    borderBottom: "1px solid #e5e7eb",
                    fontWeight: "500",
                    color: "#374151",
                  }}
                >
                  Extracted Fields ({selectedCount} selected):
                </div>
                {preview?.fields?.map((f: ExtractedField, idx: number) => {
                  const fieldKey = `${f.targetModule}.${f.fieldName}`;
                  const displayModule = f.targetModule === "record-title"
                    ? "Record Title"
                    : f.targetModule;
                  const isChecked = fieldCheckStates[fieldKey] === true;
                  const defaultSelected = f.confidenceLevel !== "low";

                  // Confidence badge - always include, show based on level
                  const confidenceBg = f.confidenceLevel === "high"
                    ? "#dcfce7"
                    : f.confidenceLevel === "medium"
                    ? "#fef9c3"
                    : f.confidenceLevel === "low"
                    ? "#fee2e2"
                    : "transparent";
                  const confidenceColor = f.confidenceLevel === "high"
                    ? "#166534"
                    : f.confidenceLevel === "medium"
                    ? "#854d0e"
                    : f.confidenceLevel === "low"
                    ? "#991b1b"
                    : "#9ca3af";
                  const confidenceIcon = f.confidenceLevel === "high"
                    ? "\u2713"
                    : f.confidenceLevel === "medium"
                    ? "\u25CF"
                    : f.confidenceLevel === "low"
                    ? "\u26A0"
                    : "";
                  const confidenceLabel = f.confidenceLevel === "high"
                    ? "High"
                    : f.confidenceLevel === "medium"
                    ? "Med"
                    : f.confidenceLevel === "low"
                    ? "Low"
                    : "";
                  const hasConfidence = f.confidenceLevel !== undefined;

                  return (
                    <div
                      key={idx}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "8px",
                        padding: "10px 12px",
                        borderBottom: "1px solid #f3f4f6",
                        opacity: isChecked ? 1 : 0.6,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={toggleFieldHandler({
                          fieldKey,
                          selectionsCell: selections,
                          defaultSelected,
                        })}
                        style={{ marginTop: "2px" }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            marginBottom: "4px",
                            flexWrap: "wrap",
                          }}
                        >
                          <span
                            style={{
                              fontWeight: "500",
                              color: "#374151",
                              fontSize: "13px",
                            }}
                          >
                            {displayModule}.{f.fieldName}
                          </span>
                          {ifElse(
                            hasConfidence,
                            <span
                              style={{
                                fontSize: "11px",
                                padding: "1px 6px",
                                borderRadius: "4px",
                                background: confidenceBg,
                                color: confidenceColor,
                              }}
                            >
                              {confidenceIcon} {confidenceLabel}
                            </span>,
                            null,
                          )}
                          {ifElse(
                            f.validationIssue !== undefined,
                            <span
                              style={{
                                fontSize: "11px",
                                padding: "1px 6px",
                                borderRadius: "4px",
                                background:
                                  f.validationIssue?.severity === "error"
                                    ? "#fee2e2"
                                    : "#fef3c7",
                                color: f.validationIssue?.severity === "error"
                                  ? "#991b1b"
                                  : "#92400e",
                              }}
                            >
                              {f.validationIssue?.message}
                            </span>,
                            null,
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: "12px",
                            color: "#6b7280",
                            fontFamily: "monospace",
                          }}
                        >
                          {formatValue(f.currentValue)} -&gt;{" "}
                          {formatValue(f.extractedValue)}
                        </div>
                        {ifElse(
                          f.explanation !== undefined && f.explanation !== "",
                          <div
                            style={{
                              fontSize: "11px",
                              color: "#9ca3af",
                              marginTop: "4px",
                              fontStyle: "italic",
                            }}
                          >
                            {f.explanation}
                          </div>,
                          null,
                        )}
                      </div>
                    </div>
                  );
                })}
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

              {/* Validation summary */}
              {ifElse(
                hasValidationIssues,
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "8px 12px",
                    background: "#fef3c7",
                    border: "1px solid #fde68a",
                    borderRadius: "6px",
                    fontSize: "13px",
                    color: "#92400e",
                  }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                    }}
                  >
                    {ifElse(
                      validationErrorCount,
                      <span
                        style={{
                          display: "inline-block",
                          width: "8px",
                          height: "8px",
                          borderRadius: "50%",
                          background: "#ef4444",
                        }}
                      />,
                      <span
                        style={{
                          display: "inline-block",
                          width: "8px",
                          height: "8px",
                          borderRadius: "50%",
                          background: "#f59e0b",
                        }}
                      />,
                    )}
                    <span>{validationSummaryText}</span>
                  </span>
                  <span style={{ color: "#78716c", fontSize: "12px" }}>
                    - review before applying
                  </span>
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
                  onClick={dismiss({ parentSubPieces, parentTrashedSubPieces })}
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
                    parentSubPiecesCell: parentSubPieces,
                    parentTrashedSubPiecesCell: parentTrashedSubPieces,
                    parentTitleCell: parentTitle,
                    // Pass computed that dereferences mergedExtractionResult (reactive properties
                    // don't auto-dereference when passed directly to handlers)
                    extractionResultValue: extractionResultValue,
                    // Pass field metadata for confidence levels in buildPreview
                    extractionFieldMetadataValue: extractionFieldMetadataValue,
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
      errorDetailsExpanded,
    };
  },
);

export default ExtractorModule;
