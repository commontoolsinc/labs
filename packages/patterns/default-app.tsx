/// <cts-enable />
import {
  type BuiltInLLMMessage,
  Cell,
  cell,
  derive,
  handler,
  ifElse,
  lift,
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

const messagesToNotifications = lift<
  {
    messages: BuiltInLLMMessage[];
    seen: Cell<number>;
    notifications: Cell<{ id: string; text: string; timestamp: number }[]>;
  }
>(({ messages, seen, notifications }) => {
  if (messages.length > 0) {
    if (seen.get() >= messages.length) return;

    const latestMessage = messages[messages.length - 1];
    if (latestMessage.role === "assistant") {
      seen.set(messages.length);

      const contentText = typeof latestMessage.content === "string"
        ? latestMessage.content
        : latestMessage.content.map((part: any) => {
          if (part.type === "text") return part.text;
          if (part.type === "image") {
            return "[Image]";
          }
          return "";
        }).join("");

      notifications.set([
        ...notifications.get(),
        {
          id: `${Date.now()}`,
          text: contentText,
          timestamp: Date.now(),
        },
      ]);
    }
  } else {
    seen.set(0);
    notifications.set([]);
  }
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

    const notifications = cell<
      { id: string; text: string; timestamp: number }[]
    >([]);
    const seen = cell<number>(0);

    messagesToNotifications({
      messages: fab.messages,
      seen: seen as unknown as Cell<number>,
      notifications: notifications as unknown as Cell<
        { id: string; text: string; timestamp: number }[]
      >,
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
      sidebarUI: fab.sidebarUI,
      fabUI: (
        <>
          <ct-toast-stack
            $notifications={notifications}
            position="bottom-right"
            auto-dismiss={5000}
            max-toasts={5}
            suppress={fab.fabExpanded}
          />
          {fab[UI]}
        </>
      ),
    };
  },
);
