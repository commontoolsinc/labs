import { EditorState, Range, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";

/**
 * Represents a parsed backlink with position and content info
 */
export interface BacklinkInfo {
  from: number; // Start of [[
  to: number; // End of ]]
  nameFrom: number; // Start of name (after [[)
  nameTo: number; // End of name (before " (id)" or "]]")
  id: string; // The piece ID (empty string if incomplete)
  name: string; // The display name text
}

/**
 * Parse all backlinks from a document string
 */
export function parseBacklinks(doc: string): BacklinkInfo[] {
  const backlinks: BacklinkInfo[] = [];
  const backlinkRegex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = backlinkRegex.exec(doc)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    const innerText = match[1];

    // Parse: check if has ID in format "Name (id)"
    const idMatch = innerText.match(/^(.+?)\s+\(([^)]+)\)$/);
    const hasId = idMatch !== null;
    const name = hasId ? idMatch[1] : innerText;
    const id = hasId ? idMatch[2] : "";

    const nameFrom = from + 2; // After [[
    const nameTo = nameFrom + name.length;

    backlinks.push({ from, to, nameFrom, nameTo, id, name });
  }

  return backlinks;
}

/**
 * StateField to track all backlink positions in the document.
 * Updated whenever the document changes.
 */
export const backlinkField = StateField.define<BacklinkInfo[]>({
  create(state) {
    return parseBacklinks(state.doc.toString());
  },
  update(value, tr) {
    if (!tr.docChanged) return value;
    return parseBacklinks(tr.newDoc.toString());
  },
});

/**
 * Create atomic ranges that make cursor skip over [[ and ]] portions.
 * This prevents the cursor from entering the bracket areas during navigation.
 * For backlinks WITH id (legacy format): protects [[ and (id)]]
 * For backlinks WITHOUT id (name-only format): protects [[ and ]]
 * Note: We must ensure ranges don't span line breaks.
 */
export const atomicBacklinkRanges = EditorView.atomicRanges.of((view) => {
  const backlinks = view.state.field(backlinkField);
  const doc = view.state.doc;
  const decorations: Range<Decoration>[] = [];

  for (const bl of backlinks) {
    // Safety: ensure the backlink is on a single line
    const startLine = doc.lineAt(bl.from).number;
    const endLine = doc.lineAt(bl.to).number;
    if (startLine !== endLine) continue; // Skip multi-line backlinks

    // Make [[ atomic (cursor skips from before [[ to after [[)
    if (bl.from < bl.nameFrom) {
      decorations.push(Decoration.mark({}).range(bl.from, bl.nameFrom));
    }

    if (bl.id) {
      // Legacy format with ID: make " (id)]]" atomic
      if (bl.nameTo < bl.to) {
        decorations.push(Decoration.mark({}).range(bl.nameTo, bl.to));
      }
    } else {
      // Name-only format: make ]] atomic
      // The ]] is at positions bl.to-2 to bl.to
      const closeBracketStart = bl.to - 2;
      if (bl.nameTo < closeBracketStart) {
        // This shouldn't happen in valid backlinks, but safety check
        decorations.push(Decoration.mark({}).range(closeBracketStart, bl.to));
      } else if (bl.nameTo === closeBracketStart) {
        // Normal case: name ends right before ]]
        decorations.push(Decoration.mark({}).range(closeBracketStart, bl.to));
      }
    }
  }

  decorations.sort((a, b) => a.from - b.from);
  return Decoration.set(decorations);
});

/**
 * Transaction filter to prevent edits from corrupting the ID portion of backlinks.
 * - Blocks edits that start within the ID portion
 * - Truncates edits that span from name into ID
 * - Allows full backlink deletions
 */
export const backlinkEditFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;

  const backlinks = tr.startState.field(backlinkField);
  if (backlinks.length === 0) return tr;

  let needsModification = false;

  // Check each change to see if it affects any backlink's protected area
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, _inserted) => {
    for (const bl of backlinks) {
      if (!bl.id) continue; // Only protect complete backlinks

      // Case: Edit starts in the ID portion " (id)]]" - block it
      if (fromA > bl.nameTo && fromA < bl.to) {
        needsModification = true;
        return;
      }

      // Case: Edit spans from name into ID - needs truncation
      if (fromA <= bl.nameTo && toA > bl.nameTo && toA < bl.to) {
        needsModification = true;
        return;
      }
    }
  });

  // If we detected a problematic edit, we need to filter/modify the transaction
  // For now, we'll rely on atomicRanges to prevent cursor entry,
  // and handle edge cases like paste operations here
  if (needsModification) {
    // Build a modified changes array that respects backlink boundaries
    const specs: { from: number; to: number; insert: string }[] = [];

    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const adjustedFrom = fromA;
      let adjustedTo = toA;
      let shouldInclude = true;

      for (const bl of backlinks) {
        if (!bl.id) continue;

        // Block edits that start in ID area
        if (fromA > bl.nameTo && fromA < bl.to) {
          shouldInclude = false;
          break;
        }

        // Truncate edits that span into ID area
        if (fromA <= bl.nameTo && toA > bl.nameTo && toA < bl.to) {
          adjustedTo = bl.nameTo;
        }
      }

      if (shouldInclude) {
        specs.push({
          from: adjustedFrom,
          to: adjustedTo,
          insert: inserted.toString(),
        });
      }
    });

    // Return the modified transaction whenever any change was blocked or
    // truncated (blocked covers ID-start edits; the truncation path only sets
    // adjustedTo, so we always need to return specs when needsModification).
    return {
      changes: specs,
      selection: tr.selection,
      effects: tr.effects,
    };
  }

  return tr;
});

/**
 * Create a plugin to decorate backlinks with focus-aware styling.
 * - When cursor is outside: show as collapsed pill (hide brackets and ID if present)
 * - When cursor is adjacent/inside: show [[Name]] with visible brackets (ID never visible for legacy format)
 *
 * All parsed backlinks with non-empty names are treated as "complete":
 * - Name-only format: [[Name]] - pill hides [[ and ]]
 * - Legacy format with ID: [[Name (id)]] - pill hides [[, (id), and ]]
 */
export function createBacklinkDecorationPlugin() {
  const editingMark = Decoration.mark({ class: "cm-backlink-editing" });
  const pillMark = Decoration.mark({ class: "cm-backlink-pill" });
  const hiddenReplace = Decoration.replace({});

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.getBacklinkDecorations(view);
      }

      update(update: ViewUpdate) {
        // Update on doc changes, viewport changes, selection changes, OR focus changes
        if (
          update.docChanged || update.viewportChanged ||
          update.selectionSet || update.focusChanged
        ) {
          this.decorations = this.getBacklinkDecorations(update.view);
        }
      }

      getBacklinkDecorations(view: EditorView) {
        const decorations: Range<Decoration>[] = [];
        const doc = view.state.doc;
        const hasFocus = view.hasFocus;
        const cursorPos = view.state.selection.main.head;
        const selectionFrom = view.state.selection.main.from;
        const selectionTo = view.state.selection.main.to;

        // Use the StateField for backlink positions
        const backlinks = view.state.field(backlinkField);

        for (const bl of backlinks) {
          const { from: start, to: end, nameFrom, nameTo, id, name } = bl;
          const hasId = id !== "";

          // Safety: skip backlinks that span multiple lines (would cause decoration errors)
          const startLine = doc.lineAt(start).number;
          const endLine = doc.lineAt(end).number;
          if (startLine !== endLine) continue;

          // Skip truly empty backlinks (shouldn't happen with current regex, but safety check)
          if (!name.trim()) continue;

          // Check if cursor is anywhere within the backlink (including hidden areas)
          // This ensures editing mode triggers when cursor is adjacent to visible pill
          const cursorInBacklink = hasFocus && cursorPos >= start &&
            cursorPos <= end;
          // Check if selection overlaps with the entire backlink
          const selectionOverlaps = hasFocus && selectionFrom < end &&
            selectionTo > start;

          if (cursorInBacklink || selectionOverlaps) {
            // EDITING MODE: Show [[Name]] text with editing style
            // For legacy format with ID: hide the " (id)" portion
            if (hasId) {
              // Show [[Name]] and hide " (id)"
              decorations.push(editingMark.range(start, nameTo));
              // Safety check: only hide if there's actually content between nameTo and end-2
              const idStart = nameTo;
              const idEnd = end - 2; // Position before ]]
              if (idEnd > idStart) {
                decorations.push(hiddenReplace.range(idStart, idEnd)); // Hide " (id)"
              }
              decorations.push(editingMark.range(end - 2, end)); // Show ]]
            } else {
              // Name-only format: show full [[Name]] with editing style
              decorations.push(editingMark.range(start, end));
            }
          } else {
            // PILL MODE: Cursor outside - show as navigable pill
            decorations.push(hiddenReplace.range(start, start + 2)); // Hide [[
            decorations.push(pillMark.range(nameFrom, nameTo)); // Style name only
            if (hasId) {
              // Legacy format: hide " (id)]]"
              decorations.push(hiddenReplace.range(nameTo, end));
            } else {
              // Name-only format: hide ]]
              decorations.push(hiddenReplace.range(end - 2, end));
            }
          }
        }

        // Sort decorations by position (required by CodeMirror)
        decorations.sort((a, b) => a.from - b.from || a.to - b.to);

        return Decoration.set(decorations);
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}
