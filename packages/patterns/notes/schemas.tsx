/// <cts-enable />
/**
 * Shared types for the Notes pattern family.
 *
 * This file contains types shared across note.tsx, notebook.tsx, and note-md.tsx.
 */

import {
  type Default,
  NAME,
  nonPrivateRandom,
  safeDateNow,
  type Stream,
  type Writable,
} from "commonfabric";

// ===== Core Entity Types =====
//
// IMPORTANT: Do NOT add [UI] to these entity types. Including [UI] in types
// that are used as references (e.g. in arrays, backlinks, mentioned lists)
// causes the runtime to deeply traverse and instantiate UI trees for every
// referenced piece, making everything extremely slow. Only pattern Output
// interfaces should declare [UI]. See NoteOutput, NotebookOutput, etc.

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
  backlinks?: MentionablePiece[];
  parentNotebook?: NotebookPiece | null;
  setTitle?: Stream<string>;
}

/**
 * A notebook's core data shape (without reactive wrappers).
 */
export interface NotebookPiece {
  [NAME]?: string;
  title?: string;
  notes?: NotePiece[];
  backlinks?: MentionablePiece[];
  isNotebook?: boolean;
  isHidden?: boolean;

  createNote: Stream<{ title: string; content: string; navigate?: boolean }>;
  createNotes: Stream<{ notesData: Array<{ title: string; content: string }> }>;
  setTitle: Stream<string>;
  createNotebook: Stream<{
    title: string;
    notesData?: Array<{ title: string; content: string }>;
  }>;
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

/**
 * A daily journal's core data shape.
 */
export interface DailyJournalPiece {
  [NAME]?: string;
  title?: string;
  entries?: NotePiece[];
  isJournal?: boolean;
  isHidden?: boolean;
}

// ===== Input Types =====

export interface NoteInput {
  title?: Writable<Default<string, "Untitled Note">>;
  content?: Writable<Default<string, "">>;
  isHidden?: Default<boolean, false>;
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
  /** Cell reference to note data (title + content + backlinks) */
  note?: Default<
    NotePiece,
    { title: ""; content: ""; backlinks: [] }
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
  `${safeDateNow().toString(36)}-${
    nonPrivateRandom().toString(36).slice(2, 11)
  }`;

/**
 * Get a comparable name from a piece.
 * Handles both local pieces (title) and wish("#default") pieces ([NAME]).
 */
export const getPieceName = (
  piece?: { [NAME]?: string; title?: string },
): string => {
  return piece?.[NAME] ?? piece?.title ?? "";
};
