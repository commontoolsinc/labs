/**
 * Notes-list bench fixture — the Shell default-app shape, headless.
 *
 * This is a MEASUREMENT FIXTURE for the Reactive Interpreter footprint bench
 * (`packages/patterns/tools/default-app-interpreter-bench.ts`), NOT a product
 * pattern. It models the essential structure of the Shell default/home app
 * (`packages/patterns/system/default-app.tsx`): a slowly-growing list of note
 * pieces rendered as a top-level `map`, with a "New Note" handler that appends.
 *
 * Why a fixture rather than `default-app.tsx` directly: the real default app
 * `wish`es for the space's pieces, navigates between piece views, and renders
 * each row with per-element interactive surfaces (drag-source, drop-zone, a
 * remove button bound to a handler). It only runs end-to-end inside the shell
 * dev-stack with a browser web-worker (the integration test drives it via
 * Astral/CDP). It cannot be loaded headless through the multi-runtime harness.
 * This fixture keeps the load-bearing footprint shape — a top-level `map` over
 * a growing notes array — so the interpreter's per-element doc/node tax can be
 * measured OFF vs ON in-process.
 *
 * Interpreter eligibility (the whole point):
 *   - The notes map is the ELIGIBLE shape: exactly one top-level `map` whose
 *     element pattern is a PURE render (title + preview + tags VNode), with no
 *     per-element handler/effect and default scope. Under
 *     `experimentalInterpreter`, this dispatches to `$ri-collection-map`
 *     (~1+N docs/element instead of legacy ~3N) — see the runner's collection
 *     eligibility gate and `reactive-interpreter/collection-interpreter.ts`.
 *   - `addNote` is a top-level handler (event/effect), exercised by the bench
 *     to grow the list. It is not part of the interpreted map element, so it
 *     does not change the map's eligibility.
 *
 * Deliberately faithful to the default-app element render mix WITHOUT crossing
 * the eligibility boundary: the per-note row reads multiple fields and builds a
 * small VNode subtree (chip-like), but binds no handler and uses no non-default
 * scope.
 */

import {
  computed,
  type Default,
  handler,
  NAME,
  pattern,
  type PerSpace,
  Stream,
  UI,
  type VNode,
  type Writable,
} from "commonfabric";

export interface Note {
  title: string;
  content: string;
  tags: string[] | Default<[]>;
}

interface NotesListInput {
  notes?: PerSpace<Writable<Note[] | Default<[]>>>;
}

interface NotesListOutput {
  [NAME]: string;
  [UI]: VNode;
  noteCount: number;
  titles: string[];
  addNote: Stream<{ title?: string; content?: string }>;
}

// "New Note": append a fresh note to the PerSpace list. Mirrors default-app's
// addPiece (push onto allPieces). A top-level event handler — NOT part of the
// interpreted map element.
const addNote = handler<
  { title?: string; content?: string },
  { notes: Writable<Note[]> }
>((event, { notes }) => {
  const current = notes.get() ?? [];
  const index = current.length;
  notes.push({
    title: event?.title ?? `📝 New Note #${index.toString(36)}`,
    content: event?.content ?? `Note body ${index} — `.repeat(8),
    tags: ["#note", `#tag-${index % 7}`],
  });
});

export default pattern<NotesListInput, NotesListOutput>(({ notes }) => {
  const noteCount = computed(() => (notes.get() ?? []).length);

  // Derived projection used for the NAME + the output-equivalence fingerprint.
  // A plain computed over the whole list (not the interpreted map) — the bench
  // reads `titles` to compare arms without depending on rendered VNodes.
  const titles = computed(() =>
    (notes.get() ?? []).map((note) =>
      `${note.title} (${note.tags?.length ?? 0})`
    )
  );

  return {
    [NAME]: computed(() => `Notes (${noteCount})`),
    // The interpreter-eligible surface: ONE top-level pure-render map over the
    // growing notes list. Each element reads several fields and builds a small
    // VNode subtree (chip-like), binds NO handler, uses default scope.
    [UI]: (
      <cf-screen>
        <cf-vstack gap="2" padding="4">
          <h2 style={{ margin: "0" }}>Notes</h2>
          <cf-table full-width hover>
            <tbody>
              {notes.map((note) => (
                <tr>
                  <td>
                    <cf-vstack gap="0">
                      <span style={{ fontWeight: "600" }}>{note.title}</span>
                      <span
                        style={{
                          fontSize: "12px",
                          color: "var(--cf-theme-color-text-secondary)",
                        }}
                      >
                        {computed(() => (note.content ?? "").slice(0, 48))}
                      </span>
                      <span style={{ fontSize: "11px", opacity: "0.6" }}>
                        {computed(() => (note.tags ?? []).join(" "))}
                      </span>
                    </cf-vstack>
                  </td>
                </tr>
              ))}
            </tbody>
          </cf-table>
        </cf-vstack>
      </cf-screen>
    ),
    noteCount,
    titles,
    addNote: addNote({ notes }),
  };
});
