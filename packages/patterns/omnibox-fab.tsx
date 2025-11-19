/// <cts-enable />
import {
  Cell,
  compileAndRun,
  computed,
  fetchData,
  fetchProgram,
  handler,
  ifElse,
  NAME,
  navigateTo,
  patternTool,
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

/**
 * `fetchAndRunPattern({ url: "https://...", args: {} })`
 *
 * Instantiates patterns (e.g. from listPatternIndex) and returns the cell that
 * contains the results. The instantiated pattern will keep running and updating
 * the cell. Pass the resulting cell to `navigateTo` to show the pattern's UI.
 *
 * Pass in arguments to initialize the pattern. It's especially useful to pass
 * in links to other cells as `{ "@link": "/of:bafe.../path/to/data" }`.
 */
type FetchAndRunPatternInput = {
  url: string;
  args: Cell<any>;
};
const fetchAndRunPattern = recipe<FetchAndRunPatternInput>(
  ({ url, args }) => {
    const { pending: _fetchPending, result: program, error: _fetchError } =
      fetchProgram({ url });

    const { pending, result, error } = compileAndRun({
      files: program.files,
      main: program.main,
      input: args,
    });

    return ifElse(
      computed(() => pending || (!result && !error)),
      undefined,
      {
        cell: result,
        error,
      },
    );
  },
);

/**
 * `navigateTo({ cell: { "@link": "/of:xyz" } })` - Navigates to that cell's UI
 *
 * Especially useful after instantiating a pattern with fetchAndRunPattern:
 * Pass the "@link" you get at `cell` to navigate to the pattern's view.
 */
type NavigateToPatternInput = { cell: Cell<any> }; // Hack to steer LLM
const navigateToPattern = recipe<NavigateToPatternInput>(
  ({ cell }) => {
    const success = navigateTo(cell);

    return ifElse(success, { success }, undefined);
  },
);

/**
 * `listPatternIndex()` - Returns the index of patterns.
 *
 * Useful as input to fetchAndRun.
 */
type ListPatternIndexInput = Record<string, never>;

const listPatternIndex = recipe<ListPatternIndexInput>(
  ({ _ }) => {
    const { pending, result } = fetchData({
      url: "/api/patterns/index.md",
      mode: "text",
    });
    return ifElse(computed(() => pending || !result), undefined, { result });
  },
);

export default recipe<OmniboxFABInput>(
  "OmniboxFAB",
  (_) => {
    const omnibot = Chatbot({
      system:
        "You are a polite but efficient assistant. Think Star Trek computer - helpful and professional without unnecessary conversation. Let your actions speak for themselves.\n\nTool usage priority:\n- For patterns: listPatternIndex first\n- For existing pages/notes/content: listRecent or listMentionable to identify what they're referencing\n- Attach relevant items to conversation after instantiation/retrieval if they support ongoing tasks\n- Remove attachments when no longer relevant\n- Search web only as last resort when nothing exists in the space\n\nBe matter-of-fact. Prefer action to explanation.",
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
      },
    });

    const fabExpanded = Cell.of(false);
    const showHistory = Cell.of(false);
    const peekDismissedIndex = Cell.of(-1); // Track which message index was dismissed

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
          expanded={computed(() => fabExpanded.get())}
          variant="primary"
          position="bottom-right"
          pending={omnibot.pending}
          $previewMessage={latestAssistantMessage}
          onct-fab-backdrop-click={closeFab({ fabExpanded })}
          onct-fab-escape={closeFab({ fabExpanded })}
          onClick={toggle({ value: fabExpanded })}
        >
          <div style="width: 100%; display: flex; flex-direction: column; max-height: 580px;">
            {/* Chevron at top - the "handle" for the drawer */}
            <div style="border-bottom: 1px solid #e5e5e5; flex-shrink: 0;">
              <ct-chevron-button
                expanded={computed(() => showHistory.get())}
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
                {omnibot.ui.chatLog}
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
    };
  },
);
