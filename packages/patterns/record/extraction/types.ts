/**
 * Types for LLM-assisted extraction module
 */

import type { ImageData } from "commontools";

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
export type ExtractionPhase =
  | "select"
  | "extracting"
  | "preview"
  | "error"
  | "no-results";

/**
 * A source that can be scanned for extractable content
 */
export interface ExtractableSource {
  index: number; // Index in parentSubCharms array
  type: "notes" | "text-import" | "photo";
  icon: string; // Emoji icon for display
  label: string; // Display label (filename or module name)
  preview: string; // First 100 chars or "[Image - requires OCR]"
  content?: string; // Full text content (for notes/text-import)
  requiresOCR?: boolean; // True for photos
  imageData?: ImageData; // Image data for OCR (photos only)
  isEmpty?: boolean; // True if source exists but has no content yet
}
