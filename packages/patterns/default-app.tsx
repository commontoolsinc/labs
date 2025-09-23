/// <cts-enable />
import {
  Cell,
  Default,
  derive,
  h,
  handler,
  NAME,
  navigateTo,
  Opaque,
  OpaqueRef,
  recipe,
  str,
  UI,
} from "commontools";

// Import recipes we want to be launchable from the default app.
import Chatbot from "./chatbot.tsx";
import ChatbotTools from "./chatbot-tools.tsx";
import ChatbotOutliner from "./chatbot-outliner.tsx";
import {
  default as ChatbotNote,
  type MentionableCharm,
} from "./chatbot-note.tsx";
import { default as Note } from "./note.tsx";
import ChatList from "./chatbot-list-view.tsx";

export type Charm = {
  [NAME]?: string;
  [UI]?: unknown;
  [key: string]: any;
};

type CharmsListInput = {
  allCharms: Default<Charm[], []>;
};

// Recipe returns only UI, no data outputs (only symbol properties)
interface CharmsListOutput {
  [key: string]: unknown;
}

const visit = handler<
  Record<string, never>,
  { charm: any }
>((_, state) => {
  return navigateTo(state.charm);
}, { proxy: true });

const removeCharm = handler<
  Record<string, never>,
  {
    charm: any;
    allCharms: Cell<any[]>;
  }
>((_, state) => {
  const charmName = state.charm[NAME];
  const allCharmsValue = state.allCharms.get();
  const index = allCharmsValue.findIndex((c: any) => c[NAME] === charmName);

  if (index !== -1) {
    const charmListCopy = [...allCharmsValue];
    console.log("charmListCopy before", charmListCopy);
    charmListCopy.splice(index, 1);
    console.log("charmListCopy after", charmListCopy);
    state.allCharms.set(charmListCopy);
  }
});

const spawnChatList = handler<
  Record<string, never>,
  { allCharms: Cell<Charm[]> }
>((_, state) => {
  return navigateTo(ChatList({
    selectedCharm: { charm: undefined },
    charmsList: [],
    allCharms: state.allCharms,
  }));
});

const spawnChatbot = handler<
  Record<string, never>,
  Record<string, never>
>((_, state) => {
  return navigateTo(Chatbot({
    messages: [],
    tools: undefined,
  }));
});

const spawnChatbotTools = handler<
  Record<string, never>,
  Record<string, never>
>((_, state) => {
  return navigateTo(ChatbotTools({
    title: "Chatbot Tools",
    messages: [],
    list: [],
  }));
});

const spawnChatbotOutliner = handler<
  Record<string, never>,
  { allCharms: Cell<Charm[]> }
>((_, state) => {
  return navigateTo(ChatbotOutliner({
    title: "Chatbot Outliner",
    expandChat: false,
    messages: [],
    outline: {
      root: { body: "", children: [], attachments: [] },
    },
    allCharms: state.allCharms,
  }));
});

const spawnChatbotNote = handler<
  Record<string, never>,
  { allCharms: Cell<MentionableCharm[]> }
>((_, state) => {
  return navigateTo(ChatbotNote({
    title: "New Note",
    content: "",
    expandChat: false,
    messages: [],
    allCharms: state.allCharms,
  }));
});

const spawnNote = handler<
  Record<string, never>,
  { allCharms: Cell<MentionableCharm[]> }
>((_, state) => {
  return navigateTo(Note({
    title: "New Note",
    content: "",
    allCharms: state.allCharms,
  }));
});

export default recipe<CharmsListInput, CharmsListOutput>(
  "DefaultCharmList",
  ({ allCharms }) => {
    return {
      [NAME]: str`DefaultCharmList (${allCharms.length})`,
      [UI]: (
        <ct-screen>
          <ct-keybind
            code="KeyN"
            alt
            preventDefault
            onct-keybind={spawnChatbotNote({
              allCharms: allCharms as unknown as OpaqueRef<MentionableCharm[]>,
            })}
          />

          <ct-vstack gap="4" padding="6">
            {/* Quick Launch Toolbar */}
            <ct-hstack gap="2" align="center">
              <h3>Quicklaunch:</h3>
              <ct-button
                onClick={spawnChatList({
                  allCharms: allCharms as unknown as OpaqueRef<
                    MentionableCharm[]
                  >,
                })}
              >
                📂 Chat List
              </ct-button>
              <ct-button
                onClick={spawnChatbot({})}
              >
                💬 Chatbot
              </ct-button>
              <ct-button
                onClick={spawnChatbotTools({})}
              >
                🔧 Chatbot Tools
              </ct-button>
              <ct-button
                onClick={spawnChatbotOutliner({ allCharms })}
              >
                📝 Chatbot Outliner
              </ct-button>
              <ct-button
                onClick={spawnChatbotNote({
                  // slight disagreement between Charm types but they are compatible
                  allCharms: allCharms as unknown as OpaqueRef<
                    MentionableCharm[]
                  >,
                })}
              >
                🤖 Chatbot Note
              </ct-button>
              <ct-button
                onClick={spawnNote({ // slight disagreement between Charm types but they are compatible
                  allCharms: allCharms as unknown as OpaqueRef<
                    MentionableCharm[]
                  >,
                })}
              >
                📄 Note
              </ct-button>
            </ct-hstack>

            <h2>Charms ({allCharms.length})</h2>

            <ct-table full-width hover>
              <thead>
                <tr>
                  <th>Charm Name</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {derive(allCharms, (allCharms) =>
                  allCharms.map((charm: any) => (
                    <tr>
                      <td>{charm[NAME] || "Untitled Charm"}</td>
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
                  )))}
              </tbody>
            </ct-table>
          </ct-vstack>
        </ct-screen>
      ),
    };
  },
);
