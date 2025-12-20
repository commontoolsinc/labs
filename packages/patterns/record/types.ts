// types.ts - Shared types for the record pattern system

// ===== Sub-Charm Architecture Types =====

/**
 * SubCharmEntry - An entry in the Record's sub-charms array.
 * Each entry holds a reference to an actual sub-charm pattern instance.
 */
export interface SubCharmEntry {
  type: string; // Module type identifier (e.g., "birthday", "contact")
  pinned: boolean; // Pin state owned by Record (not the sub-charm)
  charm: unknown; // Reference to the actual sub-charm pattern instance
}

/**
 * TrashedSubCharmEntry - A sub-charm that has been soft-deleted.
 * Extends SubCharmEntry with a timestamp for when it was trashed.
 * Users can restore from trash or permanently delete.
 */
export interface TrashedSubCharmEntry extends SubCharmEntry {
  trashedAt: string; // ISO timestamp when moved to trash
}

// Sub-charm types (all available module types)
export type SubCharmType =
  | "notes" // Built-in, always present
  | "birthday"
  | "rating"
  | "tags"
  | "contact"
  | "status"
  | "address"
  | "timeline"
  | "social"
  | "link"
  // Wave 3
  | "location"
  | "relationship"
  | "giftprefs"
  | "timing"
  | "age-category"
  | "dietary-restrictions"
  // Controller modules (internal, not user-addable)
  | "type-picker"
  | "extractor";

// Module type is the same as SubCharmType (notes is now included)
export type ModuleType = SubCharmType;

export interface SubCharmMetadata {
  type: SubCharmType;
  label: string;
  icon: string;
}
