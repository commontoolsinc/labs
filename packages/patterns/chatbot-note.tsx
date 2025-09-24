/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  cell,
  Default,
  derive,
  fetchData,
  getRecipeEnvironment,
  h,
  handler,
  ID,
  ifElse,
  JSONSchema,
  lift,
  llm,
  llmDialog,
  NAME,
  navigateTo,
  OpaqueRef,
  recipe,
  str,
  Stream,
  toSchema,
  UI,
} from "commontools";

import Chat from "./chatbot.tsx";

export type MentionableCharm = {
  [NAME]: string;
  content?: string;
  mentioned?: MentionableCharm[];
};

type NoteResult = {
  content: Default<string, "">;
};

export type NoteInput = {
  content: Default<string, "">;
  allCharms: Cell<MentionableCharm[]>;
};

const handleCharmLinkClick = handler<
  {
    detail: {
      charm: Cell<MentionableCharm>;
    };
  },
  Record<string, never>
>(({ detail }, _) => {
  return navigateTo(detail.charm);
});

const handleCharmLinkClicked = handler(
  (_: any, { charm }: { charm: Cell<MentionableCharm> }) => {
    return navigateTo(charm);
  },
);

type LLMTestInput = {
  title: Default<string, "LLM Test">;
  messages: Default<Array<BuiltInLLMMessage>, []>;
  expandChat: Default<boolean, false>;
  content: Default<string, "">;
  allCharms: Cell<MentionableCharm[]>;
};

type LLMTestResult = {
  messages: Default<Array<BuiltInLLMMessage>, []>;
  mentioned: Default<Array<MentionableCharm>, []>;
  backlinks: Default<Array<MentionableCharm>, []>;
  content: Default<string, "">;
};

// put a note at the end of the outline (by appending to root.children)
const editNote = handler<
  {
    /** The text content of the note */
    body: string;
    /** A cell to store the result message indicating success or error */
    result: Cell<string>;
  },
  { content: Cell<string> }
>(
  (args, state) => {
    try {
      state.content.set(args.body);

      args.result.set(
        `Updated note!`,
      );
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

const readNote = handler<
  {
    /** A cell to store the result text */
    result: Cell<string>;
  },
  { content: string }
>(
  (args, state) => {
    try {
      args.result.set(state.content);
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

export default recipe<LLMTestInput, LLMTestResult>(
  "Note",
  ({ title, expandChat, messages, content, allCharms }) => {
    const tools = {
      editNote: {
        description: "Modify the shared note.",
        inputSchema: {
          type: "object",
          properties: {
            body: {
              type: "string",
              description: "The content of the note.",
            },
          },
          required: ["body"],
        } as JSONSchema,
        handler: editNote({ content }),
      },
      readNote: {
        description: "Read the shared note.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        } as JSONSchema,
        handler: readNote({ content }),
      },
    };

    const chat = Chat({ messages, tools });
    const { addMessage, cancelGeneration, pending } = chat;

    const mentioned = cell<MentionableCharm[]>([]);

    // why does MentionableCharm behave differently than any here?
    // perhaps optional properties?
    const computeBacklinks = lift(
      toSchema<
        { allCharms: Cell<any[]>; content: Cell<string> }
      >(),
      toSchema<any[]>(),
      ({ allCharms, content }) => {
        const cs: readonly MentionableCharm[] = allCharms.get();
        if (!cs) return [];

        const self = cs.find((c) => c.content === content.get());

        const results = self
          ? cs.filter((c) =>
            c.mentioned?.some((m) => m.content === self.content) ?? false
          )
          : [];

        return results;
      },
    );

    const backlinks: OpaqueRef<MentionableCharm[]> = computeBacklinks({
      allCharms,
      content,
    });

    return {
      [NAME]: title,
      [UI]: (
        <ct-screen>
          <ct-hstack justify="between" slot="header">
            <div></div>
            <div>
              <ct-checkbox $checked={expandChat}>Show Chat</ct-checkbox>
            </div>
          </ct-hstack>

          <ct-autolayout tabNames={["Chat", "Tools"]}>
            <ct-screen>
              <div slot="header">
                <ct-input
                  $value={title}
                  placeholder="Enter title..."
                />
              </div>

              <ct-code-editor
                $value={content}
                $mentionable={allCharms}
                $mentioned={mentioned}
                onbacklink-click={handleCharmLinkClick({})}
                language="text/markdown"
                wordWrap
                tabIndent
                lineNumbers
              />
              <details>
                <summary>Mentioned Charms</summary>
                <ct-vstack>
                  {mentioned.map((charm: MentionableCharm) => (
                    <ct-button onClick={handleCharmLinkClicked({ charm })}>
                      {charm[NAME]}
                    </ct-button>
                  ))}
                </ct-vstack>
              </details>
              <details>
                <summary>Backlinks</summary>
                <ct-vstack>
                  {backlinks.map((charm: MentionableCharm) => (
                    <ct-button onClick={handleCharmLinkClicked({ charm })}>
                      {charm[NAME]}
                    </ct-button>
                  ))}
                </ct-vstack>
              </details>
            </ct-screen>

            {ifElse(
              expandChat,
              chat,
              null,
            )}
          </ct-autolayout>
        </ct-screen>
      ),
      content,
      messages,
      mentioned,
      backlinks,
    };
  },
);
