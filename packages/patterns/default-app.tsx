/// <cts-enable />
import {
  BuiltInLLMMessage,
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
import { calculator, readWebpage, searchWeb } from "./common-tools.tsx";

export type Charm = {
  [NAME]?: string;
  [UI]?: unknown;
  [key: string]: any;
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

const toggle = handler<any, { value: Cell<boolean> }>((_, { value }) => {
  value.set(!value.get());
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
      const contentText = typeof latestMessage.content === "string"
        ? latestMessage.content
        : latestMessage.content.map((part) => {
          if (part.type === "text") {
            return part.text;
          } else if (part.type === "tool-call") {
            return `Tool call: ${part.toolName}`;
          } else if (part.type === "tool-result") {
            return part.output.type === "text"
              ? part.output.value
              : JSON.stringify(part.output.value);
          } else if (part.type === "image") {
            return "[Image]";
          }
          return "";
        }).join("");

      notifications.push({
        id: Math.random().toString(36),
        text: contentText,
        timestamp: Date.now(),
      });

      seen.set(messages.length);
    }
  }
});

export default recipe<CharmsListInput, CharmsListOutput>(
  "DefaultCharmList",
  (_) => {
    const allCharms = derive<MentionableCharm[], MentionableCharm[]>(
      wish<MentionableCharm[]>("#allCharms", []),
      (c) => c,
    );
    const index = BacklinksIndex({ allCharms });
    const fabExpanded = cell(false);
    const notifications = cell<{ text: string; timestamp: number }[]>([]);
    const seen = cell<number>(0);

    const omnibot = Chatbot({
      messages: [],
      tools: {
        searchWeb: {
          pattern: searchWeb,
        },
        readWebpage: {
          pattern: readWebpage,
        },
        calculator: {
          pattern: calculator,
        },
      },
    });

    messagesToNotifications({
      messages: omnibot.messages,
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

          <ct-keybind
            code="Escape"
            preventDefault
            onct-keybind={toggle({ value: fabExpanded })}
          />

          <ct-vstack gap="4" padding="6">
            {/* Quick Launch Toolbar */}
            <ct-hstack gap="2" align="center">
              <h3>Quicklaunch:</h3>
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
      sidebarUI: (
        <div>
          {/* TODO(bf): why any? */}
          {omnibot.ui.attachmentsAndTools as any}
          {omnibot.ui.chatLog as any}
        </div>
      ),
      fabUI: (
        <>
          <ct-toast-stack
            $notifications={notifications}
            position="top-right"
            auto-dismiss={5000}
            max-toasts={5}
          />
          {ifElse(
            fabExpanded,
            omnibot.ui.promptInput,
            <ct-button onClick={toggle({ value: fabExpanded })}>✨</ct-button>,
          )}
        </>
      ),
    };
  },
);
