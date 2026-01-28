/// <cts-enable />
/**
 * Shared types for the Notes pattern family.
 *
 * This file contains types shared across note.tsx, notebook.tsx, and note-md.tsx.
 */

import { type Default, NAME, type Writable } from "commontools";

// ===== Core Entity Types =====

/**
 * A charm that can be mentioned via [[wiki-links]] and appear in backlinks.
 * Used for the bidirectional linking system.
 */
export interface MentionableCharm {
  [NAME]?: string;
  isHidden?: boolean;
  mentioned: MentionableCharm[];
  backlinks: MentionableCharm[];
}

/**
 * Minimal charm reference - just needs a name for display.
 * Used when we only need to identify/display a charm.
 */
export interface MinimalCharm {
  [NAME]?: string;
}

/**
 * A note's core data shape (without reactive wrappers).
 * Used for type-safe access to note properties.
 */
export interface NoteData {
  [NAME]?: string;
  title?: string;
  content?: string;
  isHidden?: boolean;
  noteId?: string;
  backlinks?: MentionableCharm[];
}

/**
 * A notebook's core data shape (without reactive wrappers).
 */
export interface NotebookData {
  [NAME]?: string;
  title?: string;
  notes?: NoteData[];
  isNotebook?: boolean;
  isHidden?: boolean;
}

// ===== Input Types =====

export interface NoteInput {
  title?: Writable<Default<string, "Untitled Note">>;
  content?: Writable<Default<string, "">>;
  isHidden?: Default<boolean, false>;
  noteId?: Default<string, "">;
  /** Pattern JSON for [[wiki-links]]. Defaults to creating new Notes. */
  linkPattern?: Writable<Default<string, "">>;
  /** Parent notebook reference (passed via SELF from notebook.tsx) */
  parentNotebook?: NotebookData;
}

export interface NotebookInput {
  title?: Default<string, "Notebook">;
  notes?: Writable<Default<NoteData[], []>>;
  isNotebook?: Default<boolean, true>;
  isHidden?: Default<boolean, false>;
  parentNotebook?: NotebookData;
}

export interface NoteMdInput {
  /** Cell reference to note data (title + content + backlinks + noteId) */
  note?: Default<
    NoteData,
    { title: ""; content: ""; backlinks: []; noteId: "" }
  >;
  /** Direct reference to source note for Edit navigation */
  sourceNoteRef?: NoteData;
  /** Writable content cell for checkbox updates */
  content?: Writable<string>;
}

// ===== Utility Functions =====

/**
 * Simple random ID generator.
 * Note: crypto.randomUUID is not available in the pattern environment.
 */
export const generateId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;

/**
 * Get a comparable name from a charm.
 * Handles both local charms (title) and wish("#default") charms ([NAME]).
 */
export const getCharmName = (charm: unknown): string => {
  // First try [NAME] (works for wish("#default") charms)
  const symbolName = (charm as MinimalCharm)?.[NAME];
  if (typeof symbolName === "string") return symbolName;
  // Fallback to title (works for local charms)
  const titleProp = (charm as NoteData)?.title;
  if (typeof titleProp === "string") return titleProp;
  return "";
};
