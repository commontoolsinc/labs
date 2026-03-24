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
// Verifies: computed() with for...of loops over arrays captures item-level
//   property access instead of forcing wildcard reads on the whole iterable.
// Context: nested for-of with ?? fallback should still narrow the schema to
//   the specific notebook/note properties that the callback touches.
export default pattern<{ notebooks: NotebookPiece[]; query: string }>(
  ({ notebooks, query }) => {
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
