/// <cts-enable />
import {
  Cell,
  computed,
  type Default,
  handler,
  lift,
  NAME,
  navigateTo,
  pattern,
  UI,
  wish,
} from "commontools";

import Note from "./note.tsx";

// Simple random ID generator (crypto.randomUUID not available in pattern env)
const generateId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
import Notebook from "./notebook.tsx";

// Types for notes in the space
type NoteCharm = {
  [NAME]?: string;
  title?: string;
  content?: string;
  isHidden?: boolean;
  noteId?: string;
};

type NotebookCharm = {
  [NAME]?: string;
  title?: string;
  notes?: NoteCharm[];
};

type AllCharmsType = NoteCharm[];

interface Input {
  importMarkdown: Default<string, "">;
}

interface Output {
  exportedMarkdown: string;
  importMarkdown: string;
  noteCount: number;
}

// HTML comment markers for bulletproof note delimiting
const NOTE_START_MARKER = "<!-- COMMON_NOTE_START";
const NOTE_END_MARKER = "<!-- COMMON_NOTE_END -->";

// HTML comment markers for notebook blocks (for hierarchical export/import)
const NOTEBOOK_START_MARKER = "<!-- COMMON_NOTEBOOK_START";
const NOTEBOOK_END_MARKER = "<!-- COMMON_NOTEBOOK_END -->";

// Helper to resolve proxy value to primitive string (for export function)
function resolveValue(value: unknown): string {
  try {
    return JSON.parse(JSON.stringify(value)) as string;
  } catch {
    return String(value ?? "");
  }
}

// Helper to resolve proxy value to boolean (for isHidden export)
// Tries multiple approaches since OpaqueRef serialization can be tricky
function resolveBooleanValue(value: unknown, parentObj?: unknown): boolean {
  // First try: serialize the property directly
  try {
    const resolved = JSON.parse(JSON.stringify(value));
    if (resolved === true || resolved === "true") return true;
  } catch {
    // ignore
  }

  // Second try: if we have the parent object, serialize it and extract the property
  if (parentObj) {
    try {
      const serialized = JSON.parse(JSON.stringify(parentObj));
      if (serialized?.isHidden === true) return true;
    } catch {
      // ignore
    }
  }

  // Fallback: check string representation
  return String(value) === "true";
}

// Helper to get notebook names that contain a note (by noteId)
function getNotebookNamesForNote(
  note: NoteCharm,
  notebooks: NotebookCharm[],
): string[] {
  // Use JSON.parse(JSON.stringify()) to fully resolve proxy values
  const noteId = resolveValue(note?.noteId);
  if (!noteId) return [];

  const names: string[] = [];
  for (const nb of notebooks) {
    const nbNotes = nb?.notes ?? [];
    for (const n of nbNotes) {
      // Compare resolved string values
      if (resolveValue(n?.noteId) === noteId) {
        // Strip emoji prefix and count suffix from notebook name
        const rawName = (nb as any)?.[NAME] ?? "";
        const cleanName = rawName
          .replace(/^📓\s*/, "")
          .replace(/\s*\(\d+\)$/, "");
        if (cleanName) names.push(cleanName);
        break;
      }
    }
  }
  return names;
}

// Strip entity IDs from mentions: [[Name (id)]] → [[Name]]
// This makes exports portable across spaces (IDs are space-specific)
function stripMentionIds(content: string): string {
  return content.replace(/\[\[([^\]]*?)\s*\([^)]+\)\]\]/g, "[[$1]]");
}

// Helper to check if a charm is a notebook (by NAME prefix)
function isNotebookCharm(charm: unknown): boolean {
  const name = (charm as any)?.[NAME];
  return typeof name === "string" && name.startsWith("📓");
}

// Helper to get clean notebook title (strip emoji and count)
function getCleanNotebookTitle(notebook: unknown): string {
  const rawName = (notebook as any)?.[NAME] ?? (notebook as any)?.title ?? "";
  return rawName.replace(/^📓\s*/, "").replace(/\s*\(\d+\)$/, "");
}

// Helper to get noteIds and child notebook titles from a notebook's contents
function getNotebookContents(
  notebook: NotebookCharm,
): { noteIds: string[]; childNotebookTitles: string[] } {
  const notes = (notebook as any)?.notes ?? [];
  const noteIds: string[] = [];
  const childNotebookTitles: string[] = [];

  for (const item of notes) {
    if (isNotebookCharm(item)) {
      // It's a nested notebook
      const title = getCleanNotebookTitle(item);
      if (title) childNotebookTitles.push(title);
    } else {
      // It's a note - get its noteId
      const noteId = resolveValue((item as any)?.noteId);
      if (noteId) noteIds.push(noteId);
    }
  }

  return { noteIds, childNotebookTitles };
}

// Plain function version for imperative use in handlers (lift() doesn't work in handlers)
// Now includes hierarchical notebook export (v2 format)
// allCharmsRaw is the raw allCharms array for looking up isHidden values
function filterAndFormatNotesPlain(
  charms: NoteCharm[],
  notebooks: NotebookCharm[],
  allCharmsRaw?: unknown[],
): { markdown: string; count: number; notebookCount: number } {
  // Filter to only note charms (have title and content properties)
  const notes = charms.filter(
    (charm) => charm?.title !== undefined && charm?.content !== undefined,
  );

  // Format each note with HTML comment block markers (including noteId, notebooks, and isHidden)
  const formattedNotes = notes.map((note) => {
    const title = resolveValue(note?.title) || "Untitled Note";
    const rawContent = resolveValue(note?.content) || "";
    // Strip mention IDs for portable export
    const content = stripMentionIds(rawContent);
    const noteId = resolveValue(note?.noteId) || "";
    const notebookNames = getNotebookNamesForNote(note, notebooks);
    // Resolve Cell/OpaqueRef to get actual boolean value (pass parent for fallback serialization)
    const isHidden = resolveBooleanValue((note as any)?.isHidden, note);

    // Escape quotes in title for the attribute
    const escapedTitle = title.replace(/"/g, "&quot;");
    const notebooksStr = notebookNames.join(", ");

    return `${NOTE_START_MARKER} title="${escapedTitle}" noteId="${noteId}" notebooks="${notebooksStr}" isHidden="${isHidden}" -->\n\n${content}\n\n${NOTE_END_MARKER}`;
  });

  // Format each notebook with hierarchy info
  const formattedNotebooks = notebooks.map((notebook) => {
    const title = getCleanNotebookTitle(notebook);
    const escapedTitle = title.replace(/"/g, "&quot;");

    // Look up isHidden from allCharmsRaw by matching NAME (more reliable than direct property access)
    let isHidden = false;
    if (allCharmsRaw) {
      const notebookName = (notebook as any)?.[NAME];
      for (const charm of allCharmsRaw) {
        const charmName = (charm as any)?.[NAME];
        if (charmName === notebookName) {
          // Found the matching charm - try to get isHidden
          isHidden = resolveBooleanValue((charm as any)?.isHidden, charm);
          break;
        }
      }
    } else {
      // Fallback to direct property access
      isHidden = resolveBooleanValue((notebook as any)?.isHidden, notebook);
    }

    const { noteIds, childNotebookTitles } = getNotebookContents(notebook);

    // Escape commas in child notebook titles and join
    const noteIdsStr = noteIds.join(",");
    const childNotebooksStr = childNotebookTitles
      .map((t) => t.replace(/,/g, "&#44;"))
      .join(",");

    return `${NOTEBOOK_START_MARKER} title="${escapedTitle}" isHidden="${isHidden}" noteIds="${noteIdsStr}" childNotebooks="${childNotebooksStr}" -->\n${NOTEBOOK_END_MARKER}`;
  });

  // Add timestamp header with format version
  const timestamp = new Date().toISOString();
  const header =
    `<!-- Common Tools Export - ${timestamp} -->\n<!-- Format: v2 (hierarchical) -->\n<!-- Notes: ${notes.length}, Notebooks: ${notebooks.length} -->\n\n`;

  // Combine notes and notebooks sections
  const notesSection = formattedNotes.length > 0
    ? `<!-- === NOTES === -->\n\n${formattedNotes.join("\n\n")}`
    : "";
  const notebooksSection = formattedNotebooks.length > 0
    ? `\n\n<!-- === NOTEBOOKS === -->\n\n${formattedNotebooks.join("\n\n")}`
    : "";

  const markdown = notes.length === 0 && notebooks.length === 0
    ? "No notes or notebooks found in this space."
    : header + notesSection + notebooksSection;

  return {
    markdown,
    count: notes.length,
    notebookCount: notebooks.length,
  };
}

// Filter charms to only include notes and format as markdown with HTML comment blocks
// Takes a combined input object since lift() only accepts one argument
// Currently unused - kept for potential future use
const _filterAndFormatNotes = lift(
  (input: {
    charms: NoteCharm[];
    notebooks: NotebookCharm[];
  }): { notes: NoteCharm[]; markdown: string; count: number } => {
    const { charms, notebooks } = input;

    // Filter to only note charms (have title and content properties)
    const notes = charms.filter(
      (charm) => charm?.title !== undefined && charm?.content !== undefined,
    );

    if (notes.length === 0) {
      return { notes: [], markdown: "No notes found in this space.", count: 0 };
    }

    // Format each note with HTML comment block markers (including noteId and notebooks)
    const formatted = notes.map((note) => {
      const title = note?.title || "Untitled Note";
      const rawContent = note?.content || "";
      // Strip mention IDs for portable export
      const content = stripMentionIds(rawContent);
      const noteId = note?.noteId || "";
      const notebookNames = getNotebookNamesForNote(note, notebooks);

      // Escape quotes in title for the attribute
      const escapedTitle = title.replace(/"/g, "&quot;");
      const notebooksStr = notebookNames.join(", ");

      return `${NOTE_START_MARKER} title="${escapedTitle}" noteId="${noteId}" notebooks="${notebooksStr}" -->\n\n${content}\n\n${NOTE_END_MARKER}`;
    });

    return {
      notes,
      markdown: formatted.join("\n\n"),
      count: notes.length,
    };
  },
);

// Parsed note data type (v2 with isHidden)
type ParsedNote = {
  title: string;
  content: string;
  noteId?: string;
  notebooks?: string[];
  isHidden?: boolean;
};

// Parsed notebook data type (v2 hierarchical)
type ParsedNotebook = {
  title: string;
  isHidden: boolean;
  noteIds: string[];
  childNotebookTitles: string[];
};

// Parse markdown with HTML comment blocks into individual notes (plain function for use in handlers)
// Supports v1 format (no isHidden) and v2 format (with isHidden)
function parseMarkdownToNotesPlain(markdown: string): ParsedNote[] {
  if (!markdown || markdown.trim() === "") return [];

  const notes: ParsedNote[] = [];

  // Regex to match COMMON_NOTE blocks with all attributes (v1 and v2 compatible)
  // v1: title, noteId, notebooks
  // v2: title, noteId, notebooks, isHidden
  const noteBlockRegex =
    /<!-- COMMON_NOTE_START title="([^"]*)"(?:\s+noteId="([^"]*)")?(?:\s+notebooks="([^"]*)")?(?:\s+isHidden="([^"]*)")? -->([\s\S]*?)<!-- COMMON_NOTE_END -->/g;

  let match;
  while ((match = noteBlockRegex.exec(markdown)) !== null) {
    // Unescape HTML entities in title
    const title = match[1].replace(/&quot;/g, '"') || "Imported Note";
    const noteId = match[2] || undefined;
    const notebooksStr = match[3] || "";
    const isHiddenStr = match[4] || "";
    const content = match[5].trim();

    // Parse notebooks string into array (comma-separated)
    const notebooks = notebooksStr
      ? notebooksStr.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    // Parse isHidden (default to undefined if not specified for v1 compatibility)
    const isHidden = isHiddenStr === "true"
      ? true
      : isHiddenStr === "false"
      ? false
      : undefined;

    notes.push({ title, content, noteId, notebooks, isHidden });
  }

  return notes;
}

// Parse markdown with HTML comment blocks into notebook structures (v2 format)
function parseMarkdownToNotebooksPlain(markdown: string): ParsedNotebook[] {
  if (!markdown || markdown.trim() === "") return [];

  const notebooks: ParsedNotebook[] = [];

  // Regex to match COMMON_NOTEBOOK blocks
  const notebookBlockRegex =
    /<!-- COMMON_NOTEBOOK_START title="([^"]*)" isHidden="([^"]*)" noteIds="([^"]*)" childNotebooks="([^"]*)" -->/g;

  let match;
  while ((match = notebookBlockRegex.exec(markdown)) !== null) {
    // Unescape HTML entities in title
    const title = match[1].replace(/&quot;/g, '"') || "Imported Notebook";
    const isHidden = match[2] === "true";
    const noteIdsStr = match[3] || "";
    const childNotebooksStr = match[4] || "";

    // Parse noteIds (comma-separated, no spaces)
    const noteIds = noteIdsStr ? noteIdsStr.split(",").filter(Boolean) : [];

    // Parse child notebook titles (comma-separated, unescape &#44; → ,)
    const childNotebookTitles = childNotebooksStr
      ? childNotebooksStr.split(",").map((t) => t.replace(/&#44;/g, ","))
        .filter(Boolean)
      : [];

    notebooks.push({ title, isHidden, noteIds, childNotebookTitles });
  }

  return notebooks;
}

// Type for tracking detected duplicates during import
type DetectedDuplicate = {
  title: string;
  noteId?: string;
  existingNotebook: string;
};

// Type for tracking duplicates when adding notes to a notebook
type NotebookDuplicate = {
  title: string;
  noteId: string;
  noteIndex: number; // Index in the notes array
};

// Topological sort for notebooks: returns titles in order (leaves first, parents last)
// Returns indices in topological order (leaves first, parents last)
// Handles duplicate titles by using indices instead of titles
function topologicalSortNotebooks(notebooks: ParsedNotebook[]): number[] {
  // Build map of title -> indices (handles duplicates)
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
      // Visit children first (leaves before parents)
      for (const childTitle of nb.childNotebookTitles) {
        // Find child indices - for duplicates, visit all matching
        const childIndices = titleToIndices.get(childTitle) ?? [];
        for (const childIdx of childIndices) {
          visit(childIdx);
        }
      }
    }
    result.push(idx);
  }

  // Visit all notebooks by index
  for (let i = 0; i < notebooks.length; i++) {
    visit(i);
  }

  return result;
}

// Helper to perform the actual import (used by both direct import and after duplicate confirmation)
// Supports v1 format (notes with notebooks attr) and v2 format (hierarchical notebooks)
// Uses multi-pass approach:
// 1. Parse notes and notebooks from markdown
// 2. Create all notes first (with isHidden preserved)
// 3. Create notebooks in topological order (leaves first, then parents)
// 4. Link notes to notebooks using noteIds
// 5. Link child notebooks to parent notebooks
// 6. Inject entity IDs into mention links
function performImport(
  parsed: ParsedNote[],
  allCharms: Cell<NoteCharm[]>,
  notebooks: Cell<NotebookCharm[]>,
  skipTitles: Set<string>, // Titles to skip (duplicates user chose not to import)
  _importStatus?: Cell<string>, // Unused - kept for API compatibility
  onComplete?: () => void, // Callback when import is done
  rawMarkdown?: string, // Original markdown for v2 notebook parsing
) {
  const notebooksList = notebooks.get();

  // Build set of existing notebook names
  const existingNames = new Set<string>();
  notebooksList.forEach((nb: any) => {
    const rawName = nb?.[NAME] ?? "";
    const cleanName = rawName.replace(/^📓\s*/, "").replace(/\s*\(\d+\)$/, "");
    if (cleanName) existingNames.add(cleanName);
  });

  // Parse v2 notebook blocks if markdown provided
  const parsedNotebooks = rawMarkdown
    ? parseMarkdownToNotebooksPlain(rawMarkdown)
    : [];

  // Build noteId → notebook titles map from v2 format
  const noteIdToNotebookTitles = new Map<string, string[]>();
  for (const nb of parsedNotebooks) {
    for (const noteId of nb.noteIds) {
      if (!noteIdToNotebookTitles.has(noteId)) {
        noteIdToNotebookTitles.set(noteId, []);
      }
      noteIdToNotebookTitles.get(noteId)!.push(nb.title);
    }
  }

  // Collect unique notebook names needed (from v1 notes attr OR v2 notebook blocks)
  const notebooksNeeded = new Set<string>();
  for (const noteData of parsed) {
    if (!skipTitles.has(noteData.title)) {
      // v1 format: notebook names in note's notebooks attribute
      noteData.notebooks?.forEach((name) => notebooksNeeded.add(name));
      // v2 format: notebook names from noteId mapping
      if (noteData.noteId) {
        const nbTitles = noteIdToNotebookTitles.get(noteData.noteId);
        nbTitles?.forEach((name) => notebooksNeeded.add(name));
      }
    }
  }
  // Also add any notebooks from v2 that have no notes (empty notebooks or parent-only)
  for (const nb of parsedNotebooks) {
    notebooksNeeded.add(nb.title);
  }

  // === PHASE 1: Create all notes (batch - don't push yet) ===
  const createdNotes: Array<{
    title: string;
    noteId: string;
    index: number;
    contentCell: Cell<string>;
    originalContent: string;
  }> = [];
  // Map noteId → created note charm for linking
  const noteIdToCharm = new Map<string, unknown>();
  // Map notebook name → notes to add (from v1 format or v2 noteId mapping)
  const notesByNotebook = new Map<string, unknown[]>();

  const startingIndex = allCharms.get().length;
  let currentIndex = startingIndex;
  const newItems: NoteCharm[] = [];

  parsed.forEach((noteData) => {
    if (skipTitles.has(noteData.title)) return;

    const contentCell = Cell.of(noteData.content);
    const noteIdToUse = noteData.noteId || generateId();

    // Determine isHidden:
    // - v2 format: use explicit isHidden from parsed data
    // - v1 format: hidden if belongs to any notebook
    // - fallback: hidden if has notebook membership (v1 or v2 inferred)
    const belongsToNotebook = (noteData.notebooks &&
      noteData.notebooks.length > 0) ||
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

    newItems.push(note as unknown as NoteCharm);
    noteIdToCharm.set(noteIdToUse, note);
    createdNotes.push({
      title: noteData.title,
      noteId: noteIdToUse,
      index: currentIndex,
      contentCell,
      originalContent: noteData.content,
    });
    currentIndex++;

    // Track which notebooks this note belongs to (v1 format)
    if (noteData.notebooks) {
      for (const notebookName of noteData.notebooks) {
        if (!notesByNotebook.has(notebookName)) {
          notesByNotebook.set(notebookName, []);
        }
        notesByNotebook.get(notebookName)!.push(note);
      }
    }
  });

  // For v2 format, also populate notesByNotebook from noteId mapping
  for (const nb of parsedNotebooks) {
    if (!notesByNotebook.has(nb.title)) {
      notesByNotebook.set(nb.title, []);
    }
    for (const noteId of nb.noteIds) {
      const charm = noteIdToCharm.get(noteId);
      if (charm) {
        const existing = notesByNotebook.get(nb.title)!;
        // Avoid duplicates (in case v1 and v2 overlap)
        if (!existing.includes(charm)) {
          existing.push(charm);
        }
      }
    }
  }

  // === PHASE 2: Create notebooks in topological order ===
  // For v2 format, we have hierarchy info. For v1, just create flat notebooks.
  // Track created notebooks by INDEX (not title) to handle duplicates
  const createdNotebookByIndex = new Map<number, unknown>();
  // Track which titles have been used (for deduplication)
  const usedTitles = new Set<string>(existingNames);
  // Track notebooks separately so we can reorder them to match original export order
  const createdNotebooks: Array<{
    originalIndex: number;
    notebook: unknown;
  }> = [];

  // Helper to generate unique title
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
    // v2 format: create in topological order (leaves first, for dependency resolution)
    // Returns INDICES, not titles, to handle duplicates
    const sortedIndices = topologicalSortNotebooks(parsedNotebooks);

    // Build map of original title -> child indices (for looking up children)
    const titleToChildIndices = new Map<string, number[]>();
    parsedNotebooks.forEach((nb, idx) => {
      // This notebook is a child of any parent that lists it in childNotebookTitles
      // We track by the notebook's own title for lookup
      const indices = titleToChildIndices.get(nb.title) ?? [];
      indices.push(idx);
      titleToChildIndices.set(nb.title, indices);
    });

    for (const idx of sortedIndices) {
      const nbData = parsedNotebooks[idx];
      if (!nbData) continue;

      // Generate unique title (handles duplicates)
      const actualName = getUniqueTitle(nbData.title);

      // Collect notes for this notebook (by original title)
      const notesForNotebook = notesByNotebook.get(nbData.title) ?? [];

      // Collect child notebooks by looking up their indices
      const childNotebooks: unknown[] = [];
      for (const childTitle of nbData.childNotebookTitles) {
        const childIndices = titleToChildIndices.get(childTitle) ?? [];
        for (const childIdx of childIndices) {
          const childCharm = createdNotebookByIndex.get(childIdx);
          if (childCharm) {
            childNotebooks.push(childCharm);
          }
        }
      }

      // Combine notes and child notebooks
      const allContents = [
        ...notesForNotebook,
        ...childNotebooks,
      ] as unknown as NoteCharm[];

      const newNb = Notebook({
        title: actualName,
        notes: allContents,
        isHidden: nbData.isHidden ?? false,
      });

      // Track by index for child lookup
      createdNotebookByIndex.set(idx, newNb);
      // Track for later reordering
      createdNotebooks.push({ originalIndex: idx, notebook: newNb });
    }

    // Sort notebooks back to original export order and add to newItems
    createdNotebooks.sort((a, b) => a.originalIndex - b.originalIndex);
    for (const { notebook } of createdNotebooks) {
      newItems.push(notebook as unknown as NoteCharm);
    }
  } else {
    // v1 format: create flat notebooks (no hierarchy info)
    for (const nbName of notebooksNeeded) {
      // Use getUniqueTitle for consistency (handles duplicates)
      const actualName = getUniqueTitle(nbName);

      const notesForNotebook = notesByNotebook.get(nbName) ?? [];
      const newNb = Notebook({
        title: actualName,
        notes: notesForNotebook as unknown as NoteCharm[],
      });

      newItems.push(newNb as unknown as NoteCharm);
    }
  }

  // === BATCH PUSH: Single set() instead of N push() calls ===
  if (newItems.length > 0) {
    allCharms.set([...allCharms.get(), ...newItems]);
  }

  // === PHASE 3: Build title→ID map and link mentions ===
  const titleToId = new Map<string, string>();
  for (const { title, index } of createdNotes) {
    try {
      const noteCell = allCharms.key(index) as any;
      const resolved = noteCell.resolveAsCell();
      const entityId = resolved?.entityId;
      if (entityId?.["/"] && title) {
        titleToId.set(title.toLowerCase(), entityId["/"]);
      }
    } catch (_e) {
      // Ignore errors getting entityId
    }
  }

  // Inject IDs into content for all created notes
  for (
    const { title: _title, originalContent, contentCell } of createdNotes
  ) {
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
      // Ignore errors updating content
    }
  }

  onComplete?.();
}

// Handler for file upload in import modal - reads file and triggers import directly
const handleImportFileUpload = handler<
  { detail: { files: Array<{ url: string; name: string }> } },
  {
    importMarkdown: Cell<string>;
    notes: Cell<NoteCharm[]>;
    allCharms: Cell<NoteCharm[]>;
    notebooks: Cell<NotebookCharm[]>;
    showDuplicateModal: Cell<boolean>;
    detectedDuplicates: Cell<DetectedDuplicate[]>;
    pendingImportData: Cell<string>;
    showImportModal: Cell<boolean>;
    showImportProgressModal: Cell<boolean>;
    importProgressMessage: Cell<string>;
    importComplete: Cell<boolean>;
    showPasteSection?: Cell<boolean>;
  }
>(({ detail }, state) => {
  const files = detail?.files ?? [];
  if (files.length === 0) return;

  // data URL format: "data:text/plain;base64,..." or "data:text/markdown;base64,..."
  const dataUrl = files[0].url;
  const base64Part = dataUrl.split(",")[1];
  if (!base64Part) return;

  // Decode base64 properly for UTF-8 (atob alone corrupts non-ASCII chars)
  const binaryString = atob(base64Part);
  const bytes = Uint8Array.from(binaryString, (char) => char.charCodeAt(0));
  const content = new TextDecoder().decode(bytes);

  // Parse both notes AND notebooks from the file
  const parsedNotes = parseMarkdownToNotesPlain(content);
  const parsedNotebooks = parseMarkdownToNotebooksPlain(content);

  // If neither notes nor notebooks found, the file isn't in the expected format
  if (parsedNotes.length === 0 && parsedNotebooks.length === 0) {
    console.warn("Import: No notes or notebooks found in file");
    return;
  }

  // Get existing notes for duplicate detection
  const existingNotes = state.notes.get();
  const existingByTitle = new Map<string, NoteCharm>();
  existingNotes.forEach((note: any) => {
    const title = note?.title;
    if (title) existingByTitle.set(title, note);
  });

  // Detect duplicates (only for notes)
  const duplicates: DetectedDuplicate[] = [];
  for (const noteData of parsedNotes) {
    const existing = existingByTitle.get(noteData.title);
    if (existing) {
      duplicates.push({
        title: noteData.title,
        noteId: noteData.noteId,
        existingNotebook: "this space",
      });
    }
  }

  // Build progress message
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

  if (duplicates.length > 0) {
    // Store pending import and show duplicate modal
    state.pendingImportData.set(content);
    state.detectedDuplicates.set(duplicates);
    state.showDuplicateModal.set(true);
    state.showImportModal.set(false);
    state.showPasteSection?.set(true); // Reset for next time
  } else {
    // Set all state BEFORE showing modal to avoid default state flicker
    state.showImportModal.set(false);
    state.showPasteSection?.set(true); // Reset for next time
    state.importComplete.set(false);
    state.importProgressMessage.set(`Importing ${importSummary}...`);
    // NOW show the modal (after state is set)
    state.showImportProgressModal.set(true);

    // Run import synchronously (pass raw content for v2 notebook parsing)
    performImport(
      parsedNotes,
      state.allCharms,
      state.notebooks,
      new Set(),
      undefined,
      undefined,
      content,
    );

    // Mark import as complete
    state.importProgressMessage.set(`Imported ${importSummary}!`);
    state.importComplete.set(true);
  }
});

// Handler to analyze import and detect duplicates
const analyzeImport = handler<
  Record<string, never>,
  {
    importMarkdown: Cell<string>;
    notes: Cell<NoteCharm[]>;
    allCharms: Cell<NoteCharm[]>;
    notebooks: Cell<NotebookCharm[]>;
    showDuplicateModal: Cell<boolean>;
    detectedDuplicates: Cell<DetectedDuplicate[]>;
    pendingImportData: Cell<string>;
    showImportModal?: Cell<boolean>;
    importStatus?: Cell<string>;
    showImportProgressModal?: Cell<boolean>;
    importProgressMessage?: Cell<string>;
    importComplete?: Cell<boolean>;
    showPasteSection?: Cell<boolean>;
  }
>((_, state) => {
  const {
    importMarkdown,
    notes,
    allCharms,
    notebooks,
    showDuplicateModal,
    detectedDuplicates,
    pendingImportData,
    showImportModal,
    importStatus: _importStatus,
    showImportProgressModal,
    importProgressMessage,
    importComplete,
    showPasteSection,
  } = state;
  const markdown = importMarkdown.get();

  // Parse both notes AND notebooks from the pasted content
  const parsedNotes = parseMarkdownToNotesPlain(markdown);
  const parsedNotebooks = parseMarkdownToNotebooksPlain(markdown);

  // If neither notes nor notebooks found, the content isn't in the expected format
  if (parsedNotes.length === 0 && parsedNotebooks.length === 0) return;

  // Get existing notes for duplicate detection
  const existingNotes = notes.get();
  const existingByTitle = new Map<string, NoteCharm>();
  existingNotes.forEach((note: any) => {
    const title = note?.title;
    if (title) existingByTitle.set(title, note);
  });

  // Detect duplicates (same title exists in space) - only for notes
  const duplicates: DetectedDuplicate[] = [];
  for (const noteData of parsedNotes) {
    const existing = existingByTitle.get(noteData.title);
    if (existing) {
      duplicates.push({
        title: noteData.title,
        noteId: noteData.noteId,
        existingNotebook: "this space", // We're checking space-level, not notebook-level
      });
    }
  }

  // Build progress message
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

  if (duplicates.length > 0) {
    // Store pending import and show modal
    pendingImportData.set(markdown);
    detectedDuplicates.set(duplicates);
    showDuplicateModal.set(true);
    // Close import modal if open (duplicate modal will take over)
    showImportModal?.set(false);
    showPasteSection?.set(true); // Reset for next time
  } else {
    // Clear markdown and close import modal
    importMarkdown.set("");
    showImportModal?.set(false);
    showPasteSection?.set(true); // Reset for next time

    // Set all state BEFORE showing modal to avoid default state flicker
    importComplete?.set(false);
    importProgressMessage?.set(`Importing ${importSummary}...`);
    // NOW show the modal
    showImportProgressModal?.set(true);

    // Run import synchronously (pass raw markdown for v2 notebook parsing)
    performImport(
      parsedNotes,
      allCharms,
      notebooks,
      new Set(),
      undefined,
      undefined,
      markdown,
    );

    // Mark import as complete
    importProgressMessage?.set(`Imported ${importSummary}!`);
    importComplete?.set(true);
  }
});

// Handler to import notes (skipping duplicates)
const importSkipDuplicates = handler<
  Record<string, never>,
  {
    pendingImportData: Cell<string>;
    allCharms: Cell<NoteCharm[]>;
    notebooks: Cell<NotebookCharm[]>;
    detectedDuplicates: Cell<DetectedDuplicate[]>;
    showDuplicateModal: Cell<boolean>;
    importMarkdown: Cell<string>;
    importStatus?: Cell<string>;
    showImportProgressModal?: Cell<boolean>;
    importProgressMessage?: Cell<string>;
    importComplete?: Cell<boolean>;
  }
>((_, state) => {
  const markdown = state.pendingImportData.get();
  const parsed = parseMarkdownToNotesPlain(markdown);
  const duplicates = state.detectedDuplicates.get();

  // Build skip set from duplicate titles
  const skipTitles = new Set(duplicates.map((d) => d.title));
  const importCount = parsed.length - skipTitles.size;

  // Clear data and close duplicate modal
  state.pendingImportData.set("");
  state.detectedDuplicates.set([]);
  state.importMarkdown.set("");
  state.showDuplicateModal.set(false);

  // Set all state BEFORE showing modal to avoid default state flicker
  state.importComplete?.set(false);
  state.importProgressMessage?.set(`Importing ${importCount} notes...`);
  // NOW show the modal
  state.showImportProgressModal?.set(true);

  // Run import synchronously (pass raw markdown for v2 notebook parsing)
  performImport(
    parsed,
    state.allCharms,
    state.notebooks,
    skipTitles,
    undefined,
    undefined,
    markdown,
  );

  // Mark import as complete
  state.importProgressMessage?.set(`Imported ${importCount} notes!`);
  state.importComplete?.set(true);
});

// Handler to import all notes (including duplicates as copies)
const importAllAsCopies = handler<
  Record<string, never>,
  {
    pendingImportData: Cell<string>;
    allCharms: Cell<NoteCharm[]>;
    notebooks: Cell<NotebookCharm[]>;
    showDuplicateModal: Cell<boolean>;
    detectedDuplicates: Cell<DetectedDuplicate[]>;
    importMarkdown: Cell<string>;
    importStatus?: Cell<string>;
    showImportProgressModal?: Cell<boolean>;
    importProgressMessage?: Cell<string>;
    importComplete?: Cell<boolean>;
  }
>((_, state) => {
  const markdown = state.pendingImportData.get();
  const parsed = parseMarkdownToNotesPlain(markdown);

  // Clear data and close duplicate modal
  state.pendingImportData.set("");
  state.detectedDuplicates.set([]);
  state.importMarkdown.set("");
  state.showDuplicateModal.set(false);

  // Set all state BEFORE showing modal to avoid default state flicker
  state.importComplete?.set(false);
  state.importProgressMessage?.set(`Importing ${parsed.length} notes...`);
  // NOW show the modal
  state.showImportProgressModal?.set(true);

  // Run import synchronously (pass raw markdown for v2 notebook parsing)
  performImport(
    parsed,
    state.allCharms,
    state.notebooks,
    new Set(),
    undefined,
    undefined,
    markdown,
  );

  // Mark import as complete
  state.importProgressMessage?.set(`Imported ${parsed.length} notes!`);
  state.importComplete?.set(true);
});

// Handler to cancel import
const cancelImport = handler<
  Record<string, never>,
  {
    showDuplicateModal: Cell<boolean>;
    detectedDuplicates: Cell<DetectedDuplicate[]>;
    pendingImportData: Cell<string>;
  }
>((_, state) => {
  state.showDuplicateModal.set(false);
  state.detectedDuplicates.set([]);
  state.pendingImportData.set("");
});

// Handler to hide paste section when Upload File button is clicked
const hidePasteSection = handler<
  Record<string, never>,
  { showPasteSection: Cell<boolean> }
>((_, { showPasteSection }) => {
  showPasteSection.set(false);
});

// Legacy handler for direct import (no duplicate check)
const _importNotes = handler<
  Record<string, never>,
  {
    importMarkdown: Cell<string>;
    allCharms: Cell<NoteCharm[]>;
    notebooks: Cell<NotebookCharm[]>;
    importStatus?: Cell<string>;
  }
>((_, { importMarkdown, allCharms, notebooks, importStatus }) => {
  const markdown = importMarkdown.get();
  const parsed = parseMarkdownToNotesPlain(markdown);

  if (parsed.length === 0) return;

  // Pass raw markdown for v2 notebook parsing
  performImport(
    parsed,
    allCharms,
    notebooks,
    new Set(),
    importStatus,
    undefined,
    markdown,
  );
  importMarkdown.set("");
});

// Handler to toggle note visibility in default-app listing
const toggleNoteVisibility = handler<
  Record<string, never>,
  { note: Cell<NoteCharm> }
>((_, { note }) => {
  const isHiddenCell = note.key("isHidden");
  const current = isHiddenCell.get() ?? false;
  isHiddenCell.set(!current);
});

// Handler to toggle all notes' visibility at once
// If any are visible, hide all; if all hidden, show all
const toggleAllNotesVisibility = handler<
  Record<string, never>,
  { notes: Cell<NoteCharm[]> }
>((_, { notes }) => {
  const notesList = notes.get();
  if (notesList.length === 0) return;

  // Check if any notes are currently visible (not hidden)
  const anyVisible = notesList.some((n: any) => !n?.isHidden);
  // If any visible, hide all; otherwise show all
  const newHiddenState = anyVisible;

  // Update each note's isHidden state
  notesList.forEach((_n: any, idx: number) => {
    const noteCell = notes.key(idx);
    const isHiddenCell = (noteCell as any).key("isHidden");
    isHiddenCell.set(newHiddenState);
  });
});

// Handler to toggle notebook visibility in default-app listing
const toggleNotebookVisibility = handler<
  Record<string, never>,
  { notebook: Cell<NotebookCharm> }
>((_, { notebook }) => {
  const isHiddenCell = notebook.key("isHidden");
  const current = isHiddenCell.get() ?? false;
  isHiddenCell.set(!current);
});

// Handler to toggle all notebooks' visibility at once
// If any are visible, hide all; if all hidden, show all
const toggleAllNotebooksVisibility = handler<
  Record<string, never>,
  { notebooks: Cell<NotebookCharm[]> }
>((_, { notebooks }) => {
  const notebooksList = notebooks.get();
  if (notebooksList.length === 0) return;

  // Check if any notebooks are currently visible (not hidden)
  const anyVisible = notebooksList.some((nb: any) => !nb?.isHidden);
  // If any visible, hide all; otherwise show all
  const newHiddenState = anyVisible;

  // Update each notebook's isHidden state
  notebooksList.forEach((_nb: any, idx: number) => {
    const notebookCell = notebooks.key(idx);
    const isHiddenCell = (notebookCell as any).key("isHidden");
    isHiddenCell.set(newHiddenState);
  });
});

// Handler to toggle individual selection (with shift-click range support)
const _toggleSelection = handler<
  { shiftKey?: boolean },
  {
    index: number;
    selectedIndices: Cell<number[]>;
    lastSelectedIndex: Cell<number>;
  }
>((event, { index, selectedIndices, lastSelectedIndex }) => {
  const current = selectedIndices.get();
  const lastIdx = lastSelectedIndex.get();

  if (event?.shiftKey && lastIdx >= 0 && lastIdx !== index) {
    // Range select: select all between lastIdx and index
    const start = Math.min(lastIdx, index);
    const end = Math.max(lastIdx, index);
    const range: number[] = [];
    for (let i = start; i <= end; i++) {
      range.push(i);
    }
    // Merge with existing selection (union)
    const merged = [...new Set([...current, ...range])];
    selectedIndices.set(merged);
  } else {
    // Normal toggle
    const idx = current.indexOf(index);
    if (idx >= 0) {
      selectedIndices.set(current.filter((i) => i !== index));
    } else {
      selectedIndices.set([...current, index]);
    }
  }

  lastSelectedIndex.set(index);
});

// Handler to navigate to a notebook
const goToNotebook = handler<void, { notebook: Cell<NotebookCharm> }>(
  (_, { notebook }) => navigateTo(notebook),
);

// Handler to select all notes
const selectAll = handler<
  Record<string, never>,
  { notes: Cell<NoteCharm[]>; selectedIndices: Cell<number[]> }
>((_, { notes, selectedIndices }) => {
  const notesList = notes.get();
  selectedIndices.set(notesList.map((_, i) => i));
});

// Handler to deselect all notes
const deselectAll = handler<
  Record<string, never>,
  { selectedIndices: Cell<number[]> }
>((_, { selectedIndices }) => {
  selectedIndices.set([]);
});

// Handler to toggle visibility of all selected notes via switch
const _toggleSelectedVisibility = handler<
  { detail: { checked: boolean } },
  { notes: Cell<NoteCharm[]>; selectedIndices: Cell<number[]> }
>((event, { notes, selectedIndices }) => {
  const selected = selectedIndices.get();
  const makeVisible = event.detail?.checked ?? false;
  for (const idx of selected) {
    const noteCell = notes.key(idx);
    if (noteCell) {
      noteCell.key("isHidden").set(!makeVisible);
    }
  }
  selectedIndices.set([]);
});

// Handler to show the standalone "New Notebook" modal
const showStandaloneNotebookModal = handler<
  void,
  { showStandaloneNotebookPrompt: Cell<boolean> }
>((_, { showStandaloneNotebookPrompt }) =>
  showStandaloneNotebookPrompt.set(true)
);

// Handler to create notebook with user-provided name and navigate to it
const createStandaloneNotebookAndOpen = handler<
  void,
  {
    standaloneNotebookTitle: Cell<string>;
    showStandaloneNotebookPrompt: Cell<boolean>;
    allCharms: Cell<NoteCharm[]>;
  }
>((_, { standaloneNotebookTitle, showStandaloneNotebookPrompt, allCharms }) => {
  const title = standaloneNotebookTitle.get().trim() || "New Notebook";
  const nb = Notebook({ title });
  allCharms.push(nb as unknown as NoteCharm);
  showStandaloneNotebookPrompt.set(false);
  standaloneNotebookTitle.set("");
  return navigateTo(nb);
});

// Handler to create notebook and stay in modal to create another
const createStandaloneNotebookAndContinue = handler<
  void,
  {
    standaloneNotebookTitle: Cell<string>;
    allCharms: Cell<NoteCharm[]>;
  }
>((_, { standaloneNotebookTitle, allCharms }) => {
  const title = standaloneNotebookTitle.get().trim() || "New Notebook";
  const nb = Notebook({ title });
  allCharms.push(nb as unknown as NoteCharm);
  // Keep modal open, just clear the title for the next notebook
  standaloneNotebookTitle.set("");
});

// Handler to cancel the standalone notebook prompt
const cancelStandaloneNotebookPrompt = handler<
  void,
  {
    showStandaloneNotebookPrompt: Cell<boolean>;
    standaloneNotebookTitle: Cell<string>;
  }
>((_, { showStandaloneNotebookPrompt, standaloneNotebookTitle }) => {
  showStandaloneNotebookPrompt.set(false);
  standaloneNotebookTitle.set("");
});

// Handler to create a new notebook (without navigating) - kept for potential future use
const _createNotebook = handler<
  Record<string, never>,
  { allCharms: Cell<NoteCharm[]> }
>((_, { allCharms }) => {
  const nb = Notebook({ title: "New Notebook" });
  allCharms.push(nb as unknown as NoteCharm);
});

// Handler to create a new note (without navigating)
const createNote = handler<
  Record<string, never>,
  { allCharms: Cell<NoteCharm[]> }
>((_, { allCharms }) => {
  const note = Note({
    title: "New Note",
    content: "",
    noteId: generateId(),
  });
  allCharms.push(note as unknown as NoteCharm);
});

// Helper to perform the actual add-to-notebook operation
function performAddToNotebook(
  notesToAdd: { note: NoteCharm; idx: number }[],
  notebookCell: Cell<NotebookCharm>,
  notes: Cell<NoteCharm[]>,
  selectedIndices: Cell<number[]>,
  selectedNotebook: Cell<string>,
) {
  const notebookNotes = notebookCell.key("notes");

  for (const { note, idx } of notesToAdd) {
    // Add to notebook
    (notebookNotes as Cell<NoteCharm[] | undefined>).push(note);
    // Hide from main listing
    notes.key(idx).key("isHidden").set(true);
  }

  selectedIndices.set([]);
  selectedNotebook.set("");
}

// Handler to add selected notes to a notebook (triggered by dropdown change)
const addToNotebook = handler<
  { target?: { value: string }; detail?: { value: string } },
  {
    notebooks: Cell<NotebookCharm[]>;
    notes: Cell<NoteCharm[]>;
    selectedIndices: Cell<number[]>;
    selectedNotebook: Cell<string>;
    showNewNotebookPrompt: Cell<boolean>;
    pendingNotebookAction: Cell<"add" | "move" | "">;
    showNotebookDuplicateModal: Cell<boolean>;
    notebookDuplicates: Cell<NotebookDuplicate[]>;
    pendingAddNotebookIndex: Cell<number>;
    nonDuplicateNotes: Cell<{ note: NoteCharm; idx: number }[]>;
  }
>((
  event,
  state,
) => {
  const {
    notebooks,
    notes,
    selectedIndices,
    selectedNotebook,
    showNewNotebookPrompt,
    pendingNotebookAction,
    showNotebookDuplicateModal,
    notebookDuplicates,
    pendingAddNotebookIndex,
    nonDuplicateNotes,
  } = state;

  // Handle both native select (target.value) and ct-select (detail.value)
  const value = event.target?.value ?? event.detail?.value ?? "";
  if (!value) return;

  // Handle "new" - show prompt to get name from user
  if (value === "new") {
    pendingNotebookAction.set("add");
    showNewNotebookPrompt.set(true);
    selectedNotebook.set("");
    return;
  }

  // Add to existing notebook
  const nbIndex = parseInt(value, 10);
  if (nbIndex < 0) return;

  const selected = selectedIndices.get();
  const notesList = notes.get();
  const notebookCell = notebooks.key(nbIndex);
  const existingNotes = notebookCell.key("notes").get() ?? [];

  // Build set of existing noteIds in this notebook
  const existingNoteIds = new Set<string>();
  for (const n of existingNotes) {
    const noteId = (n as any)?.noteId;
    if (noteId) existingNoteIds.add(noteId);
  }

  // Check for duplicates
  const duplicates: NotebookDuplicate[] = [];
  const nonDuplicates: { note: NoteCharm; idx: number }[] = [];

  for (const idx of selected) {
    const note = notesList[idx];
    if (!note) continue;

    const noteId = (note as any)?.noteId;
    if (noteId && existingNoteIds.has(noteId)) {
      duplicates.push({
        title: note.title ?? "Untitled",
        noteId,
        noteIndex: idx,
      });
    } else {
      nonDuplicates.push({ note, idx });
    }
  }

  if (duplicates.length > 0) {
    // Store pending state and show modal
    pendingAddNotebookIndex.set(nbIndex);
    notebookDuplicates.set(duplicates);
    nonDuplicateNotes.set(nonDuplicates);
    showNotebookDuplicateModal.set(true);
    selectedNotebook.set("");
  } else {
    // No duplicates, add directly
    performAddToNotebook(
      nonDuplicates,
      notebookCell,
      notes,
      selectedIndices,
      selectedNotebook,
    );
  }
});

// Handler to skip duplicates and add only non-duplicates to notebook
const addSkipDuplicates = handler<
  Record<string, never>,
  {
    notebooks: Cell<NotebookCharm[]>;
    notes: Cell<NoteCharm[]>;
    selectedIndices: Cell<number[]>;
    selectedNotebook: Cell<string>;
    showNotebookDuplicateModal: Cell<boolean>;
    notebookDuplicates: Cell<NotebookDuplicate[]>;
    pendingAddNotebookIndex: Cell<number>;
    nonDuplicateNotes: Cell<{ note: NoteCharm; idx: number }[]>;
  }
>((_, state) => {
  const notebookCell = state.notebooks.key(state.pendingAddNotebookIndex.get());
  const nonDuplicates = [...state.nonDuplicateNotes.get()];

  performAddToNotebook(
    nonDuplicates,
    notebookCell,
    state.notes,
    state.selectedIndices,
    state.selectedNotebook,
  );

  // Clean up
  state.showNotebookDuplicateModal.set(false);
  state.notebookDuplicates.set([]);
  state.nonDuplicateNotes.set([]);
  state.pendingAddNotebookIndex.set(-1);
});

// Handler to add all notes including duplicates to notebook
const addIncludingDuplicates = handler<
  Record<string, never>,
  {
    notebooks: Cell<NotebookCharm[]>;
    notes: Cell<NoteCharm[]>;
    selectedIndices: Cell<number[]>;
    selectedNotebook: Cell<string>;
    showNotebookDuplicateModal: Cell<boolean>;
    notebookDuplicates: Cell<NotebookDuplicate[]>;
    pendingAddNotebookIndex: Cell<number>;
    nonDuplicateNotes: Cell<{ note: NoteCharm; idx: number }[]>;
  }
>((_, state) => {
  const notebookCell = state.notebooks.key(state.pendingAddNotebookIndex.get());
  const nonDuplicates = [...state.nonDuplicateNotes.get()];
  const duplicates = [...state.notebookDuplicates.get()];
  const notesList = state.notes.get();

  // Combine non-duplicates and duplicates
  const allNotes: { note: NoteCharm; idx: number }[] = [
    ...nonDuplicates,
    ...duplicates.map((d) => ({
      note: notesList[d.noteIndex],
      idx: d.noteIndex,
    })),
  ];

  performAddToNotebook(
    allNotes,
    notebookCell,
    state.notes,
    state.selectedIndices,
    state.selectedNotebook,
  );

  // Clean up
  state.showNotebookDuplicateModal.set(false);
  state.notebookDuplicates.set([]);
  state.nonDuplicateNotes.set([]);
  state.pendingAddNotebookIndex.set(-1);
});

// Handler to cancel adding to notebook
const cancelAddToNotebook = handler<
  Record<string, never>,
  {
    showNotebookDuplicateModal: Cell<boolean>;
    notebookDuplicates: Cell<NotebookDuplicate[]>;
    pendingAddNotebookIndex: Cell<number>;
    nonDuplicateNotes: Cell<{ note: NoteCharm; idx: number }[]>;
    selectedIndices: Cell<number[]>;
    selectedNotebook: Cell<string>;
  }
>((_, state) => {
  state.showNotebookDuplicateModal.set(false);
  state.notebookDuplicates.set([]);
  state.nonDuplicateNotes.set([]);
  state.pendingAddNotebookIndex.set(-1);
  state.selectedIndices.set([]);
  state.selectedNotebook.set("");
});

// Handler to duplicate selected notes
const duplicateSelectedNotes = handler<
  Record<string, never>,
  {
    notes: Cell<NoteCharm[]>;
    selectedIndices: Cell<number[]>;
    allCharms: Cell<NoteCharm[]>;
  }
>((_, { notes, selectedIndices, allCharms }) => {
  const selected = selectedIndices.get();
  const notesList = notes.get();

  // Collect copies first, then batch push (reduces N reactive cycles to 1)
  const copies: NoteCharm[] = [];
  for (const idx of selected) {
    const original = notesList[idx];
    if (original) {
      copies.push(Note({
        title: (original.title ?? "Note") + " (Copy)",
        content: original.content ?? "",
        noteId: generateId(),
      }) as unknown as NoteCharm);
    }
  }
  allCharms.push(...copies);
  selectedIndices.set([]);
});

// Handler to permanently delete selected notes from the space
const deleteSelectedNotes = handler<
  Record<string, never>,
  {
    notes: Cell<NoteCharm[]>;
    selectedIndices: Cell<number[]>;
    allCharms: Cell<NoteCharm[]>;
    notebooks: Cell<NotebookCharm[]>;
  }
>((_, { notes, selectedIndices, allCharms, notebooks }) => {
  const selected = selectedIndices.get();
  const notesList = notes.get();
  const allCharmsList = allCharms.get();
  const notebooksList = notebooks.get();

  // Collect noteIds to delete
  const noteIdsToDelete: string[] = [];
  for (const idx of selected) {
    const note = notesList[idx];
    const noteId = (note as any)?.noteId;
    if (noteId) noteIdsToDelete.push(noteId);
  }

  // Remove from all notebooks first
  for (let nbIdx = 0; nbIdx < notebooksList.length; nbIdx++) {
    const nbCell = notebooks.key(nbIdx);
    const nbNotesCell = nbCell.key("notes");
    const nbNotes = nbNotesCell.get() ?? [];

    const filtered = nbNotes.filter((n: any) =>
      !noteIdsToDelete.includes(n?.noteId)
    );
    if (filtered.length !== nbNotes.length) {
      nbNotesCell.set(filtered);
    }
  }

  // Remove from allCharms (permanent delete)
  const filteredCharms = allCharmsList.filter((charm: any) => {
    const noteId = charm?.noteId;
    return !noteId || !noteIdsToDelete.includes(noteId);
  });
  allCharms.set(filteredCharms);

  selectedIndices.set([]);
});

// Handler to move selected notes to a notebook (removes from current notebooks first)
const moveToNotebook = handler<
  { target?: { value: string }; detail?: { value: string } },
  {
    notebooks: Cell<NotebookCharm[]>;
    notes: Cell<NoteCharm[]>;
    selectedIndices: Cell<number[]>;
    selectedMoveNotebook: Cell<string>;
    showNewNotebookPrompt: Cell<boolean>;
    pendingNotebookAction: Cell<"add" | "move" | "">;
  }
>((
  event,
  {
    notebooks,
    notes,
    selectedIndices,
    selectedMoveNotebook,
    showNewNotebookPrompt,
    pendingNotebookAction,
  },
) => {
  // Handle both native select (target.value) and ct-select (detail.value)
  const value = event.target?.value ?? event.detail?.value ?? "";
  if (!value) return;

  // Handle "new" - show prompt to get name from user
  if (value === "new") {
    pendingNotebookAction.set("move");
    showNewNotebookPrompt.set(true);
    selectedMoveNotebook.set("");
    return;
  }

  // Move to existing notebook
  const nbIndex = parseInt(value, 10);
  if (nbIndex < 0) return;

  const selected = selectedIndices.get();
  const notesList = notes.get();
  const notebooksList = notebooks.get();
  const targetNotebookCell = notebooks.key(nbIndex);
  const targetNotebookNotes = targetNotebookCell.key("notes");

  for (const idx of selected) {
    const note = notesList[idx];
    if (!note) continue;

    const noteId = (note as any)?.noteId;

    // Remove from all current notebooks (by noteId)
    if (noteId) {
      for (let nbIdx = 0; nbIdx < notebooksList.length; nbIdx++) {
        const nbCell = notebooks.key(nbIdx);
        const nbNotesCell = nbCell.key("notes");
        const nbNotes = nbNotesCell.get() ?? [];

        // Find and remove this note by noteId
        const noteIndex = nbNotes.findIndex((n: any) => n?.noteId === noteId);
        if (noteIndex >= 0) {
          const updated = [...nbNotes];
          updated.splice(noteIndex, 1);
          nbNotesCell.set(updated);
        }
      }
    }

    // Add to target notebook
    (targetNotebookNotes as Cell<NoteCharm[] | undefined>).push(note);
    // Hide from main listing
    notes.key(idx).key("isHidden").set(true);
  }

  selectedIndices.set([]);
  selectedMoveNotebook.set("");
});

// Handler to select all notebooks
const selectAllNotebooks = handler<
  Record<string, never>,
  { notebooks: Cell<NotebookCharm[]>; selectedNotebookIndices: Cell<number[]> }
>((_, { notebooks, selectedNotebookIndices }) => {
  const nbList = notebooks.get();
  selectedNotebookIndices.set(nbList.map((_, i) => i));
});

// Handler to deselect all notebooks
const deselectAllNotebooks = handler<
  Record<string, never>,
  { selectedNotebookIndices: Cell<number[]> }
>((_, { selectedNotebookIndices }) => {
  selectedNotebookIndices.set([]);
});

// Handler to show delete notebooks confirmation modal
const confirmDeleteNotebooks = handler<
  Record<string, never>,
  {
    selectedNotebookIndices: Cell<number[]>;
    showDeleteNotebookModal: Cell<boolean>;
  }
>((_, { selectedNotebookIndices, showDeleteNotebookModal }) => {
  if (selectedNotebookIndices.get().length > 0) {
    showDeleteNotebookModal.set(true);
  }
});

// Handler to delete notebooks only (keep notes, make them visible)
const deleteNotebooksOnly = handler<
  Record<string, never>,
  {
    notebooks: Cell<NotebookCharm[]>;
    selectedNotebookIndices: Cell<number[]>;
    allCharms: Cell<NoteCharm[]>;
    showDeleteNotebookModal: Cell<boolean>;
  }
>((
  _,
  { notebooks, selectedNotebookIndices, allCharms, showDeleteNotebookModal },
) => {
  const selected = selectedNotebookIndices.get();
  const notebooksList = notebooks.get();
  const allCharmsList = allCharms.get();

  // Guard: require explicit selection
  if (!selected || selected.length === 0) {
    showDeleteNotebookModal.set(false);
    return;
  }

  // Collect all notes from selected notebooks and make them visible
  for (const idx of selected) {
    const nb = notebooksList[idx];
    const nbNotes = (nb as any)?.notes ?? [];
    for (const note of nbNotes) {
      const noteId = (note as any)?.noteId;
      if (noteId) {
        // Find the note in allCharms and set isHidden to false
        for (let i = 0; i < allCharmsList.length; i++) {
          if ((allCharmsList[i] as any)?.noteId === noteId) {
            allCharms.key(i).key("isHidden").set(false);
            break;
          }
        }
      }
    }
  }

  // Find which indices in allCharms are notebooks (to map selected -> allCharms indices)
  const notebookIndicesInAllCharms: number[] = [];
  for (let i = 0; i < allCharmsList.length; i++) {
    const name = (allCharmsList[i] as any)?.[NAME];
    if (typeof name === "string" && name.startsWith("📓")) {
      notebookIndicesInAllCharms.push(i);
    }
  }

  // Map selected notebook indices to allCharms indices
  const allCharmsIndicesToDelete: Set<number> = new Set();
  for (const selectedIdx of selected) {
    const allCharmsIdx = notebookIndicesInAllCharms[selectedIdx];
    if (allCharmsIdx !== undefined) {
      allCharmsIndicesToDelete.add(allCharmsIdx);
    }
  }

  // Remove by allCharms index
  const filteredCharms = allCharmsList.filter((_, i) => {
    return !allCharmsIndicesToDelete.has(i);
  });
  allCharms.set(filteredCharms);

  selectedNotebookIndices.set([]);
  showDeleteNotebookModal.set(false);
});

// Handler to delete notebooks AND all their notes
const deleteNotebooksAndNotes = handler<
  Record<string, never>,
  {
    notebooks: Cell<NotebookCharm[]>;
    selectedNotebookIndices: Cell<number[]>;
    allCharms: Cell<NoteCharm[]>;
    showDeleteNotebookModal: Cell<boolean>;
  }
>((
  _,
  { notebooks, selectedNotebookIndices, allCharms, showDeleteNotebookModal },
) => {
  const selected = selectedNotebookIndices.get();
  const notebooksList = notebooks.get();
  const allCharmsList = allCharms.get();

  // Guard: require explicit selection
  if (!selected || selected.length === 0) {
    showDeleteNotebookModal.set(false);
    return;
  }

  // Collect all noteIds from selected notebooks
  const noteIdsToDelete: string[] = [];
  for (const idx of selected) {
    const nb = notebooksList[idx];
    const nbNotes = (nb as any)?.notes ?? [];
    for (const note of nbNotes) {
      const noteId = (note as any)?.noteId;
      if (noteId) noteIdsToDelete.push(noteId);
    }
  }

  // Find which indices in allCharms are notebooks (to map selected -> allCharms indices)
  const notebookIndicesInAllCharms: number[] = [];
  for (let i = 0; i < allCharmsList.length; i++) {
    const name = (allCharmsList[i] as any)?.[NAME];
    if (typeof name === "string" && name.startsWith("📓")) {
      notebookIndicesInAllCharms.push(i);
    }
  }

  // Map selected notebook indices to allCharms indices
  const allCharmsIndicesToDelete: Set<number> = new Set();
  for (const selectedIdx of selected) {
    const allCharmsIdx = notebookIndicesInAllCharms[selectedIdx];
    if (allCharmsIdx !== undefined) {
      allCharmsIndicesToDelete.add(allCharmsIdx);
    }
  }

  // Remove notebooks by index AND notes by noteId
  const filteredCharms = allCharmsList.filter((charm: any, i) => {
    // Remove if it's a notebook to delete (by index)
    if (allCharmsIndicesToDelete.has(i)) return false;
    // Remove if it's a note to delete (by noteId)
    const noteId = charm?.noteId;
    if (noteId && noteIdsToDelete.includes(noteId)) return false;
    return true;
  });
  allCharms.set(filteredCharms);

  selectedNotebookIndices.set([]);
  showDeleteNotebookModal.set(false);
});

// Handler to cancel delete notebooks
const cancelDeleteNotebooks = handler<
  Record<string, never>,
  {
    showDeleteNotebookModal: Cell<boolean>;
  }
>((_, { showDeleteNotebookModal }) => {
  showDeleteNotebookModal.set(false);
});

// Handler to clone selected notebooks (shallow copy - shares note references)
const cloneSelectedNotebooks = handler<
  Record<string, never>,
  {
    notebooks: Cell<NotebookCharm[]>;
    selectedNotebookIndices: Cell<number[]>;
    allCharms: Cell<NoteCharm[]>;
  }
>((_, { notebooks, selectedNotebookIndices, allCharms }) => {
  const selected = selectedNotebookIndices.get();
  const notebooksList = notebooks.get();

  // Collect copies first, then batch push (reduces N reactive cycles to 1)
  const copies: NoteCharm[] = [];
  for (const idx of selected) {
    const original = notebooksList[idx];
    if (original) {
      // Extract just the base title (strip emoji and count)
      const rawTitle = (original as any)?.[NAME] ?? original?.title ??
        "Notebook";
      const baseTitle = rawTitle.replace(/^📓\s*/, "").replace(
        /\s*\(\d+\)$/,
        "",
      );

      copies.push(Notebook({
        title: baseTitle + " (Clone)",
        notes: [...(original?.notes ?? [])], // Shallow copy - reference same notes
      }) as unknown as NoteCharm);
    }
  }
  allCharms.push(...copies);
  selectedNotebookIndices.set([]);
});

// Handler to duplicate selected notebooks (deep copy - new independent note instances)
const duplicateSelectedNotebooks = handler<
  Record<string, never>,
  {
    notebooks: Cell<NotebookCharm[]>;
    selectedNotebookIndices: Cell<number[]>;
    allCharms: Cell<NoteCharm[]>;
  }
>((_, { notebooks, selectedNotebookIndices, allCharms }) => {
  const selected = selectedNotebookIndices.get();
  const notebooksList = notebooks.get();

  const newItems: NoteCharm[] = [];

  for (const idx of selected) {
    const original = notebooksList[idx];
    if (original) {
      // Create NEW note instances for each note in the notebook
      const newNotes = (original.notes ?? []).map((note) =>
        Note({
          title: note.title ?? "Note",
          content: note.content ?? "",
          isHidden: true,
          noteId: generateId(),
        }) as unknown as NoteCharm
      );

      // Add new notes to collection (visible in All Notes)
      newItems.push(...newNotes);

      // Extract just the base title (strip emoji and count)
      const rawTitle = (original as any)?.[NAME] ?? original?.title ??
        "Notebook";
      const baseTitle = rawTitle.replace(/^📓\s*/, "").replace(
        /\s*\(\d+\)$/,
        "",
      );

      // Create new notebook with the new independent notes
      newItems.push(Notebook({
        title: baseTitle + " (Copy)",
        notes: newNotes,
      }) as unknown as NoteCharm);
    }
  }

  allCharms.push(...newItems);
  selectedNotebookIndices.set([]);
});

// Handler to export selected notebooks' notes and show in modal
const exportSelectedNotebooks = handler<
  Record<string, never>,
  {
    notebooks: Cell<NotebookCharm[]>;
    selectedNotebookIndices: Cell<number[]>;
    showExportNotebooksModal: Cell<boolean>;
    exportNotebooksMarkdown: Cell<string>;
  }
>((
  _,
  {
    notebooks,
    selectedNotebookIndices,
    showExportNotebooksModal,
    exportNotebooksMarkdown,
  },
) => {
  const selected = selectedNotebookIndices.get();
  const notebooksList = notebooks.get();

  // Collect all notes from selected notebooks with notebook info
  const allNotes: { title: string; content: string; notebookName: string }[] =
    [];
  for (const idx of selected) {
    const nb = notebooksList[idx];
    const rawName = (nb as any)?.[NAME] ?? nb?.title ?? "Untitled";
    const cleanName = rawName.replace(/^📓\s*/, "").replace(/\s*\(\d+\)$/, "");
    const nbNotes = nb?.notes ?? [];
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

  // Format as markdown with notebook info
  if (allNotes.length > 0) {
    const lines = allNotes.map((note) => {
      const escapedTitle = note.title.replace(/"/g, "&quot;");
      return `${NOTE_START_MARKER} title="${escapedTitle}" notebooks="${note.notebookName}" -->\n\n${note.content}\n\n${NOTE_END_MARKER}`;
    });

    // Add timestamp header (ignored by import regex which only looks for COMMON_NOTE_START)
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

// Handler to close export notebooks modal
const closeExportNotebooksModal = handler<
  Record<string, never>,
  {
    showExportNotebooksModal: Cell<boolean>;
    exportNotebooksMarkdown: Cell<string>;
    selectedNotebookIndices: Cell<number[]>;
  }
>((
  _,
  {
    showExportNotebooksModal,
    exportNotebooksMarkdown,
    selectedNotebookIndices,
  },
) => {
  showExportNotebooksModal.set(false);
  exportNotebooksMarkdown.set("");
  selectedNotebookIndices.set([]);
});

// Handler to toggle notebook checkbox selection with shift-click support
const toggleNotebookCheckbox = handler<
  { shiftKey?: boolean },
  {
    index: number;
    selectedNotebookIndices: Cell<number[]>;
    lastSelectedNotebookIndex: Cell<number>;
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

// Handler to toggle note checkbox selection with shift-click support
const toggleNoteCheckbox = handler<
  { shiftKey?: boolean },
  {
    index: number;
    selectedIndices: Cell<number[]>;
    lastSelectedIndex: Cell<number>;
  }
>((event, { index, selectedIndices, lastSelectedIndex }) => {
  const current = selectedIndices.get();
  const lastIdx = lastSelectedIndex.get();

  if (event?.shiftKey && lastIdx >= 0 && lastIdx !== index) {
    const start = Math.min(lastIdx, index);
    const end = Math.max(lastIdx, index);
    const range: number[] = [];
    for (let i = start; i <= end; i++) {
      range.push(i);
    }
    selectedIndices.set([...new Set([...current, ...range])]);
  } else {
    const idx = current.indexOf(index);
    if (idx >= 0) {
      selectedIndices.set(current.filter((i: number) => i !== index));
    } else {
      selectedIndices.set([...current, index]);
    }
  }
  lastSelectedIndex.set(index);
});

// Handler to create notebook from prompt and add/move selected notes
const createNotebookFromPrompt = handler<
  void,
  {
    newNotebookName: Cell<string>;
    showNewNotebookPrompt: Cell<boolean>;
    pendingNotebookAction: Cell<"add" | "move" | "">;
    selectedIndices: Cell<number[]>;
    notes: Cell<NoteCharm[]>;
    allCharms: Cell<NoteCharm[]>;
    notebooks: Cell<NotebookCharm[]>;
  }
>((_, state) => {
  const {
    newNotebookName,
    showNewNotebookPrompt,
    pendingNotebookAction,
    selectedIndices,
    notes,
    allCharms,
    notebooks,
  } = state;

  const name = newNotebookName.get().trim() || "New Notebook";
  const action = pendingNotebookAction.get();

  // Gather selected notes and noteIds
  const selected = selectedIndices.get();
  const selectedNotes: NoteCharm[] = [];
  const selectedNoteIds: string[] = [];

  for (const idx of selected) {
    const note = notes.key(idx).get();
    if (note) {
      selectedNotes.push(note);
      const noteId = (note as any)?.noteId;
      if (noteId) selectedNoteIds.push(noteId);
    }
  }

  // Create notebook with notes directly (simpler approach)
  const newNotebook = Notebook({ title: name, notes: selectedNotes });
  allCharms.push(newNotebook as unknown as NoteCharm);

  // Mark selected notes as hidden
  for (const idx of selected) {
    notes.key(idx).key("isHidden").set(true);
  }

  // For move: also remove from existing notebooks
  if (action === "move") {
    const notebooksList = notebooks.get();
    for (let nbIdx = 0; nbIdx < notebooksList.length; nbIdx++) {
      const nbCell = notebooks.key(nbIdx);
      const nbNotesCell = nbCell.key("notes");
      const nbNotes = nbNotesCell.get() ?? [];
      const filtered = nbNotes.filter((n: any) =>
        !selectedNoteIds.includes(n?.noteId)
      );
      if (filtered.length !== nbNotes.length) {
        nbNotesCell.set(filtered);
      }
    }
  }

  // Clean up state
  selectedIndices.set([]);
  newNotebookName.set("");
  pendingNotebookAction.set("");
  showNewNotebookPrompt.set(false);
});

// Handler to cancel new notebook prompt
const cancelNewNotebookPrompt = handler<
  void,
  {
    showNewNotebookPrompt: Cell<boolean>;
    newNotebookName: Cell<string>;
    pendingNotebookAction: Cell<"add" | "move" | "">;
    selectedNotebook: Cell<string>;
    selectedMoveNotebook: Cell<string>;
  }
>((_, state) => {
  state.showNewNotebookPrompt.set(false);
  state.newNotebookName.set("");
  state.pendingNotebookAction.set("");
  state.selectedNotebook.set("");
  state.selectedMoveNotebook.set("");
});

// Handler to open Export All modal - computes export on-demand for performance
const openExportAllModal = handler<
  void,
  {
    showExportAllModal: Cell<boolean>;
    allCharms: Cell<NoteCharm[]>;
    notebooks: Cell<NotebookCharm[]>;
    exportedMarkdown: Cell<string>;
  }
>((_, { showExportAllModal, allCharms, notebooks, exportedMarkdown }) => {
  // Compute export ONLY when modal opens (lazy evaluation)
  // Use plain function version (lift() doesn't work in handlers)
  // Pass allCharms as third param for reliable isHidden lookup
  const allCharmsArray = [...allCharms.get()];
  const result = filterAndFormatNotesPlain(
    allCharmsArray,
    [...notebooks.get()],
    allCharmsArray,
  );
  exportedMarkdown.set(result.markdown);
  showExportAllModal.set(true);
});

// Handler to close Export All modal
const closeExportAllModal = handler<
  void,
  { showExportAllModal: Cell<boolean> }
>((_, { showExportAllModal }) => {
  showExportAllModal.set(false);
});

// Handler to open Import modal
const openImportModal = handler<
  void,
  { showImportModal: Cell<boolean> }
>((_, { showImportModal }) => {
  showImportModal.set(true);
});

// Handler to close Import modal
const closeImportModal = handler<
  void,
  {
    showImportModal: Cell<boolean>;
    importMarkdown: Cell<string>;
    showPasteSection?: Cell<boolean>;
  }
>((_, { showImportModal, importMarkdown, showPasteSection }) => {
  showImportModal.set(false);
  importMarkdown.set("");
  // Reset paste section visibility for next time modal opens
  showPasteSection?.set(true);
});

// Plain function to get notebooks containing a note (with name and reference for navigation)
// Using plain function instead of lift for more consistent proxy resolution
function _getNoteNotebooksPlain(
  note: NoteCharm,
  notebooks: NotebookCharm[],
): { name: string; notebook: NotebookCharm }[] {
  // Use JSON.parse(JSON.stringify()) to fully resolve proxy values
  const noteId = resolveValue((note as any)?.noteId);
  if (!noteId) return [];

  const result: { name: string; notebook: NotebookCharm }[] = [];
  for (const nb of notebooks) {
    const nbNotes = (nb as any)?.notes ?? [];

    for (const n of nbNotes) {
      // Compare resolved string values
      if (resolveValue((n as any)?.noteId) === noteId) {
        const name = (nb as any)?.[NAME] ?? (nb as any)?.title ?? "Untitled";
        // Strip the 📓 prefix and note count suffix for cleaner display
        const cleanName = name.replace(/^📓\s*/, "").replace(
          /\s*\(\d+\)$/,
          "",
        );
        result.push({ name: cleanName, notebook: nb });
        break;
      }
    }
  }
  return result;
}

const NotesImportExport = pattern<Input, Output>(({ importMarkdown }) => {
  const { allCharms } = wish<{ allCharms: AllCharmsType }>("/");

  // Filter to only notes (charms with title and content)
  const notes = computed(() =>
    allCharms.filter(
      (charm) => charm?.title !== undefined && charm?.content !== undefined,
    )
  );

  // Filter to only notebooks using 📓 marker in NAME
  // (NAME is the only property reliably accessible through proxy)
  const notebooks = computed(() =>
    allCharms.filter((charm: any) => {
      const name = charm?.[NAME];
      return typeof name === "string" && name.startsWith("📓");
    }) as unknown as NotebookCharm[]
  );

  // Selection state for notes multi-select
  const selectedIndices = Cell.of<number[]>([]);
  const selectedNotebook = Cell.of<string>("");
  const selectedMoveNotebook = Cell.of<string>("");
  const lastSelectedIndex = Cell.of<number>(-1); // For shift-click range selection

  // Computed helper for notes selection count
  const selectedCount = computed(() => selectedIndices.get().length);
  const hasSelection = computed(() => selectedIndices.get().length > 0);

  // Selection state for notebooks multi-select
  const selectedNotebookIndices = Cell.of<number[]>([]);
  const lastSelectedNotebookIndex = Cell.of<number>(-1);

  // Computed helper for notebooks selection count
  const selectedNotebookCount = computed(() =>
    selectedNotebookIndices.get().length
  );
  const hasNotebookSelection = computed(() =>
    selectedNotebookIndices.get().length > 0
  );

  // State for "New Notebook" prompt modal (for add/move to notebook flows)
  const showNewNotebookPrompt = Cell.of<boolean>(false);
  const newNotebookName = Cell.of<string>("");
  const pendingNotebookAction = Cell.of<"add" | "move" | "">(""); // Track which action triggered the modal

  // State for standalone "New Notebook" modal (from New button)
  const showStandaloneNotebookPrompt = Cell.of<boolean>(false);
  const standaloneNotebookTitle = Cell.of<string>("");

  // State for duplicate detection modal during import
  const showDuplicateModal = Cell.of<boolean>(false);
  const detectedDuplicates = Cell.of<DetectedDuplicate[]>([]);
  const pendingImportData = Cell.of<string>("");

  // State for duplicate detection modal when adding notes to notebook
  const showNotebookDuplicateModal = Cell.of<boolean>(false);
  const notebookDuplicates = Cell.of<NotebookDuplicate[]>([]);
  const pendingAddNotebookIndex = Cell.of<number>(-1);
  const nonDuplicateNotes = Cell.of<{ note: NoteCharm; idx: number }[]>([]);

  // State for delete notebook confirmation modal
  const showDeleteNotebookModal = Cell.of<boolean>(false);

  // State for export notebooks modal
  const showExportNotebooksModal = Cell.of<boolean>(false);
  const exportNotebooksMarkdown = Cell.of<string>("");

  // State for Export All modal
  const showExportAllModal = Cell.of<boolean>(false);

  // State for Import modal
  const showImportModal = Cell.of<boolean>(false);
  const importStatus = Cell.of<string>(""); // Status message during import

  // State for Import progress modal (super modal in front of others)
  const showImportProgressModal = Cell.of<boolean>(false);
  const importProgressMessage = Cell.of<string>("Importing notes...");
  const importComplete = Cell.of<boolean>(false);
  // State to hide paste section when Upload File button is clicked
  const showPasteSection = Cell.of<boolean>(true);

  // Computed items for ct-select dropdowns (notebooks + "New Notebook...")
  // ct-select has proper bidirectional DOM sync, unlike native <select>
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

  // Helper to generate export filename with timestamp
  const getExportFilename = (prefix: string) => {
    const now = new Date();
    const timestamp = now.toISOString().slice(0, 19).replace(/[T:]/g, "-");
    return `${prefix}-${timestamp}.md`;
  };

  // Computed filenames for exports (re-evaluate each time modal is shown)
  const notesExportFilename = computed(() => getExportFilename("notes-export"));
  const notebooksExportFilename = computed(() =>
    getExportFilename("notebooks-export")
  );

  // Pre-compute all note memberships in ONE central reactive expression
  // This ensures proper dependency tracking when notebooks are added/removed
  const noteMemberships = computed(() => {
    const result: Record<
      string,
      Array<{ name: string; notebook: NotebookCharm }>
    > = {};
    for (const nb of notebooks) {
      const nbNotes = (nb as any)?.notes ?? [];
      const rawName = (nb as any)?.[NAME] ?? (nb as any)?.title ?? "Untitled";
      const cleanName = rawName
        .replace(/^📓\s*/, "")
        .replace(/\s*\(\d+\)$/, "");
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

  // Combine notes with their membership data at pattern level
  // This ensures the map sees changes when either notes or memberships update
  type NoteWithMemberships = {
    note: NoteCharm;
    memberships: Array<{ name: string; notebook: NotebookCharm }>;
  };
  const notesWithMemberships = computed((): NoteWithMemberships[] => {
    // Read noteMemberships to establish dependency (JSON to get plain object)
    const membershipMap = JSON.parse(JSON.stringify(noteMemberships)) as Record<
      string,
      Array<{ name: string; notebook: NotebookCharm }>
    >;
    return notes.map((note: NoteCharm) => {
      const noteId = resolveValue((note as any)?.noteId);
      const memberships = noteId ? (membershipMap[noteId] ?? []) : [];
      return { note, memberships };
    });
  });

  // Compute parent notebook memberships for each notebook
  // A notebook's "memberships" are notebooks that contain it in their notes or childNotebooks arrays
  const notebookMemberships = computed(() => {
    const result: Record<
      string,
      Array<{ name: string; notebook: NotebookCharm }>
    > = {};
    for (const nb of notebooks) {
      const rawName = (nb as any)?.[NAME] ?? (nb as any)?.title ?? "Untitled";
      const cleanName = rawName
        .replace(/^📓\s*/, "")
        .replace(/\s*\(\d+\)$/, "");

      // Check notes array for nested notebooks (notebooks dropped into other notebooks)
      const nbNotes = (nb as any)?.notes ?? [];
      for (const item of nbNotes) {
        // Check if item is a notebook (has isNotebook property or NAME starts with 📓)
        const itemName = (item as any)?.[NAME] ?? (item as any)?.title ?? "";
        const isChildNotebook = (item as any)?.isNotebook ||
          (typeof itemName === "string" && itemName.startsWith("📓"));
        if (isChildNotebook && itemName) {
          if (!result[itemName]) result[itemName] = [];
          // Avoid duplicate entries
          const alreadyAdded = result[itemName].some(
            (m) => m.name === cleanName,
          );
          if (!alreadyAdded) {
            result[itemName].push({ name: cleanName, notebook: nb });
          }
        }
      }

      // Also check childNotebooks array (v2 hierarchical format)
      const childNotebooks = (nb as any)?.childNotebooks ?? [];
      for (const child of childNotebooks) {
        const childName = (child as any)?.[NAME] ?? (child as any)?.title ?? "";
        if (childName) {
          if (!result[childName]) result[childName] = [];
          // Avoid duplicate entries
          const alreadyAdded = result[childName].some(
            (m) => m.name === cleanName,
          );
          if (!alreadyAdded) {
            result[childName].push({ name: cleanName, notebook: nb });
          }
        }
      }
    }
    return result;
  });

  // Combine notebooks with their membership data at pattern level
  type NotebookWithMemberships = {
    notebook: NotebookCharm;
    memberships: Array<{ name: string; notebook: NotebookCharm }>;
  };
  const notebooksWithMemberships = computed((): NotebookWithMemberships[] => {
    // Read notebookMemberships directly - don't use JSON.parse/stringify which loses Cell references
    // Simply reading the computed value establishes the dependency
    const membershipMap = notebookMemberships as unknown as Record<
      string,
      Array<{ name: string; notebook: NotebookCharm }>
    >;
    return notebooks.map((notebook: NotebookCharm) => {
      const notebookName = (notebook as any)?.[NAME] ??
        (notebook as any)?.title ?? "";
      const memberships = notebookName
        ? (membershipMap[notebookName] ?? [])
        : [];
      return { notebook, memberships };
    });
  });

  // noteCount derived from notes array for reactive UI display
  // Use lift() for proper reactive tracking (computed() doesn't track array.length correctly)
  const noteCount = lift((args: { n: NoteCharm[] }) => args.n.length)({
    n: notes,
  });
  const notebookCount = lift((args: { n: NotebookCharm[] }) => args.n.length)({
    n: notebooks,
  });

  // Boolean display helpers using lift() - needed because computed(() => array.length > 0)
  // doesn't properly track dependencies on computed arrays
  const notesDisplayStyle = lift((args: { n: NoteCharm[] }) =>
    args.n.length > 0 ? "flex" : "none"
  )({ n: notes });
  const notebooksDisplayStyle = lift((args: { n: NotebookCharm[] }) =>
    args.n.length > 0 ? "flex" : "none"
  )({ n: notebooks });

  // exportedMarkdown is computed on-demand when Export All modal opens (lazy for performance)
  const exportedMarkdown = Cell.of<string>("");

  return {
    [NAME]: computed(() => `All Notes (${noteCount} notes)`),
    [UI]: (
      <ct-screen>
        <ct-toolbar slot="header" sticky>
          <div slot="end" style={{ display: "flex", gap: "8px" }}>
            <ct-button
              size="sm"
              variant="ghost"
              onClick={openImportModal({ showImportModal })}
              style={{
                padding: "6px 12px",
                fontSize: "13px",
                fontWeight: "500",
                color: "var(--ct-color-text-secondary, #6e6e73)",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <span>↓</span>
              <span>Import</span>
            </ct-button>
            <ct-button
              size="sm"
              variant="ghost"
              onClick={openExportAllModal({
                showExportAllModal,
                allCharms,
                notebooks,
                exportedMarkdown,
              })}
              style={{
                padding: "6px 12px",
                fontSize: "13px",
                fontWeight: "500",
                color: "var(--ct-color-text-secondary, #6e6e73)",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <span>💾</span>
              <span>Export All</span>
            </ct-button>
          </div>
        </ct-toolbar>

        <ct-vscroll flex showScrollbar>
          <ct-vstack gap="6" padding="6">
            {/* Notes Index Section */}
            <ct-card>
              <ct-vstack gap="4">
                {/* Header */}
                <div
                  style={{
                    display: "flex",
                    width: "100%",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span
                    style={{ margin: 0, fontSize: "15px", fontWeight: "600" }}
                  >
                    All Notes ({noteCount})
                  </span>
                  <ct-button
                    size="sm"
                    variant="ghost"
                    title="New Note"
                    onClick={createNote({ allCharms })}
                    style={{
                      padding: "6px 12px",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <span style={{ fontSize: "14px" }}>📝</span>
                    <span style={{ fontSize: "13px", fontWeight: "500" }}>
                      New
                    </span>
                  </ct-button>
                </div>

                {/* Table Header - only show when there are notes */}
                <div
                  style={{
                    display: notesDisplayStyle,
                    width: "100%",
                    padding: "12px",
                    background: "var(--ct-color-bg-secondary, #f5f5f7)",
                    borderRadius: "8px",
                    alignItems: "center",
                    fontSize: "13px",
                    fontWeight: "500",
                    color: "var(--ct-color-text-secondary, #6e6e73)",
                    boxSizing: "border-box",
                  }}
                >
                  <div style={{ width: "32px", flexShrink: 0 }}>
                    <ct-checkbox
                      checked={computed(() =>
                        notes.length > 0 &&
                        selectedIndices.get().length === notes.length
                      )}
                      onct-change={computed(() =>
                        selectedIndices.get().length === notes.length
                          ? deselectAll({ selectedIndices })
                          : selectAll({ notes, selectedIndices })
                      )}
                    />
                  </div>
                  <div style={{ flex: "0 1 auto" }}>Notes</div>
                  <div style={{ flex: "1 1 auto", minWidth: 0 }} />
                  <div
                    onClick={toggleAllNotesVisibility({ notes })}
                    style={{
                      width: "70px",
                      flexShrink: 0,
                      textAlign: "center",
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                    title="Click to toggle all"
                  >
                    Show/Hide
                  </div>
                </div>

                {/* Notes List - using notesWithMemberships for reactive pill updates */}
                <ct-vstack gap="0">
                  {notesWithMemberships.map(({ note, memberships }, index) => (
                    <ct-hstack
                      padding="3"
                      style={{
                        borderBottom:
                          "1px solid var(--ct-color-border, #e5e5e7)",
                        alignItems: "center",
                        background: computed(() =>
                          selectedIndices.get().includes(index)
                            ? "var(--ct-color-bg-secondary, #f5f5f7)"
                            : "transparent"
                        ),
                      }}
                    >
                      <div
                        style={{
                          width: "32px",
                          flexShrink: 0,
                          cursor: "pointer",
                          userSelect: "none",
                          display: "flex",
                          alignItems: "center",
                        }}
                        onClick={toggleNoteCheckbox({
                          index,
                          selectedIndices,
                          lastSelectedIndex,
                        })}
                      >
                        <ct-checkbox
                          checked={computed(() =>
                            selectedIndices.get().includes(index)
                          )}
                        />
                      </div>
                      <div
                        style={{
                          flex: "0 1 auto",
                          overflow: "hidden",
                          display: "flex",
                          alignItems: "center",
                        }}
                      >
                        <ct-cell-context $cell={note} inline>
                          <ct-cell-link $cell={note} />
                        </ct-cell-context>
                      </div>
                      <div
                        style={{
                          flex: "1 1 auto",
                          display: "flex",
                          alignItems: "center",
                          marginLeft: "12px",
                          marginRight: "12px",
                        }}
                      >
                        <ct-hstack
                          gap="2"
                          style={{
                            flexWrap: "wrap",
                            alignItems: "center",
                            marginTop: "2px",
                          }}
                        >
                          {/* Memberships are pre-computed at pattern level for reactive updates */}
                          {memberships.map((item) => (
                            <span
                              onClick={goToNotebook({
                                notebook: item.notebook,
                              })}
                              title={item.name}
                              style={{
                                fontSize: "11px",
                                padding: "2px 8px",
                                background:
                                  "var(--ct-color-bg-tertiary, #e5e5e7)",
                                borderRadius: "10px",
                                cursor: "pointer",
                                maxWidth: "80px",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                display: "inline-block",
                              }}
                            >
                              {item.name}
                            </span>
                          ))}
                        </ct-hstack>
                      </div>
                      <div
                        style={{
                          width: "70px",
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <ct-switch
                          checked={lift((args: { n: unknown }) =>
                            !((args.n as any)?.isHidden ?? false)
                          )({ n: note })}
                          onct-change={toggleNoteVisibility({ note })}
                        />
                      </div>
                    </ct-hstack>
                  ))}
                </ct-vstack>

                {/* Action Bar - Use CSS display to keep DOM alive (preserves handler streams) */}
                <ct-hstack
                  padding="3"
                  gap="3"
                  style={{
                    display: computed(() => (hasSelection ? "flex" : "none")),
                    background: "var(--ct-color-bg-secondary, #f5f5f7)",
                    borderRadius: "8px",
                    alignItems: "center",
                    marginTop: "8px",
                  }}
                >
                  <span style={{ fontSize: "13px", fontWeight: "500" }}>
                    {selectedCount} selected
                  </span>
                  <span style={{ flex: 1 }} />
                  <ct-select
                    $value={selectedNotebook}
                    items={notebookAddItems}
                    placeholder="Add to notebook..."
                    style={{ width: "160px" }}
                    onChange={addToNotebook({
                      notebooks,
                      notes,
                      selectedIndices,
                      selectedNotebook,
                      showNewNotebookPrompt,
                      pendingNotebookAction,
                      showNotebookDuplicateModal,
                      notebookDuplicates,
                      pendingAddNotebookIndex,
                      nonDuplicateNotes,
                    })}
                  />
                  <ct-select
                    $value={selectedMoveNotebook}
                    items={notebookMoveItems}
                    placeholder="Move to..."
                    style={{ width: "140px" }}
                    onChange={moveToNotebook({
                      notebooks,
                      notes,
                      selectedIndices,
                      selectedMoveNotebook,
                      showNewNotebookPrompt,
                      pendingNotebookAction,
                    })}
                  />
                  <ct-button
                    size="sm"
                    variant="ghost"
                    onClick={duplicateSelectedNotes({
                      notes,
                      selectedIndices,
                      allCharms,
                    })}
                  >
                    Duplicate
                  </ct-button>
                  <ct-button
                    size="sm"
                    variant="ghost"
                    onClick={deleteSelectedNotes({
                      notes,
                      selectedIndices,
                      allCharms,
                      notebooks,
                    })}
                    style={{ color: "var(--ct-color-danger, #dc3545)" }}
                  >
                    Delete
                  </ct-button>
                </ct-hstack>
              </ct-vstack>
            </ct-card>

            {/* Notebooks Section */}
            <ct-card>
              <ct-vstack gap="4">
                {/* Header */}
                <div
                  style={{
                    display: "flex",
                    width: "100%",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span
                    style={{ margin: 0, fontSize: "15px", fontWeight: "600" }}
                  >
                    All Notebooks ({notebookCount})
                  </span>
                  <ct-button
                    size="sm"
                    variant="ghost"
                    title="New Notebook"
                    onClick={showStandaloneNotebookModal({
                      showStandaloneNotebookPrompt,
                    })}
                    style={{
                      padding: "6px 12px",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <span style={{ fontSize: "14px" }}>📓</span>
                    <span style={{ fontSize: "13px", fontWeight: "500" }}>
                      New
                    </span>
                  </ct-button>
                </div>

                {/* Table Header - only show when there are notebooks */}
                <div
                  style={{
                    display: notebooksDisplayStyle,
                    width: "100%",
                    padding: "12px",
                    background: "var(--ct-color-bg-secondary, #f5f5f7)",
                    borderRadius: "8px",
                    alignItems: "center",
                    fontSize: "13px",
                    fontWeight: "500",
                    color: "var(--ct-color-text-secondary, #6e6e73)",
                    boxSizing: "border-box",
                  }}
                >
                  <div style={{ width: "32px", flexShrink: 0 }}>
                    <ct-checkbox
                      checked={computed(() =>
                        notebooks.length > 0 &&
                        selectedNotebookIndices.get().length ===
                          notebooks.length
                      )}
                      onct-change={computed(() =>
                        selectedNotebookIndices.get().length ===
                            notebooks.length
                          ? deselectAllNotebooks({
                            selectedNotebookIndices,
                          })
                          : selectAllNotebooks({
                            notebooks,
                            selectedNotebookIndices,
                          })
                      )}
                    />
                  </div>
                  <div style={{ flex: "0 1 auto" }}>Notebooks</div>
                  <div style={{ flex: "1 1 auto", minWidth: 0 }} />
                  <div
                    onClick={toggleAllNotebooksVisibility({ notebooks })}
                    style={{
                      width: "70px",
                      flexShrink: 0,
                      textAlign: "center",
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                    title="Click to toggle all"
                  >
                    Show/Hide
                  </div>
                </div>

                {/* Notebooks List - using notebooksWithMemberships for reactive pill updates */}
                <ct-vstack gap="0">
                  {notebooksWithMemberships.map(
                    ({ notebook, memberships }, index) => (
                      <ct-hstack
                        padding="3"
                        style={{
                          borderBottom:
                            "1px solid var(--ct-color-border, #e5e5e7)",
                          alignItems: "center",
                          background: computed(() =>
                            selectedNotebookIndices.get().includes(index)
                              ? "var(--ct-color-bg-secondary, #f5f5f7)"
                              : "transparent"
                          ),
                        }}
                      >
                        <div
                          style={{
                            width: "32px",
                            flexShrink: 0,
                            cursor: "pointer",
                            userSelect: "none",
                            display: "flex",
                            alignItems: "center",
                          }}
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
                        <div
                          style={{
                            flex: "0 1 auto",
                            overflow: "hidden",
                            display: "flex",
                            alignItems: "center",
                          }}
                        >
                          <ct-cell-context $cell={notebook} inline>
                            <ct-cell-link $cell={notebook} />
                          </ct-cell-context>
                        </div>
                        <div
                          style={{
                            flex: "1 1 auto",
                            display: "flex",
                            alignItems: "center",
                            marginLeft: "12px",
                            marginRight: "12px",
                          }}
                        >
                          <ct-hstack
                            gap="2"
                            style={{
                              flexWrap: "wrap",
                              alignItems: "center",
                              marginTop: "2px",
                            }}
                          >
                            {/* Parent notebook memberships pills */}
                            {memberships.map((item) => (
                              <span
                                onClick={goToNotebook({
                                  notebook: item.notebook,
                                })}
                                title={item.name}
                                style={{
                                  fontSize: "11px",
                                  padding: "2px 8px",
                                  background:
                                    "var(--ct-color-bg-tertiary, #e5e5e7)",
                                  borderRadius: "10px",
                                  cursor: "pointer",
                                  maxWidth: "80px",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  display: "inline-block",
                                }}
                              >
                                {item.name}
                              </span>
                            ))}
                          </ct-hstack>
                        </div>
                        <div
                          style={{
                            width: "70px",
                            flexShrink: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <ct-switch
                            checked={lift(
                              (args: {
                                charms: unknown[];
                                nb: unknown;
                              }) => {
                                // Find the notebook in allCharms by NAME and read its isHidden
                                const nbName = (args.nb as any)?.[NAME] ?? "";
                                const found = args.charms.find((c: any) => {
                                  const name = c?.[NAME];
                                  return name === nbName;
                                });
                                return !((found as any)?.isHidden ?? false);
                              },
                            )({
                              charms: allCharms,
                              nb: notebook,
                            })}
                            onct-change={toggleNotebookVisibility({
                              notebook,
                            })}
                          />
                        </div>
                      </ct-hstack>
                    ),
                  )}
                </ct-vstack>

                {/* Action Bar - Use CSS display to keep DOM alive (preserves handler streams) */}
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
                    marginTop: "8px",
                  }}
                >
                  <span style={{ fontSize: "13px", fontWeight: "500" }}>
                    {selectedNotebookCount} selected
                  </span>
                  <span style={{ flex: 1 }} />
                  <ct-button
                    size="sm"
                    variant="ghost"
                    onClick={exportSelectedNotebooks({
                      notebooks,
                      selectedNotebookIndices,
                      showExportNotebooksModal,
                      exportNotebooksMarkdown,
                    })}
                  >
                    <span>↑</span> Export
                  </ct-button>
                  <ct-button
                    size="sm"
                    variant="ghost"
                    onClick={cloneSelectedNotebooks({
                      notebooks,
                      selectedNotebookIndices,
                      allCharms,
                    })}
                  >
                    Clone
                  </ct-button>
                  <ct-button
                    size="sm"
                    variant="ghost"
                    onClick={duplicateSelectedNotebooks({
                      notebooks,
                      selectedNotebookIndices,
                      allCharms,
                    })}
                  >
                    Duplicate
                  </ct-button>
                  <ct-button
                    size="sm"
                    variant="ghost"
                    onClick={confirmDeleteNotebooks({
                      selectedNotebookIndices,
                      showDeleteNotebookModal,
                    })}
                    style={{ color: "var(--ct-color-danger, #dc3545)" }}
                  >
                    Delete
                  </ct-button>
                </ct-hstack>
              </ct-vstack>
            </ct-card>
          </ct-vstack>
        </ct-vscroll>

        {/* New Notebook Prompt Modal - Use CSS display to keep DOM alive for reactivity */}
        <div
          style={{
            display: computed(() =>
              showNewNotebookPrompt.get() ? "flex" : "none"
            ),
            position: "fixed",
            inset: "0",
            background: "rgba(0,0,0,0.5)",
            alignItems: "center",
            justifyContent: "center",
            zIndex: "9999",
          }}
        >
          <ct-card style={{ minWidth: "320px", padding: "24px" }}>
            <ct-vstack gap="4">
              <h3 style={{ margin: 0 }}>New Notebook</h3>
              <ct-input
                $value={newNotebookName}
                placeholder="Enter notebook name..."
              />
              <ct-hstack gap="2" style={{ justifyContent: "flex-end" }}>
                <ct-button
                  variant="ghost"
                  onClick={cancelNewNotebookPrompt({
                    showNewNotebookPrompt,
                    newNotebookName,
                    pendingNotebookAction,
                    selectedNotebook,
                    selectedMoveNotebook,
                  })}
                >
                  Cancel
                </ct-button>
                <ct-button
                  variant="primary"
                  onClick={createNotebookFromPrompt({
                    newNotebookName,
                    showNewNotebookPrompt,
                    pendingNotebookAction,
                    selectedIndices,
                    notes,
                    allCharms,
                    notebooks,
                  })}
                >
                  Create
                </ct-button>
              </ct-hstack>
            </ct-vstack>
          </ct-card>
        </div>

        {/* Standalone New Notebook Modal - for the "New" button in Notebooks section */}
        <div
          style={{
            display: computed(() =>
              showStandaloneNotebookPrompt.get() ? "flex" : "none"
            ),
            position: "fixed",
            inset: "0",
            background: "rgba(0,0,0,0.5)",
            alignItems: "center",
            justifyContent: "center",
            zIndex: "9999",
          }}
        >
          <ct-card style={{ minWidth: "320px", padding: "24px" }}>
            <ct-vstack gap="4">
              <h3 style={{ margin: 0 }}>New Notebook</h3>
              <ct-input
                $value={standaloneNotebookTitle}
                placeholder="Enter notebook name..."
              />
              <ct-hstack gap="2" style={{ justifyContent: "flex-end" }}>
                <ct-button
                  variant="ghost"
                  onClick={cancelStandaloneNotebookPrompt({
                    showStandaloneNotebookPrompt,
                    standaloneNotebookTitle,
                  })}
                >
                  Cancel
                </ct-button>
                <ct-button
                  variant="ghost"
                  onClick={createStandaloneNotebookAndContinue({
                    standaloneNotebookTitle,
                    allCharms,
                  })}
                >
                  Create Another
                </ct-button>
                <ct-button
                  variant="primary"
                  onClick={createStandaloneNotebookAndOpen({
                    standaloneNotebookTitle,
                    showStandaloneNotebookPrompt,
                    allCharms,
                  })}
                >
                  Create
                </ct-button>
              </ct-hstack>
            </ct-vstack>
          </ct-card>
        </div>

        {/* Duplicate Detection Modal - Use CSS display to keep DOM alive for reactivity */}
        <div
          style={{
            display: computed(() => showDuplicateModal.get() ? "flex" : "none"),
            position: "fixed",
            inset: "0",
            background: "rgba(0,0,0,0.5)",
            alignItems: "center",
            justifyContent: "center",
            zIndex: "9999",
          }}
        >
          <ct-card
            style={{ minWidth: "400px", maxWidth: "500px", padding: "24px" }}
          >
            <ct-vstack gap="4">
              <h3 style={{ margin: 0 }}>Duplicates Found</h3>
              <p
                style={{
                  margin: 0,
                  color: "var(--ct-color-text-secondary, #6e6e73)",
                }}
              >
                The following notes already exist in this space:
              </p>
              <ct-vstack
                gap="2"
                style={{
                  maxHeight: "200px",
                  overflow: "auto",
                  padding: "8px",
                  background: "var(--ct-color-bg-secondary, #f5f5f7)",
                  borderRadius: "8px",
                }}
              >
                {detectedDuplicates.map((dup) => (
                  <ct-hstack
                    style={{
                      padding: "8px 12px",
                      background: "var(--ct-color-bg, white)",
                      borderRadius: "6px",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ flex: 1 }}>{dup.title}</span>
                  </ct-hstack>
                ))}
              </ct-vstack>
              <p style={{ margin: 0, fontSize: "14px" }}>
                What would you like to do?
              </p>
              <ct-hstack
                gap="2"
                style={{ justifyContent: "flex-end", flexWrap: "wrap" }}
              >
                <ct-button
                  variant="ghost"
                  onClick={cancelImport({
                    showDuplicateModal,
                    detectedDuplicates,
                    pendingImportData,
                  })}
                >
                  Cancel
                </ct-button>
                <ct-button
                  variant="secondary"
                  onClick={importSkipDuplicates({
                    pendingImportData,
                    allCharms,
                    notebooks,
                    detectedDuplicates,
                    showDuplicateModal,
                    importMarkdown,
                    importStatus,
                    showImportProgressModal,
                    importProgressMessage,
                    importComplete,
                  })}
                >
                  Skip Duplicates
                </ct-button>
                <ct-button
                  variant="primary"
                  onClick={importAllAsCopies({
                    pendingImportData,
                    allCharms,
                    notebooks,
                    showDuplicateModal,
                    detectedDuplicates,
                    importMarkdown,
                    importStatus,
                    showImportProgressModal,
                    importProgressMessage,
                    importComplete,
                  })}
                >
                  Import as Copies
                </ct-button>
              </ct-hstack>
            </ct-vstack>
          </ct-card>
        </div>

        {/* Notebook Duplicate Modal - When adding notes to notebook */}
        <div
          style={{
            display: computed(() =>
              showNotebookDuplicateModal.get() ? "flex" : "none"
            ),
            position: "fixed",
            inset: "0",
            background: "rgba(0,0,0,0.5)",
            alignItems: "center",
            justifyContent: "center",
            zIndex: "9999",
          }}
        >
          <ct-card
            style={{ minWidth: "400px", maxWidth: "500px", padding: "24px" }}
          >
            <ct-vstack gap="4">
              <h3 style={{ margin: 0 }}>Already in Notebook</h3>
              <p
                style={{
                  margin: 0,
                  color: "var(--ct-color-text-secondary, #6e6e73)",
                }}
              >
                The following notes are already in this notebook:
              </p>
              <ct-vstack
                gap="2"
                style={{
                  maxHeight: "200px",
                  overflow: "auto",
                  padding: "8px",
                  background: "var(--ct-color-bg-secondary, #f5f5f7)",
                  borderRadius: "8px",
                }}
              >
                {notebookDuplicates.map((dup) => (
                  <ct-hstack
                    style={{
                      padding: "8px 12px",
                      background: "var(--ct-color-bg, white)",
                      borderRadius: "6px",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ flex: 1 }}>{dup.title}</span>
                  </ct-hstack>
                ))}
              </ct-vstack>
              <p style={{ margin: 0, fontSize: "14px" }}>
                What would you like to do?
              </p>
              <ct-hstack
                gap="2"
                style={{ justifyContent: "flex-end", flexWrap: "wrap" }}
              >
                <ct-button
                  variant="ghost"
                  onClick={cancelAddToNotebook({
                    showNotebookDuplicateModal,
                    notebookDuplicates,
                    pendingAddNotebookIndex,
                    nonDuplicateNotes,
                    selectedIndices,
                    selectedNotebook,
                  })}
                >
                  Cancel
                </ct-button>
                <ct-button
                  variant="secondary"
                  onClick={addSkipDuplicates({
                    notebooks,
                    notes,
                    selectedIndices,
                    selectedNotebook,
                    showNotebookDuplicateModal,
                    notebookDuplicates,
                    pendingAddNotebookIndex,
                    nonDuplicateNotes,
                  })}
                >
                  Skip
                </ct-button>
                <ct-button
                  variant="primary"
                  onClick={addIncludingDuplicates({
                    notebooks,
                    notes,
                    selectedIndices,
                    selectedNotebook,
                    showNotebookDuplicateModal,
                    notebookDuplicates,
                    pendingAddNotebookIndex,
                    nonDuplicateNotes,
                  })}
                >
                  Add Duplicates
                </ct-button>
              </ct-hstack>
            </ct-vstack>
          </ct-card>
        </div>

        {/* Delete Notebook Confirmation Modal */}
        <div
          style={{
            display: computed(() =>
              showDeleteNotebookModal.get() ? "flex" : "none"
            ),
            position: "fixed",
            inset: "0",
            background: "rgba(0,0,0,0.5)",
            alignItems: "center",
            justifyContent: "center",
            zIndex: "9999",
          }}
        >
          <ct-card
            style={{ width: "280px", padding: "20px", borderRadius: "14px" }}
          >
            <ct-vstack
              gap="4"
              style={{ alignItems: "center", textAlign: "center" }}
            >
              <h3 style={{ margin: 0, fontWeight: "600", fontSize: "17px" }}>
                Delete Notebook?
              </h3>
              <p
                style={{
                  margin: 0,
                  color: "var(--ct-color-text-secondary, #6e6e73)",
                  fontSize: "13px",
                  lineHeight: "1.4",
                }}
              >
                What would you like to do with the notes?
              </p>
              <ct-vstack
                gap="0"
                style={{
                  width: "100%",
                  marginTop: "8px",
                  borderTop: "1px solid var(--ct-color-border, #e5e5e7)",
                }}
              >
                <div
                  onClick={deleteNotebooksOnly({
                    notebooks,
                    selectedNotebookIndices,
                    allCharms,
                    showDeleteNotebookModal,
                  })}
                  style={{
                    padding: "12px",
                    textAlign: "center",
                    cursor: "pointer",
                    borderBottom: "1px solid var(--ct-color-border, #e5e5e7)",
                    color: "#007AFF",
                    fontSize: "17px",
                  }}
                >
                  Keep Notes
                </div>
                <div
                  onClick={deleteNotebooksAndNotes({
                    notebooks,
                    selectedNotebookIndices,
                    allCharms,
                    showDeleteNotebookModal,
                  })}
                  style={{
                    padding: "12px",
                    textAlign: "center",
                    cursor: "pointer",
                    borderBottom: "1px solid var(--ct-color-border, #e5e5e7)",
                    color: "#FF3B30",
                    fontSize: "17px",
                    fontWeight: "500",
                  }}
                >
                  Delete All
                </div>
                <div
                  onClick={cancelDeleteNotebooks({
                    showDeleteNotebookModal,
                  })}
                  style={{
                    padding: "12px",
                    textAlign: "center",
                    cursor: "pointer",
                    color: "#007AFF",
                    fontSize: "17px",
                  }}
                >
                  Cancel
                </div>
              </ct-vstack>
            </ct-vstack>
          </ct-card>
        </div>

        {/* Export Notebooks Modal */}
        <div
          style={{
            display: computed(() =>
              showExportNotebooksModal.get() ? "flex" : "none"
            ),
            position: "fixed",
            inset: "0",
            background: "rgba(0,0,0,0.5)",
            alignItems: "center",
            justifyContent: "center",
            zIndex: "9999",
          }}
        >
          <ct-card
            style={{ minWidth: "500px", maxWidth: "700px", padding: "24px" }}
          >
            <ct-vstack gap="4">
              <h3 style={{ margin: 0 }}>Export Notebooks</h3>
              <ct-code-editor
                $value={exportNotebooksMarkdown}
                language="text/markdown"
                theme="light"
                wordWrap
                lineNumbers
                style={{
                  minHeight: "200px",
                  maxHeight: "400px",
                  overflow: "auto",
                }}
                readonly
              />
              <ct-hstack gap="3" style={{ justifyContent: "flex-end" }}>
                <ct-button
                  variant="ghost"
                  onClick={closeExportNotebooksModal({
                    showExportNotebooksModal,
                    exportNotebooksMarkdown,
                    selectedNotebookIndices,
                  })}
                >
                  Cancel
                </ct-button>
                <ct-file-download
                  $data={exportNotebooksMarkdown}
                  filename={notebooksExportFilename}
                  mime-type="text/markdown"
                  variant="secondary"
                  onct-download-success={closeExportNotebooksModal({
                    showExportNotebooksModal,
                    exportNotebooksMarkdown,
                    selectedNotebookIndices,
                  })}
                >
                  💾 Save
                </ct-file-download>
                <ct-copy-button
                  text={exportNotebooksMarkdown}
                  variant="primary"
                  onct-copy-success={closeExportNotebooksModal({
                    showExportNotebooksModal,
                    exportNotebooksMarkdown,
                    selectedNotebookIndices,
                  })}
                >
                  Copy
                </ct-copy-button>
              </ct-hstack>
            </ct-vstack>
          </ct-card>
        </div>

        {/* Export All Modal */}
        <div
          style={{
            display: computed(() => showExportAllModal.get() ? "flex" : "none"),
            position: "fixed",
            inset: "0",
            background: "rgba(0,0,0,0.5)",
            alignItems: "center",
            justifyContent: "center",
            zIndex: "9999",
          }}
        >
          <ct-card
            style={{ minWidth: "500px", maxWidth: "700px", padding: "24px" }}
          >
            <ct-vstack gap="4">
              <ct-hstack
                style={{
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <h3 style={{ margin: 0 }}>Export All Notes</h3>
                <span
                  style={{
                    fontSize: "14px",
                    color: "var(--ct-color-text-secondary, #6e6e73)",
                  }}
                >
                  {noteCount} notes
                </span>
              </ct-hstack>
              <ct-code-editor
                $value={exportedMarkdown}
                language="text/markdown"
                theme="light"
                wordWrap
                lineNumbers
                style={{
                  minHeight: "200px",
                  maxHeight: "400px",
                  overflow: "auto",
                }}
                readonly
              />
              <ct-hstack gap="3" style={{ justifyContent: "flex-end" }}>
                <ct-button
                  variant="ghost"
                  onClick={closeExportAllModal({ showExportAllModal })}
                >
                  Cancel
                </ct-button>
                <ct-file-download
                  $data={exportedMarkdown}
                  filename={notesExportFilename}
                  mime-type="text/markdown"
                  variant="secondary"
                  onct-download-success={closeExportAllModal({
                    showExportAllModal,
                  })}
                >
                  💾 Save
                </ct-file-download>
                <ct-copy-button
                  text={exportedMarkdown}
                  variant="primary"
                  onct-copy-success={closeExportAllModal({
                    showExportAllModal,
                  })}
                >
                  Copy
                </ct-copy-button>
              </ct-hstack>
            </ct-vstack>
          </ct-card>
        </div>

        {/* Import Modal */}
        <div
          style={{
            display: computed(() => showImportModal.get() ? "flex" : "none"),
            position: "fixed",
            inset: "0",
            background: "rgba(0,0,0,0.5)",
            alignItems: "center",
            justifyContent: "center",
            zIndex: "9999",
          }}
        >
          <ct-card
            style={{ minWidth: "500px", maxWidth: "700px", padding: "24px" }}
          >
            <ct-vstack gap="4">
              <h3 style={{ margin: 0 }}>Import Notes</h3>
              <p
                style={{
                  margin: 0,
                  fontSize: "13px",
                  color: "var(--ct-color-text-secondary, #6e6e73)",
                }}
              >
                Upload a file or paste exported markdown. Notes are wrapped in
                {" "}
                <code style={{ fontSize: "12px" }}>
                  &lt;!-- COMMON_NOTE_START --&gt;
                </code>{" "}
                blocks.
              </p>
              <ct-file-input
                accept=".md,.txt,.markdown"
                buttonText="📄 Upload File"
                variant="outline"
                showPreview={false}
                onct-click={hidePasteSection({ showPasteSection })}
                onct-change={handleImportFileUpload({
                  importMarkdown,
                  notes,
                  allCharms,
                  notebooks,
                  showDuplicateModal,
                  detectedDuplicates,
                  pendingImportData,
                  showImportModal,
                  showImportProgressModal,
                  importProgressMessage,
                  importComplete,
                  showPasteSection,
                })}
              />
              {/* Paste section - hidden when Upload File button is clicked */}
              <div
                style={{
                  display: computed(() =>
                    showPasteSection.get() ? "block" : "none"
                  ),
                }}
              >
                <p
                  style={{
                    textAlign: "center",
                    color: "var(--ct-color-text-secondary, #6e6e73)",
                    margin: "4px 0",
                    fontSize: "12px",
                  }}
                >
                  — or paste markdown below —
                </p>
                <ct-code-editor
                  $value={importMarkdown}
                  language="text/markdown"
                  theme="light"
                  wordWrap
                  lineNumbers
                  style={{
                    minHeight: "200px",
                    maxHeight: "400px",
                    overflow: "auto",
                  }}
                  placeholder={`<!-- COMMON_NOTE_START title="Note Title" -->

Note content here with any markdown...

<!-- COMMON_NOTE_END -->`}
                />
                <ct-hstack gap="3" style={{ justifyContent: "flex-end" }}>
                  <ct-button
                    variant="ghost"
                    onClick={closeImportModal({
                      showImportModal,
                      importMarkdown,
                      showPasteSection,
                    })}
                  >
                    Cancel
                  </ct-button>
                  <ct-button
                    variant="primary"
                    onClick={analyzeImport({
                      importMarkdown,
                      notes,
                      allCharms,
                      notebooks,
                      showDuplicateModal,
                      detectedDuplicates,
                      pendingImportData,
                      showImportModal,
                      importStatus,
                      showImportProgressModal,
                      importProgressMessage,
                      importComplete,
                      showPasteSection,
                    })}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <span style={{ fontSize: "14px" }}>📥</span>
                    <span>Import</span>
                  </ct-button>
                </ct-hstack>
              </div>
              {/* Cancel button - always visible even when paste section is hidden */}
              <ct-button
                variant="ghost"
                style={{
                  display: computed(() =>
                    showPasteSection.get() ? "none" : "block"
                  ),
                  marginTop: "12px",
                }}
                onClick={closeImportModal({
                  showImportModal,
                  importMarkdown,
                  showPasteSection,
                })}
              >
                Cancel
              </ct-button>
            </ct-vstack>
          </ct-card>
        </div>

        {/* Import Progress Modal - super modal in front of all others */}
        <div
          style={{
            display: computed(() =>
              showImportProgressModal.get() ? "flex" : "none"
            ),
            position: "fixed",
            inset: "0",
            background: "rgba(0,0,0,0.7)",
            alignItems: "center",
            justifyContent: "center",
            zIndex: "99999",
          }}
        >
          <ct-card style={{ minWidth: "300px", padding: "32px" }}>
            <ct-vstack gap="4" style={{ alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>
                {computed(() =>
                  importComplete.get() ? "Done!" : "Importing..."
                )}
              </h3>
              <p
                style={{
                  margin: 0,
                  color: "var(--ct-color-text-secondary, #6e6e73)",
                  fontSize: "14px",
                }}
              >
                {computed(() => importProgressMessage.get())}
              </p>
              {/* Indeterminate progress bar - hide when complete */}
              <div
                style={{
                  width: "100%",
                  height: "4px",
                  background: "var(--ct-color-bg-secondary, #e5e5e7)",
                  borderRadius: "2px",
                  overflow: "hidden",
                  position: "relative",
                  display: computed(() =>
                    importComplete.get() ? "none" : "block"
                  ),
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    height: "100%",
                    width: "40%",
                    background:
                      "var(--ct-color-primary, var(--ct-color-blue-500, #3b82f6))",
                    borderRadius: "2px",
                    animation: "indeterminate 1s infinite linear",
                  }}
                />
              </div>
              {/* Done button - show when complete */}
              <ct-button
                variant="default"
                style={{
                  display: computed(() =>
                    importComplete.get() ? "block" : "none"
                  ),
                  marginTop: "8px",
                }}
                onClick={() => showImportProgressModal.set(false)}
              >
                Done
              </ct-button>
              <style>
                {`
                  @keyframes indeterminate {
                    0% { transform: translateX(-100%); }
                    100% { transform: translateX(250%); }
                  }
                `}
              </style>
            </ct-vstack>
          </ct-card>
        </div>
      </ct-screen>
    ),
    exportedMarkdown,
    importMarkdown,
    noteCount,
    // Make notes discoverable via [[ autocomplete system-wide
    mentionable: notes,
  };
});

export default NotesImportExport;
