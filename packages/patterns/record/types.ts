// types.ts - Shared types for the record pattern system

// ===== Sub-Piece Architecture Types =====

/**
 * SubPieceEntry - An entry in the Record's sub-pieces array.
 * Each entry holds a reference to an actual sub-piece pattern instance.
 */
export interface SubPieceEntry {
  type: string; // Module type identifier (e.g., "birthday", "email")
  pinned: boolean; // Pin state owned by Record (not the sub-piece)
  collapsed?: boolean; // Collapse state - when true, only header is shown (default: false/expanded)
  piece: unknown; // Reference to the actual sub-piece pattern instance
  note?: string; // User annotation about this module (visible to LLM reads, not extraction)
  label?: string; // Standard label chosen for this module at creation (e.g. email "Personal"/"Work"), used to pick the next unused default
}

/**
 * TrashedSubPieceEntry - A sub-piece that has been soft-deleted.
 * Extends SubPieceEntry with a timestamp for when it was trashed.
 * Users can restore from trash or permanently delete.
 */
export interface TrashedSubPieceEntry extends SubPieceEntry {
  trashedAt: string; // ISO timestamp when moved to trash
}

// Sub-piece types (all available module types)
export type SubPieceType =
  | "notes" // Built-in, always present
  | "birthday"
  | "rating"
  | "tags"
  | "status"
  | "address"
  | "timeline"
  | "social"
  | "link"
  // Wave 3
  | "location"
  | "location-track"
  | "relationship"
  | "giftprefs"
  | "timing"
  | "age-category"
  | "dietary-restrictions"
  | "gender"
  // Contact modules (with labels, support multiple instances)
  | "email"
  | "phone"
  // Nickname/alias (supports multiple instances)
  | "nickname"
  // Icon customization
  | "record-icon"
  // List modules
  | "simple-list"
  // Photo module (with settings)
  | "photo"
  // Custom field (generic property/value pairs)
  | "custom-field"
  // Occurrence tracking
  | "occurrence-tracker"
  // Text import module (for file-based extraction sources)
  | "text-import"
  // Controller modules (internal, not user-addable)
  | "type-picker"
  | "extractor";

// Module type is the same as SubPieceType (notes is now included)
export type ModuleType = SubPieceType;

export interface SubPieceMetadata {
  type: SubPieceType;
  label: string;
  icon: string;
}
