/**
 * Types for LLM-assisted extraction module
 */

import type { ImageData } from "commontools";

/**
 * Validation issue severity level
 */
export type ValidationSeverity = "error" | "warning";

/**
 * A validation issue found during extraction
 */
export interface ValidationIssue {
  code: string; // e.g., "TYPE_MISMATCH", "INVALID_FORMAT"
  message: string;
  severity: ValidationSeverity;
}

/**
 * A single extracted field with its current and new values for diff display
 */
export interface ExtractedField {
  fieldName: string; // e.g., "email", "birthDate"
  targetModule: string; // e.g., "contact", "birthday"
  extractedValue: unknown;
  currentValue?: unknown; // For diff display (read from existing module)
  isNewInstance?: boolean; // For array extraction mode - each item creates a new module instance
  validationIssue?: ValidationIssue; // Validation problem if any
  confidence?: number; // 0-100 confidence score from LLM
  confidenceLevel?: ConfidenceLevel; // "high" | "medium" | "low"
  explanation?: string; // Why this field was extracted
  sourceExcerpt?: string; // Text snippet that led to extraction
}

/**
 * Grouped extraction results for preview UI
 */
export interface ExtractionPreview {
  fields: ExtractedField[];
  byModule: Record<string, ExtractedField[]>; // Grouped by module type
  validationSummary: {
    errorCount: number;
    warningCount: number;
  };
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
  index: number; // Index in parentSubPieces array
  type: "notes" | "text-import" | "photo";
  icon: string; // Emoji icon for display
  label: string; // Display label (filename or module name)
  preview: string; // First 100 chars or "[Image - requires OCR]"
  content?: string; // Full text content (for notes/text-import)
  requiresOCR?: boolean; // True for photos
  imageData?: ImageData; // Image data for OCR (photos only)
  isEmpty?: boolean; // True if source exists but has no content yet
  selected?: boolean; // Whether this source is selected for extraction (UI state)
}

/**
 * Extraction status for a single source
 */
export type SourceExtractionStatus =
  | "pending"
  | "extracting"
  | "complete"
  | "error"
  | "skipped";

/**
 * Per-source extraction result with metadata
 */
export interface SourceExtraction {
  sourceIndex: number;
  sourceType: "notes" | "text-import" | "photo";
  sourceLabel: string;
  status: SourceExtractionStatus;
  extractedFields: Record<string, unknown> | null;
  error?: string;
  fieldCount: number; // Number of non-null fields extracted
}

/**
 * Source type precedence for merging (higher = takes priority)
 * photos > text-import > notes
 */
export const SOURCE_PRECEDENCE: Record<
  "notes" | "text-import" | "photo",
  number
> = {
  notes: 1,
  "text-import": 2,
  photo: 3,
};

/**
 * Confidence level for extracted values
 */
export type ConfidenceLevel = "high" | "medium" | "low";

/**
 * Get confidence level from numeric score
 */
export function getConfidenceLevel(score: number): ConfidenceLevel {
  if (score >= 80) return "high";
  if (score >= 50) return "medium";
  return "low";
}

/**
 * An extraction recommendation from schema selection pattern
 */
export interface ExtractionRecommendation {
  type: string; // Module type: "email", "phone", "birthday", etc.
  score: number; // 0-100 confidence score
  explanation: string; // Why this was extracted
  extractedData: Record<string, unknown>; // Field values for this module
  sourceExcerpt?: string; // Text snippet that led to extraction
}

/**
 * Schema selection extraction result (recommendations mode)
 */
export interface RecommendationsResult {
  recommendations: ExtractionRecommendation[];
}
