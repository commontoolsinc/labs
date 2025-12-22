// types.ts - Shared types for the record pattern system

import type { JSONSchema } from "./extraction/schema-utils-pure.ts";

// ===== Sub-Charm Architecture Types =====

/**
 * Expected schema shape for extraction.
 *
 * When sub-charms are created, their resultSchema is captured and stored.
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
 * SubCharmEntry - An entry in the Record's sub-charms array.
 * Each entry holds a reference to an actual sub-charm pattern instance.
 */
export interface SubCharmEntry {
  type: string; // Module type identifier (e.g., "birthday", "email")
  pinned: boolean; // Pin state owned by Record (not the sub-charm)
  collapsed?: boolean; // Collapse state - when true, only header is shown (default: false/expanded)
  charm: unknown; // Reference to the actual sub-charm pattern instance
  schema?: JSONSchema; // Schema captured at creation time for dynamic discovery
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
  // Contact modules (with labels, support multiple instances)
  | "email"
  | "phone"
  // Icon customization
  | "record-icon"
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
