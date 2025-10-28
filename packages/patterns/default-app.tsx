/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  cell,
  derive,
  handler,
  ifElse,
  lift,
  llmDialog,
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

const toggle = handler<any, { value: Cell<boolean> }>((_, { value }) => {
  value.set(!value.get());
});

const closeFab = handler<any, { fabExpanded: Cell<boolean> }>((_, { fabExpanded }) => {
  fabExpanded.set(false);
});

const messagesToNotifications = lift<
  {
    messages: BuiltInLLMMessage[];
    seen: Cell<number>;
    notifications: Cell<{ text: string; timestamp: number }[]>;
  }
>(({ messages, seen, notifications }) => {
  if (messages.length > 0) {
    if (seen.get() >= messages.length) {
      // If messages length went backwards, reset seen counter
      if (seen.get() > messages.length) {
        seen.set(0);
      } else {
        return;
      }
    }

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
      wish<MentionableCharm[]>("#allCharms"),
      (c) => c,
    );
    const index = BacklinksIndex({ allCharms });
    const fabExpanded = cell(false);
    const showHistory = cell(false);
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

          {/* Escape key now handled by ct-fab itself */}

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
      sidebarUI: (
        <div>
          {/* TODO(bf): Remove once we fix types to not require ReactNode */}
          {omnibot.ui.attachmentsAndTools as any}
          {omnibot.ui.chatLog as any}
        </div>
      ),
      fabUI: (
        <>
          <ct-toast-stack
            $notifications={notifications}
            position="bottom-right"
            auto-dismiss={5000}
            max-toasts={5}
            style="bottom: 80px; right: 24px;"
          />
          <ct-fab
            expanded={fabExpanded}
            variant="primary"
            position="bottom-right"
            onct-fab-backdrop-click={closeFab({ fabExpanded })}
            onct-fab-escape={closeFab({ fabExpanded })}
            onClick={toggle({ value: fabExpanded })}
          >
            <div style="width: 100%; display: flex; flex-direction: column; max-height: 580px;">
              {ifElse(
                showHistory,
                <div style="flex: 1; min-height: 0; display: flex; flex-direction: column; border-bottom: 1px solid #e5e5e5;">
                  <div style="padding: 12px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #f0f0f0; flex-shrink: 0;">
                    <span style="font-size: 11px; text-transform: uppercase; color: #999; font-weight: 600; letter-spacing: 1px;">History</span>
                    <button
                      onClick={toggle({ value: showHistory })}
                      style="background: none; border: 1px solid #ddd; border-radius: 4px; padding: 4px 8px; font-size: 10px; cursor: pointer; color: #666;"
                    >
                      Hide
                    </button>
                  </div>
                  <div style="padding: 8px 12px; border-bottom: 1px solid #f0f0f0; flex-shrink: 0;">
                    {omnibot.ui.attachmentsAndTools}
                  </div>
                  <div style="flex: 1; overflow-y: auto; min-height: 0;">
                    {omnibot.ui.chatLog}
                  </div>
                </div>,
                <div style="padding: 8px; border-bottom: 1px solid #e5e5e5; text-align: center; flex-shrink: 0;">
                  <button
                    onClick={toggle({ value: showHistory })}
                    style="background: none; border: none; color: #666; font-size: 11px; cursor: pointer; padding: 4px 8px;"
                  >
                    ↓ Show History
                  </button>
                </div>,
              )}
              <div style="padding: 16px; flex-shrink: 0;">
                {omnibot.ui.promptInput}
              </div>
            </div>
          </ct-fab>
        </>
      ),
    };
  },
);
