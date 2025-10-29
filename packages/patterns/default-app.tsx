/// <cts-enable />
import {
  Cell,
  derive,
  handler,
  NAME,
  navigateTo,
  recipe,
  str,
  UI,
  wish,
} from "commontools";

import Chatbot from "./chatbot.tsx";
import ChatbotOutliner from "./chatbot-outliner.tsx";
import { default as Note } from "./note.tsx";
import BacklinksIndex, { type MentionableCharm } from "./backlinks-index.tsx";
import ChatList from "./chatbot-list-view.tsx";
import OmniboxFAB from "./omnibox-fab.tsx";

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

const visit = handler<
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

const spawnChatList = handler<void, void>((_, __) => {
  return navigateTo(ChatList({
    selectedCharm: { charm: undefined },
    charmsList: [],
  }));
});

const spawnChatbot = handler<void, void>((_, __) => {
  return navigateTo(Chatbot({
    messages: [],
    tools: undefined,
  }));
});

const spawnChatbotOutliner = handler<void, void>((_, __) => {
  return navigateTo(ChatbotOutliner({
    title: "Chatbot Outliner",
    expandChat: false,
    messages: [],
    outline: {
      root: { body: "", children: [], attachments: [] },
    },
  }));
});

const spawnNote = handler<void, void>((_, __) => {
  return navigateTo(Note({
    title: "New Note",
    content: "",
  }));
});

export default recipe<CharmsListInput, CharmsListOutput>(
  "DefaultCharmList",
  (_) => {
    const allCharms = derive<MentionableCharm[], MentionableCharm[]>(
      wish<MentionableCharm[]>("#allCharms"),
      (c) => c,
    );
    const index = BacklinksIndex({ allCharms });

    const fab = OmniboxFAB({
      mentionable: index.mentionable as unknown as Cell<MentionableCharm[]>,
    });

    return {
      backlinksIndex: index,
      [NAME]: str`DefaultCharmList (${allCharms.length})`,
      [UI]: (
        <ct-screen>
          <ct-keybind
            code="KeyN"
            alt
            preventDefault
            onct-keybind={spawnChatList()}
          />
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
                onClick={spawnChatList()}
              >
                📂 Chat List
              </ct-button>
              <ct-button
                onClick={spawnChatbot()}
              >
                💬 Chatbot
              </ct-button>
              <ct-button
                onClick={spawnChatbotOutliner()}
              >
                📝 Chatbot Outliner
              </ct-button>
              <ct-button
                onClick={spawnNote()}
              >
                📄 Note
              </ct-button>
            </div>
          </ct-toolbar>

          <ct-vscroll flex showScrollbar>
            <ct-vstack gap="4" padding="6">
              <h2>Charms ({allCharms.length})</h2>

              <ct-table full-width hover>
                <thead>
                  <tr>
                    <th>Charm Name</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {allCharms.map((charm) => (
                    <tr>
                      <td>{charm?.[NAME] || "Untitled Charm"}</td>
                      <td>
                        <ct-hstack gap="2">
                          <ct-button
                            size="sm"
                            onClick={visit({ charm })}
                          >
                            Visit
                          </ct-button>
                          <ct-button
                            size="sm"
                            variant="destructive"
                            onClick={removeCharm({ charm, allCharms })}
                          >
                            Remove
                          </ct-button>
                        </ct-hstack>
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
  },
);
