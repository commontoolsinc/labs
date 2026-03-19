/// <cts-enable />
import { computed, NAME, pattern, UI } from "commontools";

interface NotebookPiece {
  [NAME]?: string;
  title?: string;
  notes?: NotePiece[];
  isNotebook?: boolean;
}

interface NotePiece {
  [NAME]?: string;
  title?: string;
  content?: string;
}

// FIXTURE: computed-for-of-item-access
// Verifies: computed() with for...of loop over an array captures item-level
//   property access, NOT wildcard.  The capability analysis correctly tracks
//   paths like ["notebooks", "notes", "title"] through nested for-of loops.
// Context: for-of iteration aliases the loop variable to the iterable.
//   Nested for-of with ?? fallback (nb?.notes ?? []) is also resolved.
export default pattern<{ notebooks: NotebookPiece[]; query: string }>(
  ({ notebooks, query }) => {
    // Computed that iterates notebooks and only accesses .notes on each
    const matchingNotes = computed(() => {
      const result: NotePiece[] = [];
      for (const nb of notebooks) {
        for (const note of nb?.notes ?? []) {
          if (note?.title?.includes(query)) {
            result.push(note);
          }
        }
      }
      return result;
    });

    return {
      [NAME]: "Search",
      [UI]: <div>{computed(() => matchingNotes.length)}</div>,
    };
  },
);
