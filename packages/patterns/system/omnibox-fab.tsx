/// <cts-enable />
import {
  computed,
  handler,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  patternTool,
  Stream,
  UI,
  when,
  wish,
  Writable,
} from "commontools";
import Chatbot from "../chatbot.tsx";
import {
  bash,
  calculator,
  fetchAndRunPattern,
  listPatternIndex,
  navigateToPattern,
  readWebpage,
  searchWeb,
  updateProfile,
} from "./common-tools.tsx";
import { MentionablePiece } from "./backlinks-index.tsx";

interface DoListTools {
  addItem: Stream<{ title: string; indent?: number }>;
  addItems: Stream<{ items: Array<{ title: string; indent?: number }> }>;
  removeItemByTitle: Stream<{ title: string }>;
  updateItemByTitle: Stream<{
    title: string;
    newTitle?: string;
    done?: boolean;
  }>;
  items: any[];
}

interface OmniboxFABInput {
  mentionable: Writable<MentionablePiece[]>;
  doListTools: DoListTools;
}

const toggle = handler<any, { value: Writable<boolean> }>((_, { value }) => {
  value.set(!value.get());
});

const closeFab = handler<any, { fabExpanded: Writable<boolean> }>(
  (_, { fabExpanded }) => {
    fabExpanded.set(false);
  },
);

const dismissPeek = handler<
  any,
  { peekDismissedIndex: Writable<number>; assistantMessageCount: number }
>((_, { peekDismissedIndex, assistantMessageCount }) => {
  // Store the current assistant message count so we know which message was dismissed
  peekDismissedIndex.set(assistantMessageCount);
});

/** Wish for a #tag or a custom query with optional linked context. Automatically navigates to the result. */
type WishToolParameters = { query: string; context?: Record<string, any> };

const wishTool = pattern<WishToolParameters>(
  ({ query, context }) => {
    const wishResult = wish<any>({
      query,
      context,
    });

    // Navigate to wishResult.result (the actual cell), not the entire wish state object
    return when(wishResult.result, navigateTo(wishResult.result));
  },
);

const listMentionable = pattern<
  { mentionable: Array<MentionablePiece> },
  { result: Array<{ label: string; piece: MentionablePiece }> }
>(
  ({ mentionable }) => {
    const result = mentionable.map((c) => ({
      label: c[NAME]!,
      piece: c,
    }));
    return { result };
  },
);

const listRecent = pattern<
  { recentPieces: Array<MentionablePiece> },
  { result: Array<{ label: string; piece: MentionablePiece }> }
>(
  ({ recentPieces }) => {
    const namesList = recentPieces.map((c) => ({
      label: c[NAME]!,
      piece: c,
    }));
    return { result: namesList };
  },
);

/** Read current do list items */
const readDoList = pattern<
  { items: Array<{ title: string; done: boolean; indent: number }> },
  {
    result: Array<{
      title: string;
      done: boolean;
      indent: number;
    }>;
  }
>(
  ({ items }) => {
    return { result: items };
  },
);

export default pattern<OmniboxFABInput>(
  ({ doListTools }) => {
    const mentionable =
      wish<MentionablePiece[]>({ query: "#mentionable" }).result;
    const recentPieces = wish<MentionablePiece[]>({ query: "#recent" }).result;

    const sandboxId = Writable.of(
      `omnibot-${Math.random().toString(36).slice(2, 10)}`,
    );

    const profile = wish<string>({ query: "#profile" });

    const profileContext = computed(() => {
      const profileText = profile.result;
      return profileText
        ? `\n\n--- User Context ---\n${profileText}\n---\n`
        : "";
    });

    const systemPrompt = computed(() => {
      const profileSection = profileContext;
      return `You are a polite but efficient assistant. Think Star Trek computer - helpful and professional without unnecessary conversation. Let your actions speak for themselves.
${profileSection}
Tool usage priority:
- For patterns: listPatternIndex first
- For existing pages/notes/content: listRecent or listMentionable to identify what they're referencing
- Attach relevant items to conversation after instantiation/retrieval if they support ongoing tasks
- Remove attachments when no longer relevant
- Search web only as last resort when nothing exists in the space
- Use bash to run shell commands in a persistent Linux sandbox (Ubuntu). Installed packages and files persist across calls.

Do-list management:
- When users mention tasks, action items, or things to do, use addDoItem or addDoItems
- When users paste a block of text with multiple items, parse into items and use addDoItems to batch-add
- Use readDoList to check current items before making changes
- Use updateDoItem to mark done or rename; removeDoItem only for explicit deletion
- Use indent levels for sub-tasks (0=root, 1=sub-task, 2=sub-sub-task)

Be matter-of-fact. Prefer action to explanation.`;
    });

    const omnibot = Chatbot({
      system: systemPrompt,
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
        fetchAndRunPattern: patternTool(fetchAndRunPattern),
        listPatternIndex: patternTool(listPatternIndex),
        navigateTo: patternTool(navigateToPattern),
        wishAndNavigate: patternTool(wishTool),
        listMentionable: patternTool(listMentionable, { mentionable }),
        listRecent: patternTool(listRecent, { recentPieces }),
        updateProfile: patternTool(updateProfile),
        bash: patternTool(bash, { sandboxId }),
        addDoItem: {
          handler: doListTools.addItem,
          description:
            "Add a task to the do list. Use indent for sub-tasks (0=root, 1=sub, 2=sub-sub).",
        },
        addDoItems: {
          handler: doListTools.addItems,
          description:
            "Add multiple tasks at once. Use when parsing text into items.",
        },
        removeDoItem: {
          handler: doListTools.removeItemByTitle,
          description: "Remove a task and its subtasks by title.",
        },
        updateDoItem: {
          handler: doListTools.updateItemByTitle,
          description:
            "Update a task by title. Set done=true to complete, newTitle to rename.",
        },
        readDoList: patternTool(readDoList, {
          items: doListTools.items,
        }),
      },
    });

    const fabExpanded = Writable.of(false);
    const showHistory = Writable.of(false);
    const peekDismissedIndex = Writable.of(-1); // Track which message index was dismissed

    // Derive assistant message count for dismiss tracking
    const assistantMessageCount = computed(() => {
      return omnibot.messages
        ? omnibot.messages.filter((m) => m.role === "assistant").length
        : 0;
    });

    // Derive latest assistant message for peek
    const latestAssistantMessage = computed(() => {
      if (!omnibot.messages || omnibot.messages.length === 0) return null;

      for (let i = omnibot.messages.length - 1; i >= 0; i--) {
        const msg = omnibot.messages[i];
        if (msg.role === "assistant") {
          const content = typeof msg.content === "string"
            ? msg.content
            : msg.content.map((part: any) => {
              if (part.type === "text") return part.text;
              return "";
            }).join("");

          return content;
        }
      }
      return null;
    });

    return {
      [NAME]: "OmniboxFAB",
      messages: omnibot.messages,
      [UI]: (
        <ct-fab
          expanded={fabExpanded}
          variant="primary"
          position="bottom-right"
          pending={omnibot.pending}
          $previewMessage={latestAssistantMessage}
          onct-fab-backdrop-click={closeFab({ fabExpanded })}
          onct-fab-escape={closeFab({ fabExpanded })}
          onClick={toggle({ value: fabExpanded })}
        >
          {ifElse(
            fabExpanded,
            <div style="width: 100%; display: flex; flex-direction: column; max-height: 580px;">
              {/* Chevron at top - the "handle" for the drawer */}
              <div style="border-bottom: 1px solid #e5e5e5; flex-shrink: 0;">
                <ct-chevron-button
                  expanded={showHistory}
                  loading={omnibot.pending}
                  onct-toggle={toggle({ value: showHistory })}
                />
              </div>

              <div
                style={computed(() => {
                  const show = showHistory.get();
                  return `flex: ${
                    show ? "1" : "0"
                  }; min-height: 0; display: flex; flex-direction: column; opacity: ${
                    show ? "1" : "0"
                  }; max-height: ${
                    show ? "480px" : "0"
                  }; overflow: hidden; transition: opacity 300ms ease, max-height 400ms cubic-bezier(0.34, 1.56, 0.64, 1), flex 400ms cubic-bezier(0.34, 1.56, 0.64, 1); pointer-events: ${
                    show ? "auto" : "none"
                  };`;
                })}
              >
                <div style="padding: .25rem; flex-shrink: 0;">
                  {omnibot.ui.attachmentsAndTools}
                </div>
                <div style="flex: 1; overflow-y: auto; min-height: 0;">
                  <ct-cell-context $cell={omnibot}>
                    {omnibot.ui.chatLog}
                  </ct-cell-context>
                </div>
              </div>

              {ifElse(
                computed(() => {
                  const show = showHistory.get();
                  const dismissedIdx = peekDismissedIndex.get();
                  return !show && latestAssistantMessage &&
                    assistantMessageCount !== dismissedIdx;
                }),
                <div style="margin: .5rem; margin-bottom: 0; padding: 0; flex-shrink: 0; position: relative;">
                  <ct-button
                    variant="ghost"
                    size="icon"
                    onClick={dismissPeek({
                      peekDismissedIndex,
                      assistantMessageCount,
                    })}
                    style="position: absolute; top: 0px; right: 0px; z-index: 1; font-size: 16px;"
                    title="Dismiss"
                  >
                    ×
                  </ct-button>
                  <div
                    onClick={toggle({ value: showHistory })}
                    style="cursor: pointer;"
                  >
                    <ct-cell-context $cell={latestAssistantMessage}>
                      <ct-chat-message
                        role="assistant"
                        compact
                        content={latestAssistantMessage}
                        pending={omnibot.pending}
                      />
                    </ct-cell-context>
                  </div>
                </div>,
                null,
              )}

              {/* Prompt input - always at bottom */}
              <div style="padding: 0.5rem; flex-shrink: 0;">
                {omnibot.ui.promptInput}
              </div>
            </div>,
            null,
          )}
        </ct-fab>
      ),
      fabExpanded,
    };
  },
);
