/// <cts-enable />
import {
  action,
  computed,
  type Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commontools";

import Note from "./note.tsx";
import Notebook from "./notebook.tsx";

// ============================================================================
// PHASE 1: Core Data & Types
// ============================================================================

// Simple random ID generator (crypto.randomUUID not available in pattern env)
const generateId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;

// Types for notes and notebooks in the space
type NotePiece = {
  [NAME]?: string;
  title?: string;
  content?: string;
  isHidden?: boolean;
  noteId?: string;
};

type NotebookPiece = {
  [NAME]?: string;
  title?: string;
  notes?: NotePiece[];
  isNotebook?: boolean;
  isHidden?: boolean;
};

type MinimalPiece = {
  [NAME]?: string;
};

interface Input {
  title?: Default<string, "All Notes">;
  importMarkdown?: Default<string, "">;
  /** Pass allPieces directly from default-app for proper cell sharing */
  allPieces?: Writable<NotePiece[]>;
}

/** Manages all notes and notebooks in the space. #allNotes */
interface Output {
  [NAME]?: string;
  [UI]?: VNode;
  exportedMarkdown: string;
  importMarkdown: string;
  noteCount: number;
  notebookCount: number;
  mentionable: NotePiece[];

  // Observable state for testing
  notes: readonly NotePiece[];
  notebooks: readonly NotebookPiece[];
  detectedDuplicates: readonly DetectedDuplicate[];
  showDuplicateModal: boolean;
  showImportModal: boolean;
  showImportProgressModal: boolean;
  importComplete: boolean;
  selectedNoteIndices: readonly number[];
  selectedNotebookIndices: readonly number[];

  // Actions as Stream<T> for testing
  analyzeImport: Stream<void>;
  openImportModal: Stream<void>;
  closeImportModal: Stream<void>;
  importSkipDuplicates: Stream<void>;
  importAllAsCopies: Stream<void>;
  cancelImport: Stream<void>;
  createNote: Stream<void>;
  selectAllNotes: Stream<void>;
  deselectAllNotes: Stream<void>;
  selectAllNotebooks: Stream<void>;
  deselectAllNotebooks: Stream<void>;
  openExportAllModal: Stream<void>;
  closeExportAllModal: Stream<void>;
}

// Helper to resolve proxy value to primitive string
function resolveValue(value: unknown): string {
  try {
    return JSON.parse(JSON.stringify(value)) as string;
  } catch {
    return String(value ?? "");
  }
}

// Helper to resolve proxy value to boolean
function resolveBooleanValue(value: unknown, parentObj?: unknown): boolean {
  try {
    const resolved = JSON.parse(JSON.stringify(value));
    if (resolved === true || resolved === "true") return true;
  } catch {
    // ignore
  }
  if (parentObj) {
    try {
      const serialized = JSON.parse(JSON.stringify(parentObj));
      if (serialized?.isHidden === true) return true;
    } catch {
      // ignore
    }
  }
  return String(value) === "true";
}

// Helper to get piece name (handles both local and wish({ query: "#default" }) pieces)
function _getPieceName(piece: unknown): string {
  const symbolName = (piece as any)?.[NAME];
  if (typeof symbolName === "string") return symbolName;
  const titleProp = (piece as any)?.title;
  if (typeof titleProp === "string") return titleProp;
  return "";
}

// Helper to check if a piece is a notebook
function isNotebookPiece(piece: unknown): boolean {
  const name = (piece as any)?.[NAME];
  if (typeof name === "string" && name.startsWith("📓")) return true;
  return (piece as any)?.isNotebook === true;
}

// Helper to get clean notebook title (strip emoji and count)
function getCleanNotebookTitle(notebook: unknown): string {
  const rawName = (notebook as any)?.[NAME] ?? (notebook as any)?.title ?? "";
  return rawName.replace(/^📓\s*/, "").replace(/\s*\(\d+\)$/, "");
}

// ============================================================================
// Export/Import Format Constants
// ============================================================================

const NOTE_START_MARKER = "<!-- COMMON_NOTE_START";
const NOTE_END_MARKER = "<!-- COMMON_NOTE_END -->";
const NOTEBOOK_START_MARKER = "<!-- COMMON_NOTEBOOK_START";
const NOTEBOOK_END_MARKER = "<!-- COMMON_NOTEBOOK_END -->";

// Strip entity IDs from mentions for portable export: [[Name (id)]] -> [[Name]]
function stripMentionIds(content: string): string {
  return content.replace(/\[\[([^\]]*?)\s*\([^)]+\)\]\]/g, "[[$1]]");
}

// Get notebook names that contain a note (by noteId)
function getNotebookNamesForNote(
  note: NotePiece,
  notebooks: NotebookPiece[],
): string[] {
  const noteId = resolveValue(note?.noteId);
  if (!noteId) return [];

  const names: string[] = [];
  for (const nb of notebooks) {
    const nbNotes = nb?.notes ?? [];
    for (const n of nbNotes) {
      if (resolveValue(n?.noteId) === noteId) {
        const cleanName = getCleanNotebookTitle(nb);
        if (cleanName) names.push(cleanName);
        break;
      }
    }
  }
  return names;
}

// Get noteIds and child notebook titles from a notebook
function getNotebookContents(
  notebook: NotebookPiece,
): { noteIds: string[]; childNotebookTitles: string[] } {
  const notes = (notebook as any)?.notes ?? [];
  const noteIds: string[] = [];
  const childNotebookTitles: string[] = [];

  for (const item of notes) {
    if (isNotebookPiece(item)) {
      const title = getCleanNotebookTitle(item);
      if (title) childNotebookTitles.push(title);
    } else {
      const noteId = resolveValue((item as any)?.noteId);
      if (noteId) noteIds.push(noteId);
    }
  }

  return { noteIds, childNotebookTitles };
}

// ============================================================================
// Export Functions
// ============================================================================

function generateExport(
  pieces: NotePiece[],
  notebooks: NotebookPiece[],
  allPiecesRaw?: unknown[],
): { markdown: string; count: number; notebookCount: number } {
  // Filter to only note pieces
  const notes = pieces.filter(
    (piece) => piece?.title !== undefined && piece?.content !== undefined,
  );

  // Format each note with HTML comment markers
  const formattedNotes = notes.map((note) => {
    const title = resolveValue(note?.title) || "Untitled Note";
    const rawContent = resolveValue(note?.content) || "";
    const content = stripMentionIds(rawContent);
    const noteId = resolveValue(note?.noteId) || "";
    const notebookNames = getNotebookNamesForNote(note, notebooks);
    const isHidden = resolveBooleanValue((note as any)?.isHidden, note);

    const escapedTitle = title.replace(/"/g, "&quot;");
    const notebooksStr = notebookNames.join(", ");

    return `${NOTE_START_MARKER} title="${escapedTitle}" noteId="${noteId}" notebooks="${notebooksStr}" isHidden="${isHidden}" -->\n\n${content}\n\n${NOTE_END_MARKER}`;
  });

  // Format each notebook
  const formattedNotebooks = notebooks.map((notebook) => {
    const title = getCleanNotebookTitle(notebook);
    const escapedTitle = title.replace(/"/g, "&quot;");

    let isHidden = false;
    if (allPiecesRaw) {
      const notebookName = (notebook as any)?.[NAME];
      for (const piece of allPiecesRaw) {
        if ((piece as any)?.[NAME] === notebookName) {
          isHidden = resolveBooleanValue((piece as any)?.isHidden, piece);
          break;
        }
      }
    } else {
      isHidden = resolveBooleanValue((notebook as any)?.isHidden, notebook);
    }

    const { noteIds, childNotebookTitles } = getNotebookContents(notebook);
    const noteIdsStr = noteIds.join(",");
    const childNotebooksStr = childNotebookTitles
      .map((t) => t.replace(/,/g, "&#44;"))
      .join(",");

    return `${NOTEBOOK_START_MARKER} title="${escapedTitle}" isHidden="${isHidden}" noteIds="${noteIdsStr}" childNotebooks="${childNotebooksStr}" -->\n${NOTEBOOK_END_MARKER}`;
  });

  const timestamp = new Date().toISOString();
  const header =
    `<!-- Common Tools Export - ${timestamp} -->\n<!-- Format: v2 (hierarchical) -->\n<!-- Notes: ${notes.length}, Notebooks: ${notebooks.length} -->\n\n`;

  const notesSection = formattedNotes.length > 0
    ? `<!-- === NOTES === -->\n\n${formattedNotes.join("\n\n")}`
    : "";
  const notebooksSection = formattedNotebooks.length > 0
    ? `\n\n<!-- === NOTEBOOKS === -->\n\n${formattedNotebooks.join("\n\n")}`
    : "";

  const markdown = notes.length === 0 && notebooks.length === 0
    ? "No notes or notebooks found in this space."
    : header + notesSection + notebooksSection;

  return { markdown, count: notes.length, notebookCount: notebooks.length };
}

// ============================================================================
// Import Parsing
// ============================================================================

type ParsedNote = {
  title: string;
  content: string;
  noteId?: string;
  notebooks?: string[];
  isHidden?: boolean;
};

type ParsedNotebook = {
  title: string;
  isHidden: boolean;
  noteIds: string[];
  childNotebookTitles: string[];
};

function parseNotesFromMarkdown(markdown: string): ParsedNote[] {
  if (!markdown || markdown.trim() === "") return [];

  const notes: ParsedNote[] = [];
  const noteBlockRegex =
    /<!-- COMMON_NOTE_START title="([^"]*)"(?:\s+noteId="([^"]*)")?(?:\s+notebooks="([^"]*)")?(?:\s+isHidden="([^"]*)")? -->([\s\S]*?)<!-- COMMON_NOTE_END -->/g;

  let match;
  while ((match = noteBlockRegex.exec(markdown)) !== null) {
    const title = match[1].replace(/&quot;/g, '"') || "Imported Note";
    const noteId = match[2] || undefined;
    const notebooksStr = match[3] || "";
    const isHiddenStr = match[4] || "";
    const content = match[5].trim();

    const notebooks = notebooksStr
      ? notebooksStr.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    const isHidden = isHiddenStr === "true"
      ? true
      : isHiddenStr === "false"
      ? false
      : undefined;

    notes.push({ title, content, noteId, notebooks, isHidden });
  }

  return notes;
}

function parseNotebooksFromMarkdown(markdown: string): ParsedNotebook[] {
  if (!markdown || markdown.trim() === "") return [];

  const notebooks: ParsedNotebook[] = [];
  const notebookBlockRegex =
    /<!-- COMMON_NOTEBOOK_START title="([^"]*)" isHidden="([^"]*)" noteIds="([^"]*)" childNotebooks="([^"]*)" -->/g;

  let match;
  while ((match = notebookBlockRegex.exec(markdown)) !== null) {
    const title = match[1].replace(/&quot;/g, '"') || "Imported Notebook";
    const isHidden = match[2] === "true";
    const noteIdsStr = match[3] || "";
    const childNotebooksStr = match[4] || "";

    const noteIds = noteIdsStr ? noteIdsStr.split(",").filter(Boolean) : [];
    const childNotebookTitles = childNotebooksStr
      ? childNotebooksStr.split(",").map((t) => t.replace(/&#44;/g, ","))
        .filter(Boolean)
      : [];

    notebooks.push({ title, isHidden, noteIds, childNotebookTitles });
  }

  return notebooks;
}

// Topological sort for notebooks (leaves first, parents last)
function topologicalSortNotebooks(notebooks: ParsedNotebook[]): number[] {
  const titleToIndices = new Map<string, number[]>();
  notebooks.forEach((nb, idx) => {
    const indices = titleToIndices.get(nb.title) ?? [];
    indices.push(idx);
    titleToIndices.set(nb.title, indices);
  });

  const visited = new Set<number>();
  const result: number[] = [];

  function visit(idx: number) {
    if (visited.has(idx)) return;
    visited.add(idx);

    const nb = notebooks[idx];
    if (nb) {
      for (const childTitle of nb.childNotebookTitles) {
        const childIndices = titleToIndices.get(childTitle) ?? [];
        for (const childIdx of childIndices) {
          visit(childIdx);
        }
      }
    }
    result.push(idx);
  }

  for (let i = 0; i < notebooks.length; i++) {
    visit(i);
  }

  return result;
}

// ============================================================================
// Import Execution
// ============================================================================

// Exported for tests
export type DetectedDuplicate = {
  title: string;
  noteId?: string;
  existingNotebook: string;
  isNotebook?: boolean;
};

function performImport(
  parsedNotes: ParsedNote[],
  allPieces: Writable<NotePiece[]>,
  notebooks: NotebookPiece[],
  skipTitles: Set<string>,
  skipNotebookTitles: Set<string>,
  rawMarkdown?: string,
  onComplete?: () => void,
) {
  const notebooksList = notebooks;

  // Build set of existing notebook names
  const existingNames = new Set<string>();
  notebooksList.forEach((nb: any) => {
    const cleanName = getCleanNotebookTitle(nb);
    if (cleanName) existingNames.add(cleanName);
  });

  // Parse v2 notebook blocks
  const parsedNotebooks = rawMarkdown
    ? parseNotebooksFromMarkdown(rawMarkdown)
    : [];

  // Build noteId -> notebook titles map
  const noteIdToNotebookTitles = new Map<string, string[]>();
  for (const nb of parsedNotebooks) {
    for (const noteId of nb.noteIds) {
      if (!noteIdToNotebookTitles.has(noteId)) {
        noteIdToNotebookTitles.set(noteId, []);
      }
      noteIdToNotebookTitles.get(noteId)!.push(nb.title);
    }
  }

  // Collect notebook names needed
  const notebooksNeeded = new Set<string>();
  for (const noteData of parsedNotes) {
    if (!skipTitles.has(noteData.title)) {
      noteData.notebooks?.forEach((name) => notebooksNeeded.add(name));
      if (noteData.noteId) {
        const nbTitles = noteIdToNotebookTitles.get(noteData.noteId);
        nbTitles?.forEach((name) => notebooksNeeded.add(name));
      }
    }
  }
  for (const nb of parsedNotebooks) {
    if (!skipNotebookTitles.has(nb.title)) {
      notebooksNeeded.add(nb.title);
    }
  }

  // Phase 1: Create all notes
  const createdNotes: Array<{
    title: string;
    noteId: string;
    index: number;
    contentCell: Writable<string>;
    originalContent: string;
  }> = [];
  const noteIdToPiece = new Map<string, NotePiece>();
  const notesByNotebook = new Map<string, NotePiece[]>();

  const startingIndex = allPieces.get().length;
  let currentIndex = startingIndex;
  const newItems: NotePiece[] = [];

  parsedNotes.forEach((noteData) => {
    if (skipTitles.has(noteData.title)) return;

    const contentCell = Writable.of(noteData.content);
    const noteIdToUse = noteData.noteId || generateId();

    const belongsToNotebook =
      (noteData.notebooks && noteData.notebooks.length > 0) ||
      noteIdToNotebookTitles.has(noteIdToUse);
    const isHidden = noteData.isHidden !== undefined
      ? noteData.isHidden
      : belongsToNotebook;

    const note = Note({
      title: noteData.title,
      content: contentCell,
      noteId: noteIdToUse,
      isHidden,
    });

    newItems.push(note);
    noteIdToPiece.set(noteIdToUse, note);
    createdNotes.push({
      title: noteData.title,
      noteId: noteIdToUse,
      index: currentIndex,
      contentCell,
      originalContent: noteData.content,
    });
    currentIndex++;

    if (noteData.notebooks) {
      for (const notebookName of noteData.notebooks) {
        if (!notesByNotebook.has(notebookName)) {
          notesByNotebook.set(notebookName, []);
        }
        notesByNotebook.get(notebookName)!.push(note);
      }
    }
  });

  // Populate notesByNotebook from v2 format
  for (const nb of parsedNotebooks) {
    if (!notesByNotebook.has(nb.title)) {
      notesByNotebook.set(nb.title, []);
    }
    for (const noteId of nb.noteIds) {
      const piece = noteIdToPiece.get(noteId);
      if (piece) {
        const existing = notesByNotebook.get(nb.title)!;
        if (!existing.includes(piece)) {
          existing.push(piece);
        }
      }
    }
  }

  // Phase 2: Create notebooks in topological order
  const createdNotebookByIndex = new Map<number, NotePiece>();
  const usedTitles = new Set<string>(existingNames);
  const createdNotebooks: Array<
    { originalIndex: number; notebook: NotePiece }
  > = [];

  const getUniqueTitle = (baseTitle: string): string => {
    if (!usedTitles.has(baseTitle)) {
      usedTitles.add(baseTitle);
      return baseTitle;
    }
    let counter = 2;
    while (usedTitles.has(`${baseTitle} (${counter})`)) {
      counter++;
    }
    const uniqueTitle = `${baseTitle} (${counter})`;
    usedTitles.add(uniqueTitle);
    return uniqueTitle;
  };

  if (parsedNotebooks.length > 0) {
    const sortedIndices = topologicalSortNotebooks(parsedNotebooks);

    const titleToChildIndices = new Map<string, number[]>();
    parsedNotebooks.forEach((nb, idx) => {
      const indices = titleToChildIndices.get(nb.title) ?? [];
      indices.push(idx);
      titleToChildIndices.set(nb.title, indices);
    });

    for (const idx of sortedIndices) {
      const nbData = parsedNotebooks[idx];
      if (!nbData) continue;
      if (skipNotebookTitles.has(nbData.title)) continue;

      const actualName = getUniqueTitle(nbData.title);
      const notesForNotebook = notesByNotebook.get(nbData.title) ?? [];

      const childNotebooks: NotePiece[] = [];
      for (const childTitle of nbData.childNotebookTitles) {
        const childIndices = titleToChildIndices.get(childTitle) ?? [];
        for (const childIdx of childIndices) {
          const childPiece = createdNotebookByIndex.get(childIdx);
          if (childPiece) {
            childNotebooks.push(childPiece);
          }
        }
      }

      const allContents = [...notesForNotebook, ...childNotebooks];

      const newNb = Notebook({
        title: actualName,
        notes: allContents,
        isHidden: nbData.isHidden ?? false,
      });

      createdNotebookByIndex.set(idx, newNb);
      createdNotebooks.push({ originalIndex: idx, notebook: newNb });
    }

    createdNotebooks.sort((a, b) => a.originalIndex - b.originalIndex);
    for (const { notebook } of createdNotebooks) {
      newItems.push(notebook);
    }
  } else {
    for (const nbName of notebooksNeeded) {
      if (skipNotebookTitles.has(nbName)) continue;
      const actualName = getUniqueTitle(nbName);
      const notesForNotebook = notesByNotebook.get(nbName) ?? [];
      const newNb = Notebook({
        title: actualName,
        notes: notesForNotebook,
      });
      newItems.push(newNb);
    }
  }

  // Batch push all items
  if (newItems.length > 0) {
    allPieces.set([...allPieces.get(), ...newItems]);
  }

  // Phase 3: Resolve mentions
  const titleToId = new Map<string, string>();
  for (const { title, index } of createdNotes) {
    try {
      const noteCell = allPieces.key(index) as any;
      const resolved = noteCell.resolveAsCell();
      const entityId = resolved?.entityId;
      if (entityId?.["/"] && title) {
        titleToId.set(title.toLowerCase(), entityId["/"]);
      }
    } catch (_e) {
      // Ignore errors
    }
  }

  for (const { originalContent, contentCell } of createdNotes) {
    try {
      const content = originalContent ?? "";
      if (!content) continue;

      const updatedContent = content.replace(
        /\[\[([^\]]+)\]\]/g,
        (match: string, name: string) => {
          if (name.includes("(") && name.endsWith(")")) return match;

          const cleanName = name.trim().replace(/^(📝|📓)\s*/, "")
            .toLowerCase();
          const id = titleToId.get(cleanName);
          if (id) {
            return `[[${name.trim()} (${id})]]`;
          }
          return match;
        },
      );

      if (updatedContent !== content) {
        contentCell.set(updatedContent);
      }
    } catch (_e) {
      // Ignore errors
    }
  }

  onComplete?.();
}

// ============================================================================
// Centralized Import Processing Types & Functions
// ============================================================================

/**
 * Result from analyzing markdown content for import.
 */
type ImportAnalysisResult = {
  parsedNotes: ParsedNote[];
  parsedNotebooks: ParsedNotebook[];
  duplicates: DetectedDuplicate[];
  importSummary: string;
};

/**
 * Context needed for processing import results.
 * Passed from pattern body to allow module-scope function to update state.
 */
type ImportProcessingContext = {
  allPieces: Writable<NotePiece[]>;
  notebooks: NotebookPiece[];
  pendingImportData: Writable<string>;
  detectedDuplicates: Writable<DetectedDuplicate[]>;
  showDuplicateModal: Writable<boolean>;
  showImportModal: Writable<boolean>;
  showPasteSection: Writable<boolean>;
  showImportProgressModal: Writable<boolean>;
  importProgressMessage: Writable<string>;
  importComplete: Writable<boolean>;
};

/**
 * Analyzes markdown content for import, detecting duplicates against existing notes/notebooks.
 * Shared by both paste and file upload import paths.
 */
function analyzeImportContent(
  markdown: string,
  existingNotes: NotePiece[],
  existingNotebooks: NotebookPiece[],
): ImportAnalysisResult | null {
  const parsedNotes = parseNotesFromMarkdown(markdown);
  const parsedNotebooks = parseNotebooksFromMarkdown(markdown);

  if (parsedNotes.length === 0 && parsedNotebooks.length === 0) {
    return null;
  }

  // Check for duplicate notes
  const existingNotesByTitle = new Map<string, NotePiece>();
  existingNotes.forEach((note: NotePiece) => {
    const title = note?.title;
    if (title) existingNotesByTitle.set(title, note);
  });

  const duplicates: DetectedDuplicate[] = [];

  // Detect duplicate notes
  for (const noteData of parsedNotes) {
    if (existingNotesByTitle.has(noteData.title)) {
      duplicates.push({
        title: noteData.title,
        noteId: noteData.noteId,
        existingNotebook: "this space",
        isNotebook: false,
      });
    }
  }

  // Detect duplicate notebooks
  const existingNotebookTitles = new Set<string>();
  existingNotebooks.forEach((nb: NotebookPiece) => {
    const cleanTitle = getCleanNotebookTitle(nb);
    if (cleanTitle) existingNotebookTitles.add(cleanTitle);
  });

  for (const nbData of parsedNotebooks) {
    if (existingNotebookTitles.has(nbData.title)) {
      duplicates.push({
        title: `📓 ${nbData.title}`,
        existingNotebook: "this space",
        isNotebook: true,
      });
    }
  }

  // Build import summary
  const itemCounts: string[] = [];
  if (parsedNotes.length > 0) {
    itemCounts.push(
      `${parsedNotes.length} note${parsedNotes.length !== 1 ? "s" : ""}`,
    );
  }
  if (parsedNotebooks.length > 0) {
    itemCounts.push(
      `${parsedNotebooks.length} notebook${
        parsedNotebooks.length !== 1 ? "s" : ""
      }`,
    );
  }
  const importSummary = itemCounts.join(" and ");

  return { parsedNotes, parsedNotebooks, duplicates, importSummary };
}

/**
 * Process import analysis result - handles both duplicate detection flow
 * and direct import flow. Called by both paste and file upload paths.
 */
function processImportResult(
  markdown: string,
  result: ImportAnalysisResult,
  ctx: ImportProcessingContext,
): void {
  const { parsedNotes, duplicates, importSummary } = result;

  // Close import modal and reset paste section visibility
  ctx.showImportModal.set(false);
  ctx.showPasteSection.set(true);

  if (duplicates.length > 0) {
    // Duplicates detected - show duplicate modal for user decision
    ctx.pendingImportData.set(markdown);
    ctx.detectedDuplicates.set(duplicates);
    ctx.showDuplicateModal.set(true);
  } else {
    // No duplicates - proceed with import directly
    ctx.importComplete.set(false);
    ctx.importProgressMessage.set(`Importing ${importSummary}...`);
    ctx.showImportProgressModal.set(true);

    performImport(
      parsedNotes,
      ctx.allPieces,
      ctx.notebooks,
      new Set(),
      new Set(),
      markdown,
    );

    ctx.importProgressMessage.set(`Imported ${importSummary}!`);
    ctx.importComplete.set(true);
  }
}

/**
 * Execute a pending import after user has made a decision about duplicates.
 * Used by both "Skip Duplicates" and "Import as Copies" flows.
 *
 * @param skipDuplicates - If true, skip items that were detected as duplicates.
 *                         If false, import everything (duplicates become copies).
 * @param ctx - The import context with state and dependencies
 */
function executePendingImport(
  skipDuplicates: boolean,
  ctx: ImportProcessingContext,
): void {
  const markdown = ctx.pendingImportData.get();
  if (!markdown) {
    return;
  }

  const parsedNotes = parseNotesFromMarkdown(markdown);
  const parsedNotebooks = parseNotebooksFromMarkdown(markdown);
  const duplicates = ctx.detectedDuplicates.get();

  // Build skip sets if skipping duplicates
  const skipNoteTitles = new Set<string>();
  const skipNotebookTitles = new Set<string>();

  if (skipDuplicates) {
    for (const d of duplicates) {
      if (d.isNotebook) {
        // Remove the 📓 prefix that was added for display
        skipNotebookTitles.add(d.title.replace(/^📓\s*/, ""));
      } else {
        skipNoteTitles.add(d.title);
      }
    }
  }

  // Calculate import counts for summary
  const noteImportCount = parsedNotes.length -
    (skipDuplicates ? skipNoteTitles.size : 0);
  const notebookImportCount = parsedNotebooks.length -
    (skipDuplicates ? skipNotebookTitles.size : 0);

  const itemCounts: string[] = [];
  if (noteImportCount > 0) {
    itemCounts.push(
      `${noteImportCount} note${noteImportCount !== 1 ? "s" : ""}`,
    );
  }
  if (notebookImportCount > 0) {
    itemCounts.push(
      `${notebookImportCount} notebook${notebookImportCount !== 1 ? "s" : ""}`,
    );
  }
  const importSummary = itemCounts.join(" and ") || "items";

  // Clear duplicate state and show progress
  ctx.pendingImportData.set("");
  ctx.detectedDuplicates.set([]);
  ctx.showDuplicateModal.set(false);
  ctx.importComplete.set(false);
  ctx.importProgressMessage.set(`Importing ${importSummary}...`);
  ctx.showImportProgressModal.set(true);

  // Execute the import
  performImport(
    parsedNotes,
    ctx.allPieces,
    ctx.notebooks,
    skipNoteTitles,
    skipNotebookTitles,
    markdown,
  );

  ctx.importProgressMessage.set(`Imported ${importSummary}!`);
  ctx.importComplete.set(true);
}

// ============================================================================
// PHASE 2: Selection State & Handlers
// ============================================================================

// Handler to toggle note checkbox with shift-click support
const toggleNoteCheckbox = handler<
  { shiftKey?: boolean },
  {
    index: number;
    selectedNoteIndices: Writable<number[]>;
    lastSelectedNoteIndex: Writable<number>;
  }
>((event, { index, selectedNoteIndices, lastSelectedNoteIndex }) => {
  const current = selectedNoteIndices.get();
  const lastIdx = lastSelectedNoteIndex.get();

  if (event?.shiftKey && lastIdx >= 0 && lastIdx !== index) {
    const start = Math.min(lastIdx, index);
    const end = Math.max(lastIdx, index);
    const range: number[] = [];
    for (let i = start; i <= end; i++) {
      range.push(i);
    }
    selectedNoteIndices.set([...new Set([...current, ...range])]);
  } else {
    const idx = current.indexOf(index);
    if (idx >= 0) {
      selectedNoteIndices.set(current.filter((i: number) => i !== index));
    } else {
      selectedNoteIndices.set([...current, index]);
    }
  }
  lastSelectedNoteIndex.set(index);
});

// Handler to toggle notebook checkbox with shift-click support
const toggleNotebookCheckbox = handler<
  { shiftKey?: boolean },
  {
    index: number;
    selectedNotebookIndices: Writable<number[]>;
    lastSelectedNotebookIndex: Writable<number>;
  }
>((event, { index, selectedNotebookIndices, lastSelectedNotebookIndex }) => {
  const current = selectedNotebookIndices.get();
  const lastIdx = lastSelectedNotebookIndex.get();

  if (event?.shiftKey && lastIdx >= 0 && lastIdx !== index) {
    const start = Math.min(lastIdx, index);
    const end = Math.max(lastIdx, index);
    const range: number[] = [];
    for (let i = start; i <= end; i++) {
      range.push(i);
    }
    selectedNotebookIndices.set([...new Set([...current, ...range])]);
  } else {
    const idx = current.indexOf(index);
    if (idx >= 0) {
      selectedNotebookIndices.set(current.filter((i: number) => i !== index));
    } else {
      selectedNotebookIndices.set([...current, index]);
    }
  }
  lastSelectedNotebookIndex.set(index);
});

// Navigate to note
const goToNote = handler<void, { note: Writable<NotePiece> }>(
  (_, { note }) => navigateTo(note),
);

// Navigate to notebook
const goToNotebook = handler<void, { notebook: Writable<NotebookPiece> }>(
  (_, { notebook }) => navigateTo(notebook),
);

// ============================================================================
// PHASE 5-6: Note & Notebook Actions
// ============================================================================

// Toggle individual note visibility
const toggleNoteVisibility = handler<
  void,
  { note: Writable<NotePiece> }
>((_, { note }) => {
  const isHiddenCell = note.key("isHidden");
  const current = isHiddenCell.get() ?? false;
  isHiddenCell.set(!current);
});

// Toggle individual notebook visibility
const toggleNotebookVisibility = handler<
  void,
  { notebook: Writable<NotebookPiece> }
>((_, { notebook }) => {
  const isHiddenCell = notebook.key("isHidden");
  const current = isHiddenCell.get() ?? false;
  isHiddenCell.set(!current);
});

// Helper to generate export filename
const getExportFilename = (prefix: string) => {
  const now = new Date();
  const timestamp = now.toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return `${prefix}-${timestamp}.md`;
};

// ============================================================================
// MAIN PATTERN
// ============================================================================

const NotesImportExport = pattern<Input, Output>(
  ({ title, importMarkdown, allPieces }) => {
    // allPieces is passed directly from default-app for proper cell sharing
    // Used for both reads (filtering) and writes (push new notes/notebooks during import)
    // Note: wish({ scope: ["."] }) is not used here because allPieces is a direct prop,
    // not from the mentionable list. The emoji filtering is reliable for this context.

    // Filter to only notes using 📝 marker in NAME (same pattern as notebooks)
    // Note: Using NAME prefix is more reliable than checking title/content through proxy
    const notes = computed(() =>
      (allPieces?.get() ?? []).filter((piece: any) => {
        const name = piece?.[NAME];
        return typeof name === "string" && name.startsWith("📝");
      })
    );

    // Filter to only notebooks using 📓 marker in NAME
    const notebooks = computed(() =>
      (allPieces?.get() ?? []).filter((piece: any) => isNotebookPiece(piece))
    );

    // Counts
    const noteCount = computed(() => notes.length);
    const notebookCount = computed(() => notebooks.length);
    const _hasNotes = computed(() => notes.length > 0);
    const _hasNotebooks = computed(() => notebooks.length > 0);

    // Selection state for notes
    const selectedNoteIndices = Writable.of<number[]>([]);
    const lastSelectedNoteIndex = Writable.of<number>(-1);
    const selectedNotebook = Writable.of<string>("");
    const selectedMoveNotebook = Writable.of<string>("");

    // Selection state for notebooks
    const selectedNotebookIndices = Writable.of<number[]>([]);
    const lastSelectedNotebookIndex = Writable.of<number>(-1);

    // Selection counts
    const selectedNoteCount = computed(() => selectedNoteIndices.get().length);
    const hasNoteSelection = computed(() =>
      selectedNoteIndices.get().length > 0
    );
    const selectedNotebookCount = computed(() =>
      selectedNotebookIndices.get().length
    );
    const hasNotebookSelection = computed(() =>
      selectedNotebookIndices.get().length > 0
    );

    // New Notebook prompt state (for add/move flows)
    const showNewNotebookPrompt = Writable.of<boolean>(false);
    const newNotebookName = Writable.of<string>("");
    const pendingNotebookAction = Writable.of<"add" | "move" | "">("");

    // Standalone New Notebook modal state
    const showStandaloneNotebookPrompt = Writable.of<boolean>(false);
    const standaloneNotebookTitle = Writable.of<string>("");

    // Delete notebook confirmation modal state
    const showDeleteNotebookModal = Writable.of<boolean>(false);

    // Export state
    const showExportAllModal = Writable.of<boolean>(false);
    const exportedMarkdown = Writable.of<string>("");
    const showExportNotebooksModal = Writable.of<boolean>(false);
    const exportNotebooksMarkdown = Writable.of<string>("");

    // Import state
    const showImportModal = Writable.of<boolean>(false);
    const showDuplicateModal = Writable.of<boolean>(false);
    const detectedDuplicates = Writable.of<DetectedDuplicate[]>([]);
    const pendingImportData = Writable.of<string>("");
    const showImportProgressModal = Writable.of<boolean>(false);
    const importProgressMessage = Writable.of<string>("Importing notes...");
    const importComplete = Writable.of<boolean>(false);
    const showPasteSection = Writable.of<boolean>(true);

    // Computed items for ct-select dropdowns
    const notebookAddItems = computed(() => [
      ...notebooks.map((nb: any, idx: number) => ({
        label: nb?.[NAME] ?? nb?.title ?? "Untitled",
        value: String(idx),
      })),
      { label: "────────────", value: "_divider", disabled: true },
      { label: "New Notebook...", value: "new" },
    ]);

    const notebookMoveItems = computed(() => [
      ...notebooks.map((nb: any, idx: number) => ({
        label: nb?.[NAME] ?? nb?.title ?? "Untitled",
        value: String(idx),
      })),
      { label: "────────────", value: "_divider", disabled: true },
      { label: "New Notebook...", value: "new" },
    ]);

    // Compute filenames for exports
    const notesExportFilename = computed(() =>
      getExportFilename("notes-export")
    );
    const notebooksExportFilename = computed(() =>
      getExportFilename("notebooks-export")
    );

    // Pre-compute note memberships
    const noteMemberships = computed(() => {
      const result: Record<
        string,
        Array<{ name: string; notebook: NotebookPiece }>
      > = {};
      for (const nb of notebooks) {
        const nbNotes = (nb as any)?.notes ?? [];
        const cleanName = getCleanNotebookTitle(nb);
        for (const n of nbNotes) {
          const nId = resolveValue((n as any)?.noteId);
          if (nId) {
            if (!result[nId]) result[nId] = [];
            result[nId].push({ name: cleanName, notebook: nb });
          }
        }
      }
      return result;
    });

    // ========================================================================
    // Actions (converted from handlers - close over pattern variables)
    // ========================================================================

    // Selection actions
    const selectAllNotes = action(() => {
      selectedNoteIndices.set(notes.map((_: any, i: number) => i));
    });

    const deselectAllNotes = action(() => {
      selectedNoteIndices.set([]);
    });

    const selectAllNotebooks = action(() => {
      selectedNotebookIndices.set(notebooks.map((_: any, i: number) => i));
    });

    const deselectAllNotebooks = action(() => {
      selectedNotebookIndices.set([]);
    });

    // Visibility bulk actions
    const toggleAllNotesVisibility = action(() => {
      if (notes.length === 0) return;

      const anyVisible = notes.some((n: any) => !n?.isHidden);
      const newHiddenState = anyVisible;

      // notes is a computed filter of allPieces, so we need to find the actual index in allPieces
      const notesList = notes;
      const allPiecesList = allPieces.get();

      notesList.forEach((note: any) => {
        const noteId = note?.noteId;
        if (!noteId) return;

        const allPiecesIdx = allPiecesList.findIndex((p: any) =>
          p?.noteId === noteId
        );
        if (allPiecesIdx >= 0) {
          allPieces.key(allPiecesIdx).key("isHidden").set(newHiddenState);
        }
      });
    });

    const toggleAllNotebooksVisibility = action(() => {
      if (notebooks.length === 0) return;

      const anyVisible = notebooks.some((nb: any) => !nb?.isHidden);
      const newHiddenState = anyVisible;

      // notebooks is a computed filter of allPieces, find indices in allPieces
      const notebooksList = notebooks;
      const allPiecesList = allPieces.get();

      notebooksList.forEach((nb: any) => {
        const nbName = (nb as any)?.[NAME];
        if (!nbName) return;

        const allPiecesIdx = allPiecesList.findIndex((p: any) =>
          (p as any)?.[NAME] === nbName
        );
        if (allPiecesIdx >= 0) {
          allPieces.key(allPiecesIdx).key("isHidden").set(newHiddenState);
        }
      });
    });

    // CRUD operations
    const createNote = action(() => {
      const note = Note({
        title: "New Note",
        content: "",
        noteId: generateId(),
      });
      allPieces.push(note);
    });

    const _duplicateSelectedNotes = action(() => {
      const selected = selectedNoteIndices.get();
      const notesList = notes;

      for (const idx of selected) {
        const original = notesList[idx];
        if (original) {
          const newNote = Note({
            title: (original.title ?? "Note") + " (Copy)",
            content: original.content ?? "",
            noteId: generateId(),
          });
          allPieces.push(newNote);
        }
      }
      selectedNoteIndices.set([]);
    });

    const deleteSelectedNotes = action(() => {
      const selected = selectedNoteIndices.get();

      const noteIdsToDelete: string[] = [];
      for (const idx of selected) {
        const item = notes[idx];
        const noteId = (item as any)?.noteId;
        if (noteId) noteIdsToDelete.push(noteId);
      }

      const shouldDelete = (n: any) => {
        if (n?.noteId && noteIdsToDelete.includes(n.noteId)) return true;
        return false;
      };

      // Remove from all notebooks
      const notebooksList = notebooks;
      const allPiecesList = allPieces.get();

      notebooksList.forEach((nb: any) => {
        const nbName = (nb as any)?.[NAME];
        if (!nbName) return;

        const nbIdx = allPiecesList.findIndex((p: any) =>
          (p as any)?.[NAME] === nbName
        );
        if (nbIdx < 0) return;

        const nbNotesCell = allPieces.key(nbIdx).key("notes");
        const nbNotes = nbNotesCell.get() ?? [];

        const filtered = nbNotes.filter((n: any) => !shouldDelete(n));
        if (filtered.length !== nbNotes.length) {
          nbNotesCell.set(filtered);
        }
      });

      // Remove from allPieces
      const filteredPieces = allPiecesList.filter((piece: any) =>
        !shouldDelete(piece)
      );
      allPieces.set(filteredPieces);

      selectedNoteIndices.set([]);
    });

    const cloneSelectedNotebooks = action(() => {
      const selected = selectedNotebookIndices.get();

      for (const idx of selected) {
        const original = notebooks[idx];
        if (original) {
          const baseTitle = getCleanNotebookTitle(original);
          const nb = Notebook({
            title: baseTitle + " (Clone)",
            notes: [...((original as any)?.notes ?? [])],
          });
          allPieces.push(nb);
        }
      }
      selectedNotebookIndices.set([]);
    });

    const duplicateSelectedNotebooks = action(() => {
      const selected = selectedNotebookIndices.get();

      for (const idx of selected) {
        const original = notebooks[idx];
        if (original) {
          const newNotes = ((original as any).notes ?? []).map((note: any) =>
            Note({
              title: note.title ?? "Note",
              content: note.content ?? "",
              isHidden: true,
              noteId: generateId(),
            })
          );

          for (const note of newNotes) {
            allPieces.push(note);
          }

          const baseTitle = getCleanNotebookTitle(original);
          const nb = Notebook({
            title: baseTitle + " (Copy)",
            notes: newNotes,
          });
          allPieces.push(nb);
        }
      }
      selectedNotebookIndices.set([]);
    });

    // Notebook operations
    const addToNotebook = action(
      (event: { target?: { value: string }; detail?: { value: string } }) => {
        const value = event.target?.value ?? event.detail?.value ?? "";
        if (!value) return;

        if (value === "new") {
          pendingNotebookAction.set("add");
          showNewNotebookPrompt.set(true);
          selectedNotebook.set("");
          return;
        }

        const nbIndex = parseInt(value, 10);
        if (nbIndex < 0) return;

        const selected = selectedNoteIndices.get();
        const notebooksList = notebooks;
        const allPiecesList = allPieces.get();

        // Find the notebook in allPieces
        const targetNotebook = notebooksList[nbIndex];
        const targetNbName = (targetNotebook as any)?.[NAME];
        if (!targetNbName) return;

        const targetNbIdx = allPiecesList.findIndex((p: any) =>
          (p as any)?.[NAME] === targetNbName
        );
        if (targetNbIdx < 0) return;

        const notebookNotes = allPieces.key(targetNbIdx).key("notes");

        for (const idx of selected) {
          const note = notes[idx];
          if (note) {
            notebookNotes.push(note);

            // Find note in allPieces and set isHidden
            const noteId = (note as any)?.noteId;
            if (noteId) {
              const noteIdx = allPiecesList.findIndex((p: any) =>
                p?.noteId === noteId
              );
              if (noteIdx >= 0) {
                allPieces.key(noteIdx).key("isHidden").set(true);
              }
            }
          }
        }

        selectedNoteIndices.set([]);
        selectedNotebook.set("");
      },
    );

    const moveToNotebook = action(
      (event: { target?: { value: string }; detail?: { value: string } }) => {
        const value = event.target?.value ?? event.detail?.value ?? "";
        if (!value) return;

        if (value === "new") {
          pendingNotebookAction.set("move");
          showNewNotebookPrompt.set(true);
          selectedMoveNotebook.set("");
          return;
        }

        const nbIndex = parseInt(value, 10);
        if (nbIndex < 0) return;

        const selected = selectedNoteIndices.get();
        const notebooksList = notebooks;
        const allPiecesList = allPieces.get();

        // Find target notebook in allPieces
        const targetNotebook = notebooksList[nbIndex];
        const targetNbName = (targetNotebook as any)?.[NAME];
        if (!targetNbName) return;

        const targetNbIdx = allPiecesList.findIndex((p: any) =>
          (p as any)?.[NAME] === targetNbName
        );
        if (targetNbIdx < 0) return;

        const targetNotebookNotes = allPieces.key(targetNbIdx).key("notes");

        const selectedNoteIds: string[] = [];
        const itemsToMove: NotePiece[] = [];

        for (const idx of selected) {
          const item = notes[idx];
          if (!item) continue;

          const noteId = (item as any)?.noteId;
          if (noteId) selectedNoteIds.push(noteId);
          itemsToMove.push(item);

          // Find note in allPieces and set isHidden
          if (noteId) {
            const noteIdx = allPiecesList.findIndex((p: any) =>
              p?.noteId === noteId
            );
            if (noteIdx >= 0) {
              allPieces.key(noteIdx).key("isHidden").set(true);
            }
          }
        }

        const shouldRemove = (n: any) => {
          if (n?.noteId && selectedNoteIds.includes(n.noteId)) return true;
          return false;
        };

        // Remove from all notebooks except target
        notebooksList.forEach((nb: any, localIdx: number) => {
          if (localIdx === nbIndex) return; // Skip target notebook

          const nbName = (nb as any)?.[NAME];
          if (!nbName) return;

          const nbIdx = allPiecesList.findIndex((p: any) =>
            (p as any)?.[NAME] === nbName
          );
          if (nbIdx < 0) return;

          const nbNotesCell = allPieces.key(nbIdx).key("notes");
          const nbNotes = nbNotesCell.get() ?? [];

          const filtered = nbNotes.filter((n: any) => !shouldRemove(n));
          if (filtered.length !== nbNotes.length) {
            nbNotesCell.set(filtered);
          }
        });

        // Add to target
        for (const item of itemsToMove) {
          targetNotebookNotes.push(item);
        }

        selectedNoteIndices.set([]);
        selectedMoveNotebook.set("");
      },
    );

    const confirmDeleteNotebooks = action(() => {
      if (selectedNotebookIndices.get().length > 0) {
        showDeleteNotebookModal.set(true);
      }
    });

    const deleteNotebooksOnly = action(() => {
      const selected = selectedNotebookIndices.get();
      const allPiecesList = allPieces.get();

      if (!selected || selected.length === 0) {
        showDeleteNotebookModal.set(false);
        return;
      }

      // Make contained notes visible
      for (const idx of selected) {
        const nb = notebooks[idx];
        const nbNotes = (nb as any)?.notes ?? [];
        for (const note of nbNotes) {
          const noteId = (note as any)?.noteId;
          if (noteId) {
            for (let i = 0; i < allPiecesList.length; i++) {
              if ((allPiecesList[i] as any)?.noteId === noteId) {
                allPieces.key(i).key("isHidden").set(false);
                break;
              }
            }
          }
        }
      }

      // Find notebook indices in allPieces
      const notebookIndicesInAllPieces: number[] = [];
      for (let i = 0; i < allPiecesList.length; i++) {
        if (isNotebookPiece(allPiecesList[i])) {
          notebookIndicesInAllPieces.push(i);
        }
      }

      // Map selected to allPieces indices
      const allPiecesIndicesToDelete = new Set<number>();
      for (const selectedIdx of selected) {
        const allPiecesIdx = notebookIndicesInAllPieces[selectedIdx];
        if (allPiecesIdx !== undefined) {
          allPiecesIndicesToDelete.add(allPiecesIdx);
        }
      }

      const filteredPieces = allPiecesList.filter((_: any, i: number) =>
        !allPiecesIndicesToDelete.has(i)
      );
      allPieces.set(filteredPieces);

      selectedNotebookIndices.set([]);
      showDeleteNotebookModal.set(false);
    });

    const deleteNotebooksAndNotes = action(() => {
      const selected = selectedNotebookIndices.get();
      const allPiecesList = allPieces.get();

      if (!selected || selected.length === 0) {
        showDeleteNotebookModal.set(false);
        return;
      }

      // Collect noteIds to delete
      const noteIdsToDelete: string[] = [];
      for (const idx of selected) {
        const nb = notebooks[idx];
        const nbNotes = (nb as any)?.notes ?? [];
        for (const note of nbNotes) {
          const noteId = (note as any)?.noteId;
          if (noteId) noteIdsToDelete.push(noteId);
        }
      }

      // Find notebook indices in allPieces
      const notebookIndicesInAllPieces: number[] = [];
      for (let i = 0; i < allPiecesList.length; i++) {
        if (isNotebookPiece(allPiecesList[i])) {
          notebookIndicesInAllPieces.push(i);
        }
      }

      const allPiecesIndicesToDelete = new Set<number>();
      for (const selectedIdx of selected) {
        const allPiecesIdx = notebookIndicesInAllPieces[selectedIdx];
        if (allPiecesIdx !== undefined) {
          allPiecesIndicesToDelete.add(allPiecesIdx);
        }
      }

      const filteredPieces = allPiecesList.filter((piece: any, i: number) => {
        if (allPiecesIndicesToDelete.has(i)) return false;
        const noteId = piece?.noteId;
        if (noteId && noteIdsToDelete.includes(noteId)) return false;
        return true;
      });
      allPieces.set(filteredPieces);

      selectedNotebookIndices.set([]);
      showDeleteNotebookModal.set(false);
    });

    const cancelDeleteNotebooks = action(() => {
      showDeleteNotebookModal.set(false);
    });

    // Standalone notebook modal actions
    const showStandaloneNotebookModal = action(() => {
      showStandaloneNotebookPrompt.set(true);
    });

    const createStandaloneNotebookAndOpen = action(() => {
      const title = standaloneNotebookTitle.get().trim() || "New Notebook";
      const nb = Notebook({ title });
      allPieces.push(nb);
      showStandaloneNotebookPrompt.set(false);
      standaloneNotebookTitle.set("");
      return navigateTo(nb);
    });

    const createStandaloneNotebookAndContinue = action(() => {
      const title = standaloneNotebookTitle.get().trim() || "New Notebook";
      const nb = Notebook({ title });
      allPieces.push(nb);
      standaloneNotebookTitle.set("");
    });

    const cancelStandaloneNotebookPrompt = action(() => {
      showStandaloneNotebookPrompt.set(false);
      standaloneNotebookTitle.set("");
    });

    // New notebook prompt actions
    const createNotebookFromPrompt = action(() => {
      const name = newNotebookName.get().trim() || "New Notebook";
      const actionType = pendingNotebookAction.get();
      const selected = selectedNoteIndices.get();

      const selectedItems: NotePiece[] = [];
      const selectedNoteIds: string[] = [];

      for (const idx of selected) {
        const item = notes[idx];
        if (item) {
          selectedItems.push(item);
          const noteId = (item as any)?.noteId;
          if (noteId) selectedNoteIds.push(noteId);
        }
      }

      const shouldRemove = (n: any) => {
        if (n?.noteId && selectedNoteIds.includes(n.noteId)) return true;
        return false;
      };

      const newNotebook = Notebook({ title: name, notes: selectedItems });
      allPieces.push(newNotebook);

      // Mark selected items as hidden
      const allPiecesList = allPieces.get();
      for (const idx of selected) {
        const note = notes[idx];
        const noteId = (note as any)?.noteId;
        if (noteId) {
          const noteIdx = allPiecesList.findIndex((p: any) =>
            p?.noteId === noteId
          );
          if (noteIdx >= 0) {
            allPieces.key(noteIdx).key("isHidden").set(true);
          }
        }
      }

      // For move: remove from existing notebooks
      if (actionType === "move") {
        const notebooksList = notebooks;
        notebooksList.forEach((nb: any) => {
          const nbName = (nb as any)?.[NAME];
          if (!nbName) return;

          const nbIdx = allPiecesList.findIndex((p: any) =>
            (p as any)?.[NAME] === nbName
          );
          if (nbIdx < 0) return;

          const nbNotesCell = allPieces.key(nbIdx).key("notes");
          const nbNotes = nbNotesCell.get() ?? [];
          const filtered = nbNotes.filter((n: any) => !shouldRemove(n));
          if (filtered.length !== nbNotes.length) {
            nbNotesCell.set(filtered);
          }
        });
      }

      selectedNoteIndices.set([]);
      newNotebookName.set("");
      pendingNotebookAction.set("");
      showNewNotebookPrompt.set(false);
    });

    const cancelNewNotebookPrompt = action(() => {
      showNewNotebookPrompt.set(false);
      newNotebookName.set("");
      pendingNotebookAction.set("");
      selectedNotebook.set("");
      selectedMoveNotebook.set("");
    });

    // Export actions
    const openExportAllModal = action(() => {
      const allPiecesArray = [...allPieces.get()];
      const result = generateExport(
        allPiecesArray,
        [...notebooks],
        allPiecesArray,
      );
      exportedMarkdown.set(result.markdown);
      showExportAllModal.set(true);
    });

    const closeExportAllModal = action(() => {
      showExportAllModal.set(false);
    });

    const exportSelectedNotebooks = action(() => {
      const selected = selectedNotebookIndices.get();

      const allNotes: {
        title: string;
        content: string;
        notebookName: string;
      }[] = [];
      for (const idx of selected) {
        const nb = notebooks[idx];
        const cleanName = getCleanNotebookTitle(nb);
        const nbNotes = (nb as any)?.notes ?? [];
        for (const note of nbNotes) {
          if (note?.title !== undefined && note?.content !== undefined) {
            allNotes.push({
              title: note.title ?? "Untitled",
              content: note.content ?? "",
              notebookName: cleanName,
            });
          }
        }
      }

      if (allNotes.length > 0) {
        const lines = allNotes.map((note) => {
          const escapedTitle = note.title.replace(/"/g, "&quot;");
          return `${NOTE_START_MARKER} title="${escapedTitle}" notebooks="${note.notebookName}" -->\n\n${note.content}\n\n${NOTE_END_MARKER}`;
        });

        const timestamp = new Date().toISOString();
        const header =
          `<!-- Common Tools Export - ${timestamp} -->\n<!-- Notes: ${allNotes.length}, Notebooks: ${selected.length} -->\n\n`;

        exportNotebooksMarkdown.set(header + lines.join("\n\n"));
      } else {
        exportNotebooksMarkdown.set(
          "<!-- No notes found in selected notebooks -->",
        );
      }
      showExportNotebooksModal.set(true);
    });

    const closeExportNotebooksModal = action(() => {
      showExportNotebooksModal.set(false);
      exportNotebooksMarkdown.set("");
      selectedNotebookIndices.set([]);
    });

    // Import actions
    const openImportModal = action(() => {
      showImportModal.set(true);
    });

    const closeImportModal = action(() => {
      showImportModal.set(false);
      showPasteSection.set(true);
    });

    const _hidePasteSection = action(() => {
      showPasteSection.set(false);
    });

    // ========================================================================
    // Import Actions - use centralized helpers at module scope
    // ========================================================================

    const analyzeImport = action(() => {
      const markdown = importMarkdown;
      const result = analyzeImportContent(markdown, [...notes], [...notebooks]);
      if (!result) return;
      processImportResult(markdown, result, {
        allPieces,
        notebooks: [...notebooks],
        pendingImportData,
        detectedDuplicates,
        showDuplicateModal,
        showImportModal,
        showPasteSection,
        showImportProgressModal,
        importProgressMessage,
        importComplete,
      });
    });

    const handleImportFileUpload = action(
      (event: { detail: { files: Array<{ url: string; name: string }> } }) => {
        const files = event.detail?.files ?? [];
        if (files.length === 0) return;

        const dataUrl = files[0].url;
        const base64Part = dataUrl.split(",")[1];
        if (!base64Part) return;

        const binaryString = atob(base64Part);
        const bytes = Uint8Array.from(
          binaryString,
          (char) => char.charCodeAt(0),
        );
        const content = new TextDecoder().decode(bytes);

        const result = analyzeImportContent(content, [...notes], [
          ...notebooks,
        ]);
        if (!result) return;
        processImportResult(content, result, {
          allPieces,
          notebooks: [...notebooks],
          pendingImportData,
          detectedDuplicates,
          showDuplicateModal,
          showImportModal,
          showPasteSection,
          showImportProgressModal,
          importProgressMessage,
          importComplete,
        });
      },
    );

    const importSkipDuplicates = action(() => {
      executePendingImport(true, {
        allPieces,
        notebooks: [...notebooks],
        pendingImportData,
        detectedDuplicates,
        showDuplicateModal,
        showImportModal,
        showPasteSection,
        showImportProgressModal,
        importProgressMessage,
        importComplete,
      });
    });

    const importAllAsCopies = action(() => {
      executePendingImport(false, {
        allPieces,
        notebooks: [...notebooks],
        pendingImportData,
        detectedDuplicates,
        showDuplicateModal,
        showImportModal,
        showPasteSection,
        showImportProgressModal,
        importProgressMessage,
        importComplete,
      });
    });

    const cancelImport = action(() => {
      showDuplicateModal.set(false);
      detectedDuplicates.set([]);
      pendingImportData.set("");
    });

    // Action: duplicate selected notes
    const doDuplicateSelectedNotes = action(() => {
      const selected = selectedNoteIndices.get();
      const notesList = notes;

      for (const idx of selected) {
        const original = notesList[idx];
        if (original) {
          const newNote = Note({
            title: ((original as any).title ?? "Note") + " (Copy)",
            content: (original as any).content ?? "",
            noteId: generateId(),
          });
          allPieces.push(newNote);
        }
      }
      selectedNoteIndices.set([]);
    });

    return {
      [NAME]: computed(() =>
        `All Notes (${noteCount} notes, ${notebookCount} notebooks)`
      ),
      [UI]: (
        <ct-screen>
          {/* Header Toolbar */}
          <ct-hstack
            slot="header"
            gap="2"
            padding="4"
            style={{ justifyContent: "space-between" }}
          >
            <span style={{ fontSize: "18px", fontWeight: "600" }}>
              {title}
            </span>
            <ct-hstack gap="2">
              <ct-button
                variant="ghost"
                onClick={openImportModal}
              >
                Import
              </ct-button>
              <ct-button
                variant="ghost"
                onClick={openExportAllModal}
              >
                Export All
              </ct-button>
            </ct-hstack>
          </ct-hstack>

          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            <ct-vstack gap="4" padding="6">
              {/* Notes Section - always visible */}
              <ct-card>
                <ct-vstack gap="4">
                  {/* Notes Header */}
                  <ct-hstack
                    style={{
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <span style={{ fontSize: "15px", fontWeight: "600" }}>
                      📝 Notes ({noteCount})
                    </span>
                    <ct-button
                      size="sm"
                      variant="ghost"
                      onClick={createNote}
                    >
                      + New Note
                    </ct-button>
                  </ct-hstack>

                  {/* Notes Table */}
                  <ct-table full-width hover>
                    <thead>
                      <tr>
                        <th style={{ width: "32px", padding: "0 4px" }} />
                        <th style={{ textAlign: "left" }}>Title</th>
                        <th style={{ textAlign: "left" }}>Notebooks</th>
                        <th
                          style={{
                            width: "80px",
                            textAlign: "center",
                            cursor: "pointer",
                          }}
                          onClick={toggleAllNotesVisibility}
                        >
                          Visible
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {notes.map((note, index) => (
                        <tr
                          style={{
                            background: computed(() =>
                              selectedNoteIndices.get().includes(index)
                                ? "var(--ct-color-bg-secondary, #f5f5f7)"
                                : "transparent"
                            ),
                          }}
                        >
                          <td
                            style={{
                              width: "32px",
                              padding: "0 4px",
                              verticalAlign: "middle",
                            }}
                          >
                            <div
                              style={{ cursor: "pointer", userSelect: "none" }}
                              onClick={toggleNoteCheckbox({
                                index,
                                selectedNoteIndices,
                                lastSelectedNoteIndex,
                              })}
                            >
                              <ct-checkbox
                                checked={computed(() =>
                                  selectedNoteIndices.get().includes(index)
                                )}
                              />
                            </div>
                          </td>
                          <td style={{ verticalAlign: "middle" }}>
                            <div
                              style={{ cursor: "pointer" }}
                              onClick={goToNote({ note })}
                            >
                              <ct-chip
                                label={computed(() =>
                                  note?.[NAME] ?? note?.title ?? "Untitled"
                                )}
                                interactive
                              />
                            </div>
                          </td>
                          <td style={{ verticalAlign: "middle" }}>
                            <ct-hstack gap="1">
                              {computed(() => {
                                const noteId = resolveValue(
                                  (note as any)?.noteId,
                                );
                                const memberships = noteId
                                  ? (noteMemberships[noteId] ?? [])
                                  : [];
                                // Use Array.from to avoid CTS transformer's mapWithPattern issue
                                return Array.from(memberships).map((
                                  { name, notebook },
                                ) => (
                                  <ct-chip
                                    label={name}
                                    interactive
                                    onClick={goToNotebook({ notebook })}
                                  />
                                ));
                              })}
                            </ct-hstack>
                          </td>
                          <td
                            style={{
                              width: "80px",
                              textAlign: "center",
                              verticalAlign: "middle",
                            }}
                          >
                            <ct-switch
                              checked={computed(() => !(note as any)?.isHidden)}
                              onct-change={toggleNoteVisibility({ note })}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </ct-table>

                  {/* Select All footer */}
                  <div
                    style={{
                      display: computed(() =>
                        notes.length > 1 ? "flex" : "none"
                      ),
                      alignItems: "center",
                      padding: "4px 0",
                      fontSize: "13px",
                      color: "var(--ct-color-text-secondary, #6e6e73)",
                    }}
                  >
                    <div style={{ width: "32px", padding: "0 4px" }}>
                      <ct-checkbox
                        checked={computed(() => notes.length > 0 &&
                          selectedNoteIndices.get().length === notes.length
                        )}
                        onct-change={computed(() =>
                          selectedNoteIndices.get().length === notes.length
                            ? deselectAllNotes
                            : selectAllNotes
                        )}
                      />
                    </div>
                    <span style={{ paddingLeft: "4px" }}>Select All</span>
                  </div>

                  {/* Notes Action Bar */}
                  <ct-hstack
                    padding="3"
                    gap="3"
                    style={{
                      display: computed(() =>
                        hasNoteSelection ? "flex" : "none"
                      ),
                      background: "var(--ct-color-bg-secondary, #f5f5f7)",
                      borderRadius: "8px",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: "13px", fontWeight: "500" }}>
                      {selectedNoteCount} selected
                    </span>
                    <span style={{ flex: 1 }} />
                    <ct-select
                      $value={selectedNotebook}
                      items={notebookAddItems}
                      placeholder="Add to..."
                      style={{ width: "140px" }}
                      onChange={addToNotebook}
                    />
                    <ct-select
                      $value={selectedMoveNotebook}
                      items={notebookMoveItems}
                      placeholder="Move to..."
                      style={{ width: "140px" }}
                      onChange={moveToNotebook}
                    />
                    <ct-button
                      size="sm"
                      variant="ghost"
                      onClick={doDuplicateSelectedNotes}
                    >
                      Duplicate
                    </ct-button>
                    <ct-button
                      size="sm"
                      variant="ghost"
                      onClick={deleteSelectedNotes}
                      style={{ color: "var(--ct-color-danger, #dc3545)" }}
                    >
                      Delete
                    </ct-button>
                  </ct-hstack>
                </ct-vstack>
              </ct-card>

              {/* Notebooks Section - always visible */}
              <ct-card>
                <ct-vstack gap="4">
                  {/* Notebooks Header */}
                  <ct-hstack
                    style={{
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <span style={{ fontSize: "15px", fontWeight: "600" }}>
                      📓 Notebooks ({notebookCount})
                    </span>
                    <ct-button
                      size="sm"
                      variant="ghost"
                      onClick={showStandaloneNotebookModal}
                    >
                      + New Notebook
                    </ct-button>
                  </ct-hstack>

                  {/* Notebooks Table */}
                  <ct-table full-width hover>
                    <thead>
                      <tr>
                        <th style={{ width: "32px", padding: "0 4px" }} />
                        <th style={{ textAlign: "left" }}>Title</th>
                        <th
                          style={{
                            width: "80px",
                            textAlign: "center",
                            cursor: "pointer",
                          }}
                          onClick={toggleAllNotebooksVisibility}
                        >
                          Visible
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {notebooks.map((notebook, index) => (
                        <tr
                          style={{
                            background: computed(() =>
                              selectedNotebookIndices.get().includes(index)
                                ? "var(--ct-color-bg-secondary, #f5f5f7)"
                                : "transparent"
                            ),
                          }}
                        >
                          <td
                            style={{
                              width: "32px",
                              padding: "0 4px",
                              verticalAlign: "middle",
                            }}
                          >
                            <div
                              style={{ cursor: "pointer", userSelect: "none" }}
                              onClick={toggleNotebookCheckbox({
                                index,
                                selectedNotebookIndices,
                                lastSelectedNotebookIndex,
                              })}
                            >
                              <ct-checkbox
                                checked={computed(() =>
                                  selectedNotebookIndices.get().includes(index)
                                )}
                              />
                            </div>
                          </td>
                          <td style={{ verticalAlign: "middle" }}>
                            <div
                              style={{ cursor: "pointer" }}
                              onClick={goToNotebook({ notebook })}
                            >
                              <ct-chip
                                label={computed(() =>
                                  notebook?.[NAME] ?? notebook?.title ??
                                    "Untitled"
                                )}
                                interactive
                              />
                            </div>
                          </td>
                          <td
                            style={{
                              width: "80px",
                              textAlign: "center",
                              verticalAlign: "middle",
                            }}
                          >
                            <ct-switch
                              checked={computed(() =>
                                !(notebook as any)?.isHidden
                              )}
                              onct-change={toggleNotebookVisibility({
                                notebook,
                              })}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </ct-table>

                  {/* Select All footer */}
                  <div
                    style={{
                      display: computed(() =>
                        notebooks.length > 1 ? "flex" : "none"
                      ),
                      alignItems: "center",
                      padding: "4px 0",
                      fontSize: "13px",
                      color: "var(--ct-color-text-secondary, #6e6e73)",
                    }}
                  >
                    <div style={{ width: "32px", padding: "0 4px" }}>
                      <ct-checkbox
                        checked={computed(() => notebooks.length > 0 &&
                          selectedNotebookIndices.get().length ===
                            notebooks.length
                        )}
                        onct-change={computed(() =>
                          selectedNotebookIndices.get().length ===
                              notebooks.length
                            ? deselectAllNotebooks
                            : selectAllNotebooks
                        )}
                      />
                    </div>
                    <span style={{ paddingLeft: "4px" }}>Select All</span>
                  </div>

                  {/* Notebooks Action Bar */}
                  <ct-hstack
                    padding="3"
                    gap="3"
                    style={{
                      display: computed(() =>
                        hasNotebookSelection ? "flex" : "none"
                      ),
                      background: "var(--ct-color-bg-secondary, #f5f5f7)",
                      borderRadius: "8px",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: "13px", fontWeight: "500" }}>
                      {selectedNotebookCount} selected
                    </span>
                    <span style={{ flex: 1 }} />
                    <ct-button
                      size="sm"
                      variant="ghost"
                      onClick={exportSelectedNotebooks}
                    >
                      Export
                    </ct-button>
                    <ct-button
                      size="sm"
                      variant="ghost"
                      onClick={cloneSelectedNotebooks}
                    >
                      Clone
                    </ct-button>
                    <ct-button
                      size="sm"
                      variant="ghost"
                      onClick={duplicateSelectedNotebooks}
                    >
                      Duplicate
                    </ct-button>
                    <ct-button
                      size="sm"
                      variant="ghost"
                      onClick={confirmDeleteNotebooks}
                      style={{ color: "var(--ct-color-danger, #dc3545)" }}
                    >
                      Delete
                    </ct-button>
                  </ct-hstack>
                </ct-vstack>
              </ct-card>
            </ct-vstack>
          </div>

          {/* Export All Modal */}
          <ct-modal
            $open={showExportAllModal}
            dismissable
            size="lg"
            label="Export All"
          >
            <span slot="header">Export All Notes & Notebooks</span>
            <ct-vstack gap="4">
              <span
                style={{
                  fontSize: "13px",
                  color: "var(--ct-color-text-secondary)",
                }}
              >
                {noteCount} notes, {notebookCount} notebooks
              </span>
              <ct-code-editor
                value={exportedMarkdown}
                language="text/markdown"
                readonly
                style={{ height: "300px" }}
              />
            </ct-vstack>
            <ct-hstack
              slot="footer"
              gap="2"
              style={{ justifyContent: "flex-end" }}
            >
              <ct-button
                variant="ghost"
                onClick={closeExportAllModal}
              >
                Cancel
              </ct-button>
              <ct-copy-button
                text={exportedMarkdown}
                variant="ghost"
              >
                Copy
              </ct-copy-button>
              <ct-file-download
                $data={exportedMarkdown}
                filename={notesExportFilename}
                mimeType="text/markdown"
                variant="primary"
              >
                Save
              </ct-file-download>
            </ct-hstack>
          </ct-modal>

          {/* Export Notebooks Modal */}
          <ct-modal
            $open={showExportNotebooksModal}
            dismissable
            size="lg"
            label="Export Notebooks"
          >
            <span slot="header">Export Selected Notebooks</span>
            <ct-vstack gap="4">
              <ct-code-editor
                value={exportNotebooksMarkdown}
                language="text/markdown"
                readonly
                style={{ height: "300px" }}
              />
            </ct-vstack>
            <ct-hstack
              slot="footer"
              gap="2"
              style={{ justifyContent: "flex-end" }}
            >
              <ct-button
                variant="ghost"
                onClick={closeExportNotebooksModal}
              >
                Cancel
              </ct-button>
              <ct-copy-button
                text={exportNotebooksMarkdown}
                variant="ghost"
              >
                Copy
              </ct-copy-button>
              <ct-file-download
                $data={exportNotebooksMarkdown}
                filename={notebooksExportFilename}
                mimeType="text/markdown"
                variant="primary"
              >
                Save
              </ct-file-download>
            </ct-hstack>
          </ct-modal>

          {/* Import Modal */}
          <ct-modal
            $open={showImportModal}
            dismissable
            size="lg"
            label="Import"
          >
            <span slot="header">Import Notes & Notebooks</span>
            <ct-vstack gap="4">
              <ct-file-input
                accept=".md,.txt,.markdown"
                buttonText="Upload File"
                showPreview={false}
                onct-change={handleImportFileUpload}
              />
              <ct-vstack
                gap="2"
                style={{
                  display: computed(() =>
                    showPasteSection.get() ? "flex" : "none"
                  ),
                }}
              >
                <span
                  style={{
                    fontSize: "13px",
                    color: "var(--ct-color-text-secondary)",
                  }}
                >
                  Or paste exported markdown:
                </span>
                <ct-code-editor
                  $value={importMarkdown}
                  language="text/markdown"
                  style={{ height: "200px" }}
                />
              </ct-vstack>
            </ct-vstack>
            <ct-hstack
              slot="footer"
              gap="2"
              style={{ justifyContent: "flex-end" }}
            >
              <ct-button
                variant="ghost"
                onClick={closeImportModal}
              >
                Cancel
              </ct-button>
              <ct-button
                variant="primary"
                onClick={analyzeImport}
              >
                Import
              </ct-button>
            </ct-hstack>
          </ct-modal>

          {/* Duplicate Detection Modal */}
          <ct-modal
            $open={showDuplicateModal}
            dismissable
            size="md"
            label="Duplicates Found"
          >
            <span slot="header">Duplicates Found</span>
            <ct-vstack gap="4">
              <span style={{ fontSize: "13px" }}>
                The following notes already exist in this space:
              </span>
              <ct-vstack gap="1">
                {detectedDuplicates.map((dup) => (
                  <span
                    style={{
                      fontSize: "13px",
                      color: "var(--ct-color-text-secondary)",
                    }}
                  >
                    • {dup.title}
                  </span>
                ))}
              </ct-vstack>
            </ct-vstack>
            <ct-hstack
              slot="footer"
              gap="2"
              style={{ justifyContent: "flex-end" }}
            >
              <ct-button
                variant="ghost"
                onClick={cancelImport}
              >
                Cancel
              </ct-button>
              <ct-button
                variant="ghost"
                onClick={importSkipDuplicates}
              >
                Skip Duplicates
              </ct-button>
              <ct-button
                variant="primary"
                onClick={importAllAsCopies}
              >
                Import as Copies
              </ct-button>
            </ct-hstack>
          </ct-modal>

          {/* Import Progress Modal */}
          <ct-modal $open={showImportProgressModal} size="sm" label="Importing">
            <span slot="header">Import Progress</span>
            <ct-vstack gap="4" align="center">
              <ct-progress
                indeterminate
                style={{
                  display: computed(() =>
                    importComplete.get() ? "none" : "block"
                  ),
                }}
              />
              <span style={{ fontSize: "14px" }}>{importProgressMessage}</span>
            </ct-vstack>
            <ct-hstack
              slot="footer"
              gap="2"
              style={{
                justifyContent: "flex-end",
                display: computed(() => importComplete.get() ? "flex" : "none"),
              }}
            >
              <ct-button
                variant="primary"
                onClick={() => showImportProgressModal.set(false)}
              >
                Done
              </ct-button>
            </ct-hstack>
          </ct-modal>

          {/* New Notebook Modal (for add/move flows) */}
          <ct-modal
            $open={showNewNotebookPrompt}
            dismissable
            size="sm"
            label="New Notebook"
          >
            <span slot="header">New Notebook</span>
            <ct-input
              $value={newNotebookName}
              placeholder="Enter notebook name..."
            />
            <ct-hstack
              slot="footer"
              gap="2"
              style={{ justifyContent: "flex-end" }}
            >
              <ct-button
                variant="ghost"
                onClick={cancelNewNotebookPrompt}
              >
                Cancel
              </ct-button>
              <ct-button
                variant="primary"
                onClick={createNotebookFromPrompt}
              >
                Create
              </ct-button>
            </ct-hstack>
          </ct-modal>

          {/* Standalone New Notebook Modal */}
          <ct-modal
            $open={showStandaloneNotebookPrompt}
            dismissable
            size="sm"
            label="New Notebook"
          >
            <span slot="header">New Notebook</span>
            <ct-input
              $value={standaloneNotebookTitle}
              placeholder="Enter notebook name..."
            />
            <ct-hstack
              slot="footer"
              gap="2"
              style={{ justifyContent: "flex-end" }}
            >
              <ct-button
                variant="ghost"
                onClick={cancelStandaloneNotebookPrompt}
              >
                Cancel
              </ct-button>
              <ct-button
                variant="ghost"
                onClick={createStandaloneNotebookAndContinue}
              >
                Create Another
              </ct-button>
              <ct-button
                variant="primary"
                onClick={createStandaloneNotebookAndOpen}
              >
                Create
              </ct-button>
            </ct-hstack>
          </ct-modal>

          {/* Delete Notebook Confirmation Modal */}
          <ct-modal
            $open={showDeleteNotebookModal}
            dismissable
            size="md"
            label="Delete Notebooks"
          >
            <span slot="header">Delete Notebooks</span>
            <ct-vstack gap="4">
              <span style={{ fontSize: "14px" }}>
                What would you like to do with the notes in the selected
                notebooks?
              </span>
            </ct-vstack>
            <ct-hstack
              slot="footer"
              gap="2"
              style={{ justifyContent: "flex-end" }}
            >
              <ct-button
                variant="ghost"
                onClick={cancelDeleteNotebooks}
              >
                Cancel
              </ct-button>
              <ct-button
                variant="ghost"
                onClick={deleteNotebooksOnly}
              >
                Keep Notes
              </ct-button>
              <ct-button
                variant="primary"
                onClick={deleteNotebooksAndNotes}
                style={{ background: "var(--ct-color-danger, #dc3545)" }}
              >
                Delete All
              </ct-button>
            </ct-hstack>
          </ct-modal>
        </ct-screen>
      ),
      title,
      exportedMarkdown,
      importMarkdown,
      noteCount,
      notebookCount,
      mentionable: notes,

      // Observable state for testing
      notes,
      notebooks,
      detectedDuplicates: computed(() => detectedDuplicates.get()),
      showDuplicateModal: computed(() => showDuplicateModal.get()),
      showImportModal: computed(() => showImportModal.get()),
      showImportProgressModal: computed(() => showImportProgressModal.get()),
      importComplete: computed(() => importComplete.get()),
      selectedNoteIndices: computed(() => selectedNoteIndices.get()),
      selectedNotebookIndices: computed(() => selectedNotebookIndices.get()),

      // Actions for testing
      analyzeImport,
      openImportModal,
      closeImportModal,
      importSkipDuplicates,
      importAllAsCopies,
      cancelImport,
      createNote,
      selectAllNotes,
      deselectAllNotes,
      selectAllNotebooks,
      deselectAllNotebooks,
      openExportAllModal,
      closeExportAllModal,
    };
  },
);

export default NotesImportExport;
