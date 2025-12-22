/**
 * Types for LLM-assisted extraction module
 */

/**
 * A single extracted field with its current and new values for diff display
 */
export interface ExtractedField {
  fieldName: string; // e.g., "email", "birthDate"
  targetModule: string; // e.g., "contact", "birthday"
  extractedValue: unknown;
  currentValue?: unknown; // For diff display (read from existing module)
}

/**
 * Grouped extraction results for preview UI
 */
export interface ExtractionPreview {
  fields: ExtractedField[];
  byModule: Record<string, ExtractedField[]>; // Grouped by module type
}

/**
 * State machine phases for extraction workflow
 */
export type ExtractionPhase = "idle" | "extracting" | "preview" | "error";
