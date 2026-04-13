import {
  computed,
  equals,
  handler,
  NAME,
  navigateTo,
  pattern,
  patternTool,
  UI,
  Writable,
} from "commonfabric";

import { default as Note } from "../notes/note.tsx";

// Maximum number of recent pieces to track
const MAX_RECENT_CHARMS = 10;

import BacklinksIndex, { type MentionablePiece } from "./backlinks-index.tsx";
import SummaryIndex from "./summary-index.tsx";
import KnowledgeGraph, {
  getNeighborsPattern,
  searchGraphPattern,
} from "./knowledge-graph.tsx";

import QuickCapture from "./quick-capture.tsx";
import OmniboxFAB from "./omnibox-fab.tsx";
import DoList from "../do-list/do-list.tsx";
import Notebook from "../notes/notebook.tsx";
import DailyJournal from "../notes/daily-journal.tsx";
import PieceGrid from "./piece-grid.tsx";
import SuggestionHistory, {
  type SuggestionHistoryEntry,
} from "./suggestion-history.tsx";

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

// Menu: Quick Capture
const menuQuickCapture = handler<
  void,
  { menuOpen: Writable<boolean>; quickCapture: any }
>((_, { menuOpen, quickCapture }) => {
  menuOpen.set(false);
  return navigateTo(quickCapture);
});

// Menu: Daily Journal (singleton)
const menuDailyJournal = handler<
  void,
  { menuOpen: Writable<boolean>; allPieces: Writable<MinimalPiece[]> }
>((_, { menuOpen, allPieces }) => {
  menuOpen.set(false);
  const pieces = allPieces.get();
  const existing = pieces.find((piece: any) => piece?.isJournal === true);
  if (existing) {
    return navigateTo(existing as any);
  }
  return navigateTo(DailyJournal({ title: "Daily Journal" }));
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

const recordSuggestion = handler<
  SuggestionHistoryEntry,
  { suggestionHistory: Writable<SuggestionHistoryEntry[]> }
>(({ result, messages, timestamp }, { suggestionHistory }) => {
  const current = suggestionHistory.get() ?? [];
  suggestionHistory.set([...current, { result, messages, timestamp }]);
});

/** Read current do list items */
const readDoList = pattern<
  { items: Array<{ title: string; done: boolean; indent: number }> },
  { result: Array<{ title: string; done: boolean; indent: number }> }
>(({ items }) => {
  return { result: items };
});

const benExtraSystemPrompt = `
Do-list management:
- When users mention tasks, action items, or things to do, use addDoItem or addDoItems
- When users paste a block of text with multiple items, parse into items and use addDoItems to batch-add
- Use readDoList to check current items before making changes
- Use updateDoItem to mark done or rename; removeDoItem only for explicit deletion
- Use indent levels for sub-tasks (0=root, 1=sub-task, 2=sub-sub-task)

Knowledge graph:
- For finding relationships between pieces: use getNeighbors with an entity reference to get all incoming/outgoing links, or searchAnnotations to search agent-created annotations by text
`;

export default pattern<PiecesListInput, PiecesListOutput>((_) => {
  // OWN the data cells (not from wish)
  const allPieces = Writable.of<MentionablePiece[]>([]);
  const recentPieces = Writable.of<MentionablePiece[]>([]);
  const suggestionHistory = Writable.of<SuggestionHistoryEntry[]>([]);
  const suggestionHistoryViewer = SuggestionHistory({});

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

  const doListItems = Writable.of<any[]>([]);
  const doList = DoList({ items: doListItems });

  // Combine user-managed allPieces with system pieces (like doList) so
  // BacklinksIndex picks up their mentionable items.
  const allPiecesWithSystem = computed(() => [
    ...allPieces.get(),
    doList as any,
  ]);

  const index = BacklinksIndex({ allPieces: allPiecesWithSystem });
  const summaryIdx = SummaryIndex({});
  const knowledgeGraph = KnowledgeGraph({});

  const quickCapture = QuickCapture({ allPieces });

  const fab = OmniboxFAB({
    mentionable: index.mentionable,
    extraTools: {
      addDoItem: {
        handler: doList.addItem,
        description:
          "Add a task to the do list. Use indent for sub-tasks (0=root, 1=sub, 2=sub-sub). Pass attachments array to link pieces.",
      },
      addDoItems: {
        handler: doList.addItems,
        description:
          "Add multiple tasks at once. Each item can have attachments to link pieces.",
      },
      removeDoItem: {
        handler: doList.removeItemByTitle,
        description: "Remove a task and its subtasks by title.",
      },
      updateDoItem: {
        handler: doList.updateItemByTitle,
        description:
          "Update a task by title. Set done=true to complete, newTitle to rename, attachments to link pieces.",
      },
      readDoList: patternTool(readDoList, {
        items: doList.items,
      }),
      getNeighbors: patternTool(getNeighborsPattern, {
        edges: knowledgeGraph.edges,
      }),
      searchAnnotations: patternTool(searchGraphPattern, {
        edges: knowledgeGraph.edges,
        compoundNodes: knowledgeGraph.compoundNodes,
      }),
    },
    extraSystemPrompt: benExtraSystemPrompt,
  });

  const gridView = PieceGrid({ pieces: visiblePieces });
  const recentGridView = PieceGrid({ pieces: recentPieces });

  return {
    backlinksIndex: index,
    summaryIndex: summaryIdx,
    knowledgeGraph,

    quickCapture,
    [NAME]: computed(() => `Ben's Space (${visiblePieces.length})`),
    [UI]: (
      <cf-screen>
        <cf-keybind
          code="KeyO"
          meta
          preventDefault
          oncf-keybind={toggleFab({ fabExpanded: fab.fabExpanded })}
        />
        <cf-keybind
          code="KeyO"
          ctrl
          preventDefault
          oncf-keybind={toggleFab({ fabExpanded: fab.fabExpanded })}
        />

        <cf-toolbar slot="header" sticky>
          <div slot="start">
            <h2 style={{ margin: 0, fontSize: "20px" }}>Patterns</h2>
          </div>
          <cf-cell-link
            $cell={index}
            slot="end"
            style={{
              fontSize: "14px",
              padding: "6px 12px",
              textDecoration: "none",
              color: "var(--cf-color-text-secondary)",
            }}
          >
            Mentions
          </cf-cell-link>
          <cf-cell-link
            $cell={summaryIdx}
            slot="end"
            style={{
              fontSize: "14px",
              padding: "6px 12px",
              textDecoration: "none",
              color: "var(--cf-color-text-secondary)",
            }}
          >
            Search
          </cf-cell-link>
          <cf-cell-link
            $cell={knowledgeGraph}
            slot="end"
            style={{
              fontSize: "14px",
              padding: "6px 12px",
              textDecoration: "none",
              color: "var(--cf-color-text-secondary)",
            }}
          >
            Graph
          </cf-cell-link>
          <cf-cell-link
            $cell={suggestionHistoryViewer}
            slot="end"
            style={{
              fontSize: "14px",
              padding: "6px 12px",
              textDecoration: "none",
              color: "var(--cf-color-text-secondary)",
            }}
          >
            History
          </cf-cell-link>

          <div slot="end">
            <cf-button
              variant="ghost"
              onClick={toggleMenu({ menuOpen })}
              style={{
                padding: "8px 16px",
                fontSize: "16px",
                borderRadius: "8px",
              }}
            >
              Notes ▾
            </cf-button>

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
            <cf-vstack
              gap="0"
              style={{
                display: computed(() => (menuOpen.get() ? "flex" : "none")),
                position: "fixed",
                top: "112px",
                right: "16px",
                background: "var(--cf-color-bg, white)",
                border: "1px solid var(--cf-color-border, #e5e5e7)",
                borderRadius: "12px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                minWidth: "160px",
                zIndex: "1000",
                padding: "4px",
              }}
            >
              <cf-button
                variant="ghost"
                onClick={menuNewNote({ menuOpen })}
                style={{ justifyContent: "flex-start" }}
              >
                {"\u00A0\u00A0"}📝 New Note
              </cf-button>
              <cf-button
                variant="ghost"
                onClick={menuNewNotebook({ menuOpen })}
                style={{ justifyContent: "flex-start" }}
              >
                {"\u00A0\u00A0"}📓 New Notebook
              </cf-button>
              <cf-button
                variant="ghost"
                onClick={menuQuickCapture({ menuOpen, quickCapture })}
                style={{ justifyContent: "flex-start" }}
              >
                {"\u00A0\u00A0"}⚡ Quick Capture
              </cf-button>
              <cf-button
                variant="ghost"
                onClick={menuDailyJournal({ menuOpen, allPieces })}
                style={{ justifyContent: "flex-start" }}
              >
                {"\u00A0\u00A0"}📅 Daily Journal
              </cf-button>
              <div
                style={{
                  height: "1px",
                  background: "var(--cf-color-border, #e5e5e7)",
                  margin: "4px 8px",
                }}
              />
            </cf-vstack>
          </div>
        </cf-toolbar>

        <cf-vscroll flex showScrollbar>
          <cf-hstack gap="6" padding="6" align="start">
            <div style={{ flex: "1", minWidth: "0" }}>
              <cf-vstack gap="4">
                <h3 style={{ margin: "0", fontSize: "16px" }}>Do List</h3>
                <cf-cell-link $cell={doList} />
                {doList.compactUI}
              </cf-vstack>
            </div>

            <div style={{ flex: "1", minWidth: "0" }}>
              {computed(() => recentPieces.get().length > 0)
                ? (
                  <cf-vstack gap="4" style={{ marginBottom: "16px" }}>
                    <cf-hstack gap="2" align="center">
                      <h3 style={{ margin: "0", fontSize: "16px" }}>Recent</h3>
                      <cf-cell-link $cell={recentGridView} />
                    </cf-hstack>
                    <cf-table full-width hover>
                      <tbody>
                        {recentPieces.map((piece: any) => (
                          <tr>
                            <td>
                              <cf-cell-context $cell={piece}>
                                <cf-cell-link $cell={piece} />
                              </cf-cell-context>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </cf-table>
                  </cf-vstack>
                )
                : undefined}

              <cf-vstack gap="4">
                <cf-hstack gap="2" align="center">
                  <h3 style={{ margin: "0", fontSize: "16px" }}>Pieces</h3>
                  <cf-cell-link $cell={gridView} />
                </cf-hstack>

                <cf-table full-width hover>
                  <tbody>
                    {visiblePieces.map((piece) => {
                      const isNotebook = computed(() => {
                        const name = piece?.[NAME];
                        const result = typeof name === "string" &&
                          name.startsWith("📓");
                        return result;
                      });

                      const link = (
                        <cf-drag-source $cell={piece} type="note">
                          <cf-cell-context $cell={piece}>
                            <cf-cell-link $cell={piece} />
                          </cf-cell-context>
                        </cf-drag-source>
                      );

                      return (
                        <tr>
                          <td>
                            {isNotebook
                              ? (
                                <cf-drop-zone
                                  accept="note"
                                  oncf-drop={dropOntoNotebook({
                                    notebook: piece as any,
                                  })}
                                >
                                  {link}
                                </cf-drop-zone>
                              )
                              : link}
                          </td>
                          <td>
                            <cf-button
                              size="sm"
                              variant="ghost"
                              onClick={removePiece({ piece, allPieces })}
                            >
                              🗑️
                            </cf-button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </cf-table>
              </cf-vstack>
            </div>
          </cf-hstack>
        </cf-vscroll>
      </cf-screen>
    ),
    sidebarUI: undefined,
    fabUI: fab[UI],

    // Exported data
    allPieces,
    recentPieces,
    suggestionHistory,

    // Exported handlers (bound to state cells for external callers)
    addPiece: addPiece({ allPieces }),
    trackRecent: trackRecent({ recentPieces }),
    recordSuggestion: recordSuggestion({ suggestionHistory }),
    pinToChat: fab.pinToChat,
  };
});
