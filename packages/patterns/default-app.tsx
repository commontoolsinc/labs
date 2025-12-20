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

import { default as Note } from "./note.tsx";
import { default as Record } from "./record.tsx";
import BacklinksIndex, { type MentionableCharm } from "./backlinks-index.tsx";
import OmniboxFAB from "./omnibox-fab.tsx";
import NotesImportExport from "./notes-import-export.tsx";

type MinimalCharm = {
  [NAME]?: string;
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

const spawnNote = handler<void, void>((_, __) => {
  return navigateTo(Note({
    title: "New Note",
    content: "",
  }));
});

const spawnRecord = handler<void, void>((_, __) => {
  return navigateTo(Record({
    title: "",
  }));
});

const spawnNotesImportExport = handler<void, void>((_, __) => {
  return navigateTo(NotesImportExport({
    importMarkdown: "",
  }));
});

export default pattern<CharmsListInput, CharmsListOutput>((_) => {
  const { allCharms } = wish<{ allCharms: MentionableCharm[] }>("/");
  const index = BacklinksIndex({ allCharms });

  const fab = OmniboxFAB({
    mentionable: index.mentionable as unknown as Cell<MentionableCharm[]>,
  });

  return {
    backlinksIndex: index,
    [NAME]: computed(() => `DefaultCharmList (${allCharms.length})`),
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
            <ct-button
              variant="ghost"
              onClick={spawnNote()}
              style={{
                padding: "12px 20px",
                fontSize: "22px",
                borderRadius: "12px",
                minHeight: "48px",
              }}
            >
              📄 New Note
            </ct-button>
            <ct-button
              variant="ghost"
              onClick={spawnRecord()}
              style={{
                padding: "12px 20px",
                fontSize: "22px",
                borderRadius: "12px",
                minHeight: "48px",
              }}
            >
              📋 New Record
            </ct-button>
          </div>
          <div slot="end">
            <ct-button
              variant="ghost"
              onClick={spawnNotesImportExport()}
              style={{
                padding: "12px 20px",
                fontSize: "22px",
                borderRadius: "12px",
                minHeight: "48px",
              }}
            >
              ⚙️ Import/Export
            </ct-button>
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
            <h2>Pages</h2>

            <ct-table full-width hover>
              <tbody>
                {allCharms.map((charm) => (
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
