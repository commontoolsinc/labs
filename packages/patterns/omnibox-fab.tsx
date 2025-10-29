/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  handler,
  ifElse,
  NAME,
  recipe,
  UI,
} from "commontools";
import Chatbot from "./chatbot.tsx";
import { calculator, readWebpage, searchWeb } from "./common-tools.tsx";
import { MentionableCharm } from "./backlinks-index.tsx";

interface OmniboxFABInput {
  mentionable: Cell<MentionableCharm[]>;
}

const toggle = handler<any, { value: Cell<boolean> }>((_, { value }) => {
  value.set(!value.get());
});

const closeFab = handler<any, { fabExpanded: Cell<boolean> }>(
  (_, { fabExpanded }) => {
    fabExpanded.set(false);
  },
);

const dismissPeek = handler<
  any,
  { peekDismissedIndex: Cell<number>; assistantMessageCount: number }
>((_, { peekDismissedIndex, assistantMessageCount }) => {
  // Store the current assistant message count so we know which message was dismissed
  peekDismissedIndex.set(assistantMessageCount);
});

export default recipe<OmniboxFABInput>(
  "OmniboxFAB",
  ({ mentionable }) => {
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

    const fabExpanded = cell(false);
    const showHistory = cell(false);
    const peekDismissedIndex = cell(-1); // Track which message index was dismissed

    // Derive assistant message count for dismiss tracking
    const assistantMessageCount = derive(
      omnibot.messages,
      (messages) => messages.filter((m) => m.role === "assistant").length,
    );

    // Derive latest assistant message for peek
    const latestAssistantMessage = derive(omnibot.messages, (messages) => {
      if (!messages || messages.length === 0) return null;

      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
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
          onct-fab-backdrop-click={closeFab({ fabExpanded })}
          onct-fab-escape={closeFab({ fabExpanded })}
          onClick={toggle({ value: fabExpanded })}
        >
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
              style={derive(
                showHistory,
                (show) =>
                  `flex: ${
                    show ? "1" : "0"
                  }; min-height: 0; display: flex; flex-direction: column; opacity: ${
                    show ? "1" : "0"
                  }; max-height: ${
                    show ? "480px" : "0"
                  }; overflow: hidden; transition: opacity 300ms ease, max-height 400ms cubic-bezier(0.34, 1.56, 0.64, 1), flex 400ms cubic-bezier(0.34, 1.56, 0.64, 1); pointer-events: ${
                    show ? "auto" : "none"
                  };`,
              )}
            >
              <div style="padding: .25rem; border-bottom: 1px solid #f0f0f0; flex-shrink: 0;">
                {omnibot.ui.attachmentsAndTools}
              </div>
              <div style="flex: 1; overflow-y: auto; min-height: 0;">
                {omnibot.ui.chatLog}
              </div>
            </div>

            {ifElse(
              derive(
                [
                  showHistory,
                  latestAssistantMessage,
                  peekDismissedIndex,
                  assistantMessageCount,
                ],
                ([show, msg, dismissedIdx, count]) =>
                  !show && msg && count !== dismissedIdx,
              ),
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
                  <ct-chat-message
                    role="assistant"
                    compact
                    content={latestAssistantMessage}
                    pending={omnibot.pending}
                  />
                </div>
              </div>,
              null,
            )}

            {/* Prompt input - always at bottom */}
            <div style="padding: 0.5rem; flex-shrink: 0;">
              {omnibot.ui.promptInput}
            </div>
          </div>
        </ct-fab>
      ),
      fabExpanded,
      sidebarUI: (
        <div>
          {omnibot.ui.attachmentsAndTools}
          {omnibot.ui.chatLog}
        </div>
      ),
    };
  },
);
