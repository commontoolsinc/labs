/// <cts-enable />
import {
  Cell,
  computed,
  handler,
  NAME,
  navigateTo,
  pattern,
  UI,
  wish,
} from "commontools";

import { default as Note } from "./notes/note.tsx";

// Simple random ID generator (crypto.randomUUID not available in pattern env)
const generateId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
import BacklinksIndex, { type MentionableCharm } from "./backlinks-index.tsx";
import OmniboxFAB from "./omnibox-fab.tsx";
import Notebook from "./notes/notebook.tsx";
import NotesImportExport from "./notes/notes-import-export.tsx";

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
  { charm: Cell<MinimalCharm> }
>((_, state) => {
  return navigateTo(state.charm);
}, { proxy: true });

const removeCharm = handler<
  Record<string, never>,
  {
    charm: Cell<MinimalCharm>;
    allCharms: Cell<MinimalCharm[]>;
  }
>((_, state) => {
  const allCharmsValue = state.allCharms.get();
  const index = allCharmsValue.findIndex((c: any) => state.charm.equals(c));

  if (index !== -1) {
    const charmListCopy = [...allCharmsValue];
    console.log("charmListCopy before", charmListCopy.length);
    charmListCopy.splice(index, 1);
    console.log("charmListCopy after", charmListCopy.length);
    state.allCharms.set(charmListCopy);
  }
});

const toggleFab = handler<any, { fabExpanded: Cell<boolean> }>(
  (_, { fabExpanded }) => {
    fabExpanded.set(!fabExpanded.get());
  },
);

// Toggle dropdown menu
const toggleMenu = handler<void, { menuOpen: Cell<boolean> }>(
  (_, { menuOpen }) => menuOpen.set(!menuOpen.get()),
);

// Close dropdown menu (for backdrop click)
const closeMenu = handler<void, { menuOpen: Cell<boolean> }>(
  (_, { menuOpen }) => menuOpen.set(false),
);

// Menu: New Note
const menuNewNote = handler<void, { menuOpen: Cell<boolean> }>(
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
const menuNewNotebook = handler<void, { menuOpen: Cell<boolean> }>(
  (_, { menuOpen }) => {
    menuOpen.set(false);
    return navigateTo(Notebook({ title: "New Notebook" }));
  },
);

// Helper to find existing All Notes charm
const findAllNotebooksCharm = (allCharms: Cell<MinimalCharm[]>) => {
  const charms = allCharms.get();
  return charms.find((charm: any) => {
    const name = charm?.[NAME];
    return typeof name === "string" && name.startsWith("All Notes");
  });
};

// Menu: All Notes
const menuAllNotebooks = handler<
  void,
  { menuOpen: Cell<boolean>; allCharms: Cell<MinimalCharm[]> }
>((_, { menuOpen, allCharms }) => {
  menuOpen.set(false);
  const existing = findAllNotebooksCharm(allCharms);
  if (existing) {
    return navigateTo(existing);
  }
  return navigateTo(NotesImportExport({ importMarkdown: "" }));
});

export default pattern<CharmsListInput, CharmsListOutput>((_) => {
  const { allCharms } = wish<{ allCharms: MentionableCharm[] }>("/");

  // Dropdown menu state
  const menuOpen = Cell.of(false);

  // Filter out hidden charms and charms without resolved NAME
  // (prevents transient hash-only pills during reactive updates)
  const visibleCharms = computed(() =>
    allCharms.filter((charm) => {
      if (charm.isHidden === true) return false;
      const name = (charm as any)?.[NAME];
      return typeof name === "string" && name.length > 0;
    })
  );

  const index = BacklinksIndex({ allCharms });

  const fab = OmniboxFAB({
    mentionable: index.mentionable as unknown as Cell<MentionableCharm[]>,
  });

  return {
    backlinksIndex: index,
    [NAME]: computed(() => `DefaultCharmList (${visibleCharms.length})`),
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
            <h2 style={{ margin: 0, fontSize: "20px" }}>Pages</h2>
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
                {visibleCharms.map((charm) => (
                  <tr>
                    <td>
                      <ct-cell-context $cell={charm}>
                        <ct-cell-link $cell={charm} />
                      </ct-cell-context>
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
                ))}
              </tbody>
            </ct-table>
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    ),
    sidebarUI: undefined,
    fabUI: fab[UI],
  };
});
