/// <cts-enable />
/**
 * Shared types for the Notes pattern family.
 *
 * This file contains types shared across note.tsx, notebook.tsx, and note-md.tsx.
 */

import { type Default, NAME, type Writable } from "commontools";

// ===== Core Entity Types =====

/**
 * A piece that can be mentioned via [[wiki-links]] and appear in backlinks.
 * Used for the bidirectional linking system.
 */
export interface MentionablePiece {
  [NAME]?: string;
  isHidden?: boolean;
  mentioned: MentionablePiece[];
  backlinks: MentionablePiece[];
}

/**
 * Minimal piece reference - just needs a name for display.
 * Used when we only need to identify/display a piece.
 */
export interface MinimalPiece {
  [NAME]?: string;
}

/**
 * A note's core data shape (without reactive wrappers).
 * Used for type-safe access to note properties.
 */
export interface NotePiece {
  [NAME]?: string;
  title?: string;
  content?: string;
  summary?: string;
  isHidden?: boolean;
  noteId?: string;
  backlinks?: MentionablePiece[];
  parentNotebook?: NotebookPiece | null;
}

/**
 * A notebook's core data shape (without reactive wrappers).
 */
export interface NotebookPiece {
  [NAME]?: string;
  title?: string;
  notes?: NotePiece[];
  isNotebook?: boolean;
  isHidden?: boolean;
}

/**
 * A notebook cell with writable notes array.
 * Used when we need to add notes to a notebook accessed via cell operations.
 */
export interface NotebookCell {
  [NAME]?: string;
  title?: string;
  notes: Writable<NotePiece[]>;
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
  /** Parent notebook reference. Set at creation, can be updated for moves. */
  parentNotebook?: Writable<Default<NotebookPiece | null, null>>;
}

export interface NotebookInput {
  title?: Writable<Default<string, "Notebook">>;
  notes?: Writable<Default<NotePiece[], []>>;
  isNotebook?: Default<boolean, true>;
  isHidden?: Default<boolean, false>;
  /** Parent notebook reference. Set at creation, can be updated for moves. */
  parentNotebook?: Writable<Default<NotebookPiece | null, null>>;
}

export interface NoteMdInput {
  /** Cell reference to note data (title + content + backlinks + noteId) */
  note?: Default<
    NotePiece,
    { title: ""; content: ""; backlinks: []; noteId: "" }
  >;
  /** Direct reference to source note for Edit navigation */
  sourceNoteRef?: NotePiece;
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
 * Get a comparable name from a piece.
 * Handles both local pieces (title) and wish("#default") pieces ([NAME]).
 */
export const getPieceName = (piece: unknown): string => {
  // First try [NAME] (works for wish("#default") pieces)
  const symbolName = (piece as MinimalPiece)?.[NAME];
  if (typeof symbolName === "string") return symbolName;
  // Fallback to title (works for local pieces)
  const titleProp = (piece as NotePiece)?.title;
  if (typeof titleProp === "string") return titleProp;
  return "";
};
