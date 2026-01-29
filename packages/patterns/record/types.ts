// types.ts - Shared types for the record pattern system

import type { JSONSchema } from "./extraction/schema-utils-pure.ts";

// ===== Sub-Piece Architecture Types =====

/**
 * Expected schema shape for extraction.
 *
 * When sub-pieces are created, their resultSchema is captured and stored.
 * This enables dynamic schema discovery for LLM extraction.
 *
 * Schema should be JSON Schema-like:
 * ```
 * {
 *   type: "object",
 *   properties: {
 *     email: { type: "string", description: "Email address" },
 *     phone: { type: "string", description: "Phone number" },
 *   }
 * }
 * ```
 */

/**
 * SubPieceEntry - An entry in the Record's sub-pieces array.
 * Each entry holds a reference to an actual sub-piece pattern instance.
 */
export interface SubPieceEntry {
  type: string; // Module type identifier (e.g., "birthday", "email")
  pinned: boolean; // Pin state owned by Record (not the sub-piece)
  collapsed?: boolean; // Collapse state - when true, only header is shown (default: false/expanded)
  piece: unknown; // Reference to the actual sub-piece pattern instance
  schema?: JSONSchema; // Schema captured at creation time for dynamic discovery
  note?: string; // User annotation about this module (visible to LLM reads, not extraction)
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
