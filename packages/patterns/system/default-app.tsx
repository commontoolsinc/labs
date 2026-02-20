/// <cts-enable />
import {
  computed,
  equals,
  handler,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  UI,
  Writable,
} from "commontools";

import { default as Note } from "../notes/note.tsx";

// Simple random ID generator (crypto.randomUUID not available in pattern env)
const generateId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;

// Maximum number of recent pieces to track
const MAX_RECENT_CHARMS = 10;

import BacklinksIndex, { type MentionablePiece } from "./backlinks-index.tsx";
import OmniboxFAB from "./omnibox-fab.tsx";
import DoList from "../do-list/do-list.tsx";
import Notebook from "../notes/notebook.tsx";
import NotesImportExport from "../notes/notes-import-export.tsx";
import PieceGrid from "./piece-grid.tsx";

type MinimalPiece = {
  [NAME]?: string;
  isHidden?: boolean;
};

type PiecesListInput = void;

// Pattern returns only UI, no data outputs (only symbol properties)
interface PiecesListOutput {
  [key: string]: unknown;
  backlinksIndex: {
    mentionable: MentionablePiece[];
  };
  sidebarUI: unknown;
  fabUI: unknown;
}

const _visit = handler<
  Record<string, never>,
  { piece: Writable<MinimalPiece> }
>(
  (_, state) => {
    return navigateTo(state.piece);
  },
  { proxy: true },
);

const removePiece = handler<
  Record<string, never>,
  {
    piece: Writable<MinimalPiece>;
    allPieces: Writable<MinimalPiece[]>;
  }
>((_, state) => {
  const allPiecesValue = state.allPieces.get();
  const index = allPiecesValue.findIndex(
    (c: any) => c && state.piece.equals(c),
  );

  if (index !== -1) {
    const pieceListCopy = [...allPiecesValue];
    console.log("pieceListCopy before", pieceListCopy.length);
    pieceListCopy.splice(index, 1);
    console.log("pieceListCopy after", pieceListCopy.length);
    state.allPieces.set(pieceListCopy);
  }
});

// Handler for dropping a note onto a notebook row
const dropOntoNotebook = handler<
  { detail: { sourceCell: Writable<unknown> } },
  { notebook: Writable<{ notes?: unknown[] }> }
>((event, { notebook }) => {
  const sourceCell = event.detail.sourceCell;
  const notesCell = notebook.key("notes");
  const notesList = notesCell.get() ?? [];

  // Prevent duplicates using Writable.equals
  const alreadyExists = notesList.some((n) => equals(sourceCell, n as any));
  if (alreadyExists) return;

  // Hide from Patterns list
  sourceCell.key("isHidden").set(true);

  // Add to notebook - push cell reference, not value, to maintain piece identity
  notesCell.push(sourceCell);
});

const toggleFab = handler<any, { fabExpanded: Writable<boolean> }>(
  (_, { fabExpanded }) => {
    fabExpanded.set(!fabExpanded.get());
  },
);

// Toggle dropdown menu
const toggleMenu = handler<void, { menuOpen: Writable<boolean> }>(
  (_, { menuOpen }) => menuOpen.set(!menuOpen.get()),
);

// Close dropdown menu (for backdrop click)
const closeMenu = handler<void, { menuOpen: Writable<boolean> }>(
  (_, { menuOpen }) => menuOpen.set(false),
);

// Menu: New Note
const menuNewNote = handler<void, { menuOpen: Writable<boolean> }>(
  (_, { menuOpen }) => {
    menuOpen.set(false);
    return navigateTo(
      Note({
        title: "New Note",
        content: "",
        noteId: generateId(),
      }),
    );
  },
);

// Menu: New Notebook
const menuNewNotebook = handler<void, { menuOpen: Writable<boolean> }>(
  (_, { menuOpen }) => {
    menuOpen.set(false);
    return navigateTo(Notebook({ title: "New Notebook" }));
  },
);

// Helper to find existing All Notes piece
const findAllNotebooksPiece = (allPieces: Writable<MinimalPiece[]>) => {
  const pieces = allPieces.get();
  return pieces.find((piece: any) => {
    const name = piece?.[NAME];
    return typeof name === "string" && name.startsWith("All Notes");
  });
};

// Menu: All Notes
const menuAllNotebooks = handler<
  void,
  { menuOpen: Writable<boolean>; allPieces: Writable<MinimalPiece[]> }
>((_, { menuOpen, allPieces }) => {
  menuOpen.set(false);
  const existing = findAllNotebooksPiece(allPieces);
  if (existing) {
    return navigateTo(existing);
  }
  return navigateTo(NotesImportExport({ importMarkdown: "", allPieces }));
});

// Handler: Add piece to allPieces if not already present
const addPiece = handler<
  { piece: MentionablePiece },
  { allPieces: Writable<MentionablePiece[]> }
>(({ piece }, { allPieces }) => {
  const current = allPieces.get();
  if (!current.some((c) => equals(c, piece))) {
    allPieces.push(piece);
  }
});

// Handler: Track piece as recently used (add to front, maintain max)
const trackRecent = handler<
  { piece: MentionablePiece },
  { recentPieces: Writable<MentionablePiece[]> }
>(({ piece }, { recentPieces }) => {
  const current = recentPieces.get();
  // Remove if already present
  const filtered = current.filter((c) => !equals(c, piece));
  // Add to front and limit to max
  const updated = [piece, ...filtered].slice(0, MAX_RECENT_CHARMS);
  recentPieces.set(updated);
});

export default pattern<PiecesListInput, PiecesListOutput>((_) => {
  // OWN the data cells (not from wish)
  const allPieces = Writable.of<MentionablePiece[]>([]);
  const recentPieces = Writable.of<MentionablePiece[]>([]);

  // Dropdown menu state
  const menuOpen = Writable.of(false);

  // Filter out hidden pieces and pieces without resolved NAME
  // (prevents transient hash-only pills during reactive updates)
  // NOTE: Use truthy check, not === true, because piece.isHidden is a proxy object
  const visiblePieces = computed(() =>
    allPieces.get().filter((piece) => {
      if (!piece) return false;
      if (piece.isHidden) return false;
      const name = piece?.[NAME];
      return typeof name === "string" && name.length > 0;
    })
  );

  const index = BacklinksIndex({});
  const doListItems = Writable.of<any[]>([]);
  const doList = DoList({ items: doListItems });

  const fab = OmniboxFAB({
    mentionable: index.mentionable,
    doListTools: {
      addItem: doList.addItem,
      addItems: doList.addItems,
      removeItemByTitle: doList.removeItemByTitle,
      updateItemByTitle: doList.updateItemByTitle,
      items: doList.items,
    },
  });

  const gridView = PieceGrid({ pieces: visiblePieces });
  const recentGridView = PieceGrid({ pieces: recentPieces });

  return {
    backlinksIndex: index,
    [NAME]: computed(() => `Space Home (${visiblePieces.length})`),
    [UI]: (
      <ct-screen>
        <ct-keybind
          code="KeyO"
          meta
          preventDefault
          onct-keybind={toggleFab({ fabExpanded: fab.fabExpanded })}
        />
        <ct-keybind
          code="KeyO"
          ctrl
          preventDefault
          onct-keybind={toggleFab({ fabExpanded: fab.fabExpanded })}
        />

        <ct-toolbar slot="header" sticky>
          <div slot="start">
            <h2 style={{ margin: 0, fontSize: "20px" }}>Patterns</h2>
          </div>
          <div slot="end">
            <ct-button
              variant="ghost"
              onClick={toggleMenu({ menuOpen })}
              style={{
                padding: "8px 16px",
                fontSize: "16px",
                borderRadius: "8px",
              }}
            >
              Notes ▾
            </ct-button>

            {/* Backdrop to close menu when clicking outside */}
            <div
              onClick={closeMenu({ menuOpen })}
              style={{
                display: computed(() => (menuOpen.get() ? "block" : "none")),
                position: "fixed",
                inset: "0",
                zIndex: "999",
              }}
            />

            {/* Dropdown Menu */}
            <ct-vstack
              gap="0"
              style={{
                display: computed(() => (menuOpen.get() ? "flex" : "none")),
                position: "fixed",
                top: "112px",
                right: "16px",
                background: "var(--ct-color-bg, white)",
                border: "1px solid var(--ct-color-border, #e5e5e7)",
                borderRadius: "12px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                minWidth: "160px",
                zIndex: "1000",
                padding: "4px",
              }}
            >
              <ct-button
                variant="ghost"
                onClick={menuNewNote({ menuOpen })}
                style={{ justifyContent: "flex-start" }}
              >
                {"\u00A0\u00A0"}📝 New Note
              </ct-button>
              <ct-button
                variant="ghost"
                onClick={menuNewNotebook({ menuOpen })}
                style={{ justifyContent: "flex-start" }}
              >
                {"\u00A0\u00A0"}📓 New Notebook
              </ct-button>
              <div
                style={{
                  height: "1px",
                  background: "var(--ct-color-border, #e5e5e7)",
                  margin: "4px 8px",
                }}
              />
              <ct-button
                variant="ghost"
                onClick={menuAllNotebooks({ menuOpen, allPieces })}
                style={{ justifyContent: "flex-start" }}
              >
                {"\u00A0\u00A0"}📁 All Notes
              </ct-button>
            </ct-vstack>
          </div>
        </ct-toolbar>

        <ct-vscroll flex showScrollbar>
          <ct-hstack gap="6" padding="6" align="start">
            <div style={{ flex: "1", minWidth: "0" }}>
              <ct-vstack gap="4">
                <h3 style={{ margin: "0", fontSize: "16px" }}>Do List</h3>
                <ct-cell-link $cell={doList} />
                {doList.compactUI}
              </ct-vstack>
            </div>

            <div style={{ flex: "1", minWidth: "0" }}>
              {ifElse(
                computed(() => recentPieces.get().length > 0),
                <ct-vstack gap="4" style={{ marginBottom: "16px" }}>
                  <ct-hstack gap="2" align="center">
                    <h3 style={{ margin: "0", fontSize: "16px" }}>Recent</h3>
                    <ct-cell-link $cell={recentGridView} />
                  </ct-hstack>
                  <ct-table full-width hover>
                    <tbody>
                      {recentPieces.map((piece: any) => (
                        <tr>
                          <td>
                            <ct-cell-context $cell={piece}>
                              <ct-cell-link $cell={piece} />
                            </ct-cell-context>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </ct-table>
                </ct-vstack>,
                undefined,
              )}

              <ct-vstack gap="4">
                <ct-hstack gap="2" align="center">
                  <h3 style={{ margin: "0", fontSize: "16px" }}>Pieces</h3>
                  <ct-cell-link $cell={gridView} />
                </ct-hstack>

                <ct-table full-width hover>
                  <tbody>
                    {visiblePieces.map((piece) => {
                      const isNotebook = computed(() => {
                        const name = piece?.[NAME];
                        const result = typeof name === "string" &&
                          name.startsWith("📓");
                        return result;
                      });

                      const link = (
                        <ct-drag-source $cell={piece} type="note">
                          <ct-cell-context $cell={piece}>
                            <ct-cell-link $cell={piece} />
                          </ct-cell-context>
                        </ct-drag-source>
                      );

                      return (
                        <tr>
                          <td>
                            {ifElse(
                              isNotebook,
                              <ct-drop-zone
                                accept="note"
                                onct-drop={dropOntoNotebook({
                                  notebook: piece as any,
                                })}
                              >
                                {link}
                              </ct-drop-zone>,
                              link,
                            )}
                          </td>
                          <td>
                            <ct-button
                              size="sm"
                              variant="ghost"
                              onClick={removePiece({ piece, allPieces })}
                            >
                              🗑️
                            </ct-button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </ct-table>
              </ct-vstack>
            </div>
          </ct-hstack>
        </ct-vscroll>
      </ct-screen>
    ),
    sidebarUI: undefined,
    fabUI: fab[UI],

    // Exported data
    allPieces,
    recentPieces,

    // Exported handlers (bound to state cells for external callers)
    addPiece: addPiece({ allPieces }),
    trackRecent: trackRecent({ recentPieces }),
  };
});
