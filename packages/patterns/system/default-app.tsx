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

// Maximum number of recent charms to track
const MAX_RECENT_CHARMS = 10;

import BacklinksIndex, { type MentionableCharm } from "./backlinks-index.tsx";
import OmniboxFAB from "./omnibox-fab.tsx";
import Notebook from "../notes/notebook.tsx";
import NotesImportExport from "../notes/notes-import-export.tsx";

type MinimalCharm = {
  [NAME]?: string;
  isHidden?: boolean;
};

type CharmsListInput = void;

// Recipe returns only UI, no data outputs (only symbol properties)
interface CharmsListOutput {
  [key: string]: unknown;
  backlinksIndex: {
    mentionable: MentionableCharm[];
  };
  sidebarUI: unknown;
  fabUI: unknown;
}

const _visit = handler<
  Record<string, never>,
  { charm: Writable<MinimalCharm> }
>((_, state) => {
  return navigateTo(state.charm);
}, { proxy: true });

const removeCharm = handler<
  Record<string, never>,
  {
    charm: Writable<MinimalCharm>;
    allCharms: Writable<MinimalCharm[]>;
  }
>((_, state) => {
  const allCharmsValue = state.allCharms.get();
  const index = allCharmsValue.findIndex((c: any) =>
    c && state.charm.equals(c)
  );

  if (index !== -1) {
    const charmListCopy = [...allCharmsValue];
    console.log("charmListCopy before", charmListCopy.length);
    charmListCopy.splice(index, 1);
    console.log("charmListCopy after", charmListCopy.length);
    state.allCharms.set(charmListCopy);
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

  // Add to notebook - push cell reference, not value, to maintain charm identity
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
    return navigateTo(Note({
      title: "New Note",
      content: "",
      noteId: generateId(),
    }));
  },
);

// Menu: New Notebook
const menuNewNotebook = handler<void, { menuOpen: Writable<boolean> }>(
  (_, { menuOpen }) => {
    menuOpen.set(false);
    return navigateTo(Notebook({ title: "New Notebook" }));
  },
);

// Helper to find existing All Notes charm
const findAllNotebooksCharm = (allCharms: Writable<MinimalCharm[]>) => {
  const charms = allCharms.get();
  return charms.find((charm: any) => {
    const name = charm?.[NAME];
    return typeof name === "string" && name.startsWith("All Notes");
  });
};

// Menu: All Notes
const menuAllNotebooks = handler<
  void,
  { menuOpen: Writable<boolean>; allCharms: Writable<MinimalCharm[]> }
>((_, { menuOpen, allCharms }) => {
  menuOpen.set(false);
  const existing = findAllNotebooksCharm(allCharms);
  if (existing) {
    return navigateTo(existing);
  }
  return navigateTo(NotesImportExport({ importMarkdown: "", allCharms }));
});

// Handler: Add charm to allCharms if not already present
const addCharm = handler<
  { charm: MentionableCharm },
  { allCharms: Writable<MentionableCharm[]> }
>(({ charm }, { allCharms }) => {
  const current = allCharms.get();
  if (!current.some((c) => equals(c, charm))) {
    allCharms.push(charm);
  }
});

// Handler: Track charm as recently used (add to front, maintain max)
const trackRecent = handler<
  { charm: MentionableCharm },
  { recentCharms: Writable<MentionableCharm[]> }
>(({ charm }, { recentCharms }) => {
  const current = recentCharms.get();
  // Remove if already present
  const filtered = current.filter((c) => !equals(c, charm));
  // Add to front and limit to max
  const updated = [charm, ...filtered].slice(0, MAX_RECENT_CHARMS);
  recentCharms.set(updated);
});

export default pattern<CharmsListInput, CharmsListOutput>((_) => {
  // OWN the data cells (not from wish)
  const allCharms = Writable.of<MentionableCharm[]>([]);
  const recentCharms = Writable.of<MentionableCharm[]>([]);

  // Dropdown menu state
  const menuOpen = Writable.of(false);

  // Filter out hidden charms and charms without resolved NAME
  // (prevents transient hash-only pills during reactive updates)
  // NOTE: Use truthy check, not === true, because charm.isHidden is a proxy object
  const visibleCharms = computed(() =>
    allCharms.get().filter((charm) => {
      if (!charm) return false;
      if (charm.isHidden) return false;
      const name = charm?.[NAME];
      return typeof name === "string" && name.length > 0;
    })
  );

  const index = BacklinksIndex({ allCharms });

  const fab = OmniboxFAB({
    mentionable: index.mentionable,
  });

  return {
    backlinksIndex: index,
    [NAME]: computed(() => `Space Home (${visibleCharms.length})`),
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
                onClick={menuAllNotebooks({ menuOpen, allCharms })}
                style={{ justifyContent: "flex-start" }}
              >
                {"\u00A0\u00A0"}📁 All Notes
              </ct-button>
            </ct-vstack>
          </div>
        </ct-toolbar>

        <ct-vscroll flex showScrollbar>
          <ct-vstack gap="4" padding="6">
            <style>
              {`
                .pattern-link {
                  cursor: pointer;
                  color: inherit;
                  text-decoration: none;
                }
                .pattern-link:hover {
                  text-decoration: underline;
                }
              `}
            </style>

            <ct-table full-width hover>
              <tbody>
                {visibleCharms.map((charm) => {
                  // Check if charm is a notebook by NAME prefix (isNotebook prop not reliable through proxy)
                  const isNotebook = computed(() => {
                    const name = charm?.[NAME];
                    const result = typeof name === "string" &&
                      name.startsWith("📓");
                    return result;
                  });

                  const link = (
                    <ct-drag-source $cell={charm} type="note">
                      <ct-cell-context $cell={charm}>
                        <ct-cell-link $cell={charm} />
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
                              notebook: charm as any,
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
                          onClick={removeCharm({ charm, allCharms })}
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
        </ct-vscroll>
      </ct-screen>
    ),
    sidebarUI: undefined,
    fabUI: fab[UI],

    // Exported data
    allCharms,
    recentCharms,

    // Exported handlers (bound to state cells for external callers)
    addCharm: addCharm({ allCharms }),
    trackRecent: trackRecent({ recentCharms }),
  };
});
