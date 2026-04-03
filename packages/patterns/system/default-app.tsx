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

import { default as Note, type NotePiece } from "../notes/note.tsx";

// Maximum number of recent pieces to track
const MAX_RECENT_CHARMS = 10;

import BacklinksIndex, { type MentionablePiece } from "./backlinks-index.tsx";
import SummaryIndex from "./summary-index.tsx";
import Notebook from "../notes/notebook.tsx";
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
  { detail: { sourceCell: Writable<NotePiece> } },
  { notebook: Writable<{ notes?: NotePiece[] }> }
>((event, { notebook }) => {
  const sourceCell = event.detail.sourceCell;
  const notesCell = notebook.key("notes");
  const notesList = notesCell.get() ?? [];

  // Prevent duplicates using Writable.equals
  const alreadyExists = notesList.some((n) => equals(sourceCell, n));
  if (alreadyExists) return;

  // Hide from Patterns list
  sourceCell.key("isHidden").set(true);

  // Add to notebook - push cell reference, not value, to maintain piece identity
  notesCell.push(sourceCell);
});

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

  const index = BacklinksIndex({ allPieces });
  const summaryIdx = SummaryIndex({});

  const gridView = PieceGrid({ pieces: visiblePieces });
  const recentGridView = PieceGrid({ pieces: recentPieces });

  return {
    backlinksIndex: index,
    summaryIndex: summaryIdx,

    [NAME]: computed(() => `Space Home (${visiblePieces.length})`),
    [UI]: (
      <ct-screen>
        <ct-toolbar slot="header" sticky>
          <div slot="start">
            <h2 style={{ margin: 0, fontSize: "20px" }}>Patterns</h2>
          </div>
          <ct-cell-link
            $cell={index}
            slot="end"
            style={{
              fontSize: "14px",
              padding: "6px 12px",
              textDecoration: "none",
              color: "var(--ct-color-text-secondary)",
            }}
          >
            Mentions
          </ct-cell-link>
          <ct-cell-link
            $cell={summaryIdx}
            slot="end"
            style={{
              fontSize: "14px",
              padding: "6px 12px",
              textDecoration: "none",
              color: "var(--ct-color-text-secondary)",
            }}
          >
            Search
          </ct-cell-link>
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
            </ct-vstack>
          </div>
        </ct-toolbar>

        <ct-vscroll flex showScrollbar>
          <ct-vstack gap="6" padding="6">
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
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
    sidebarUI: undefined,
    // Exported data
    allPieces,
    recentPieces,
    // Exported handlers (bound to state cells for external callers)
    addPiece: addPiece({ allPieces }),
    trackRecent: trackRecent({ recentPieces }),
  };
});
