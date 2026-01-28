/// <cts-enable />
import {
  computed,
  handler,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  patternTool,
  UI,
  when,
  wish,
  Writable,
} from "commontools";
import Chatbot from "../chatbot.tsx";
import {
  calculator,
  fetchAndRunPattern,
  listPatternIndex,
  navigateToPattern,
  readWebpage,
  searchWeb,
  updateProfile,
} from "./common-tools.tsx";
import { MentionableCharm } from "./backlinks-index.tsx";

interface OmniboxFABInput {
  mentionable: Writable<MentionableCharm[]>;
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
  { mentionable: Array<MentionableCharm> },
  { result: Array<{ label: string; charm: MentionableCharm }> }
>(
  ({ mentionable }) => {
    const result = mentionable.map((c) => ({
      label: c[NAME]!,
      charm: c,
    }));
    return { result };
  },
);

const listRecent = pattern<
  { recentCharms: Array<MentionableCharm> },
  { result: Array<{ label: string; charm: MentionableCharm }> }
>(
  ({ recentCharms }) => {
    const namesList = recentCharms.map((c) => ({
      label: c[NAME]!,
      charm: c,
    }));
    return { result: namesList };
  },
);

export default pattern<OmniboxFABInput>(
  (_) => {
    const mentionable = wish<MentionableCharm[]>("#mentionable");
    const recentCharms = wish<MentionableCharm[]>("#recent");

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
        listRecent: patternTool(listRecent, { recentCharms }),
        updateProfile: patternTool(updateProfile),
      },
    });

    const fabExpanded = Writable.of(false);
    const showHistory = Writable.of(false);
    const peekDismissedIndex = Writable.of(-1); // Track which message index was dismissed

    // Derive assistant message count for dismiss tracking
    const assistantMessageCount = computed(() => {
      return omnibot.messages.filter((m) => m.role === "assistant").length;
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
