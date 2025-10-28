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

const dismissPeek = handler<any, { peekDismissed: Cell<boolean> }>(
  (_, { peekDismissed }) => {
    peekDismissed.set(true);
  },
);

const sendMessage = handler<
  {
    detail: {
      text: string;
      attachments: any[];
      mentions: any[];
    };
  },
  { addMessage: any }
>((event, { addMessage }) => {
  const { text } = event.detail;
  addMessage.send({
    role: "user",
    content: text,
  });
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
    const peekDismissed = cell(false);

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

          // Reset peek dismissal when new message arrives
          peekDismissed.set(false);

          return content;
        }
      }
      return null;
    });

    return {
      [NAME]: "OmniboxFAB",
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
            <div
              style={derive(
                showHistory,
                (show) =>
                  `flex: ${
                    show ? "1" : "0"
                  }; min-height: 0; display: flex; flex-direction: column; border-bottom: 1px solid #e5e5e5; opacity: ${
                    show ? "1" : "0"
                  }; max-height: ${
                    show ? "480px" : "0"
                  }; overflow: hidden; transition: opacity 300ms ease, max-height 400ms cubic-bezier(0.34, 1.56, 0.64, 1), flex 400ms cubic-bezier(0.34, 1.56, 0.64, 1); pointer-events: ${
                    show ? "auto" : "none"
                  };`,
              )}
            >
              <div style="padding: 12px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #f0f0f0; flex-shrink: 0;">
                <span style="font-size: 11px; text-transform: uppercase; color: #999; font-weight: 600; letter-spacing: 1px;">
                  History
                </span>
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
            </div>
            <div
              style={derive(
                showHistory,
                (show) =>
                  `padding: 8px; border-bottom: 1px solid #e5e5e5; text-align: center; flex-shrink: 0; opacity: ${
                    show ? "0" : "1"
                  }; max-height: ${
                    show ? "0" : "48px"
                  }; overflow: hidden; transition: opacity 300ms ease, max-height 400ms cubic-bezier(0.34, 1.56, 0.64, 1); pointer-events: ${
                    show ? "none" : "auto"
                  };`,
              )}
            >
              <button
                onClick={toggle({ value: showHistory })}
                style="background: none; border: none; color: #666; font-size: 11px; cursor: pointer; padding: 4px 8px;"
              >
                ↓ Show History
              </button>
            </div>
            {ifElse(
              derive(
                [showHistory, latestAssistantMessage, peekDismissed],
                ([show, msg, dismissed]) => !show && msg && !dismissed,
              ),
              <div style="margin: 12px; padding: 0; flex-shrink: 0; position: relative;">
                <button
                  onClick={dismissPeek({ peekDismissed })}
                  style="position: absolute; top: 8px; right: 8px; z-index: 1; background: rgba(255, 255, 255, 0.9); border: 1px solid #ddd; border-radius: 4px; width: 24px; height: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px; color: #666; padding: 0;"
                  title="Dismiss"
                >
                  ×
                </button>
                <div
                  onClick={toggle({ value: showHistory })}
                  style="cursor: pointer;"
                >
                  <ct-chat-message
                    role="assistant"
                    content={latestAssistantMessage}
                  />
                </div>
                <div
                  onClick={toggle({ value: showHistory })}
                  style="font-size: 10px; color: #666; margin-top: 8px; text-align: right; cursor: pointer; padding-right: 8px;"
                >
                  Click to view full history →
                </div>
              </div>,
              null,
            )}
            <div style="padding: 16px; flex-shrink: 0;">
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
