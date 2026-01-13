/// <cts-meta>
/// id: container-protocol
/// title: Container Coordination Protocol
/// description: Protocol for controller patterns that coordinate with parent containers
/// </cts-meta>

import type { Writable } from "commontools";

/**
 * ContainerCoordinationContext - Passed to controller patterns that need
 * to coordinate with their parent container (e.g., TypePicker, future AI agents).
 *
 * This protocol enables "controller modules" - patterns that can modify their
 * parent container's state. Examples:
 * - TypePicker: applies templates by adding modules to parent
 * - Future: AI agents that dynamically configure containers
 *
 * @template TEntry - The type of entries in the container's list
 */
export interface ContainerCoordinationContext<TEntry = unknown> {
  /** Container's list of child entries */
  entries: Writable<TEntry[]>;

  /** Container's trash for soft-deleted entries */
  trashedEntries: Writable<(TEntry & { trashedAt: string })[]>;

  /** Factory to create modules with correct container context */
  createModule: (type: string) => unknown;
}

/**
 * Module metadata for self-describing patterns.
 * Each composable module exports this to describe itself.
 */
export interface ModuleMetadata {
  /** Unique type identifier (e.g., "birthday", "rating") */
  type: string;

  /** Human-readable display label */
  label: string;

  /** Emoji or icon character */
  icon: string;

  /** If true, hide from "Add module" dropdown (e.g., type-picker) */
  internal?: boolean;

  /** If true, show "add another" button for multi-instance modules (e.g., email, phone) */
  allowMultiple?: boolean;

  /** JSON Schema for the module's data (for LLM extraction) */
  schema?: Record<string, unknown>;

  /** Field names this module manages (for data mapping) */
  fieldMapping?: string[];

  /** If true, this module exports a settingsUI for configuration */
  hasSettings?: boolean;

  /** If true, always include this module's schema in extraction even with no instances */
  alwaysExtract?: boolean;

  /** Extraction mode: "single" (default) or "array" (each array item creates a module instance) */
  extractionMode?: "single" | "array";
}
