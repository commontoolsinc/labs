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

const handleNewBacklink = handler<
  {
    detail: {
      text: string;
    };
  },
  {
    allCharms: Cell<MentionableCharm[]>;
  }
>(({ detail }, { allCharms }) => {
  console.log("new charm", detail.text);
  const n = ChatbotNote({
    title: detail.text,
    content: "",
    allCharms,
    messages: [],
    expandChat: false,
  });

  return navigateTo(n);
});

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

const ChatbotNote = recipe<LLMTestInput, LLMTestResult>(
  "Chatbot Note",
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
    const computeBacklinks = lift<
      { allCharms: Cell<MentionableCharm[]>; content: Cell<string> },
      any[]
    >(
      ({ allCharms, content }) => {
        const cs = allCharms.get();
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
      content: content as unknown as Cell<string>, // TODO(bf): this is valid, but types complain
    });

    const sidebar = (
      <>
        <div>
          <label>Backlinks</label>
          <ct-vstack>
            {backlinks.map((charm: MentionableCharm) => (
              <ct-button onClick={handleCharmLinkClicked({ charm })}>
                {charm[NAME]}
              </ct-button>
            ))}
          </ct-vstack>
        </div>
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
      </>
    );

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
                onbacklink-create={handleNewBacklink({
                  allCharms: allCharms as unknown as OpaqueRef<
                    MentionableCharm[]
                  >,
                })}
                language="text/markdown"
                wordWrap
                tabIndent
                lineNumbers
              />
            </ct-screen>

            <aside slot="left">
              Coming soon... chat list.
            </aside>

            <aside slot="right">
              {ifElse(
                expandChat,
                chat,
                sidebar,
              ) as any}
              {/* TODO(bf): why is this not compliant with JSX types? */}
            </aside>
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

export default ChatbotNote;
