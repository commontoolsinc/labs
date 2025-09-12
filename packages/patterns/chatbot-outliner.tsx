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
  UI,
} from "commontools";

type Charm = any;

type OutlinerNode = {
  body: Default<string, "">;
  children: Default<OutlinerNode[], []>;
  attachments: Default<OpaqueRef<any>[], []>;
};

type Outliner = {
  root: OutlinerNode;
};

type PageResult = {
  outline: Default<
    Outliner,
    { root: { body: ""; children: []; attachments: [] } }
  >;
};

export type PageInput = {
  outline: Outliner;
  allCharms: Cell<Charm[]>;
};

const handleCharmLinkClick = handler<
  {
    detail: {
      charm: Cell<Charm>;
    };
  },
  Record<string, never>
>(({ detail }, _) => {
  return navigateTo(detail.charm);
});

export const Page = recipe<PageInput>(
  "Page",
  ({ outline, allCharms }) => {
    return {
      [NAME]: "Page",
      [UI]: (
        <ct-outliner
          $value={outline as any}
          $mentionable={allCharms}
          oncharm-link-click={handleCharmLinkClick({})}
        />
      ),
      outline,
    };
  },
);

type LLMTestInput = {
  title: Default<string, "LLM Test">;
  chat: Default<Array<BuiltInLLMMessage>, []>;
  outline: Default<
    Outliner,
    { root: { body: "Untitled Page"; children: []; attachments: [] } }
  >;
  allCharms: Cell<Charm[]>;
};

type LLMTestResult = {
  chat: Default<Array<BuiltInLLMMessage>, []>;
};

// put a node at the end of the outline (by appending to root.children)
const appendOutlinerNode = handler<
  {
    /** The text content/title of the outliner node to be appended */
    body: string;
    /** A cell to store the result message indicating success or error */
    result: Cell<string>;
  },
  { outline: Cell<Outliner> }
>(
  (args, state) => {
    try {
      (state.outline.key("root").key("children")).push({
        body: args.body,
        children: [],
        attachments: [],
      });

      args.result.set(
        `${state.outline.key("root").key("children").get().length} nodes`,
      );
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

const sendMessage = handler<
  { detail: { message: string } },
  {
    addMessage: Stream<BuiltInLLMMessage>;
  }
>((event, { addMessage }) => {
  addMessage.send({
    role: "user",
    content: [{ type: "text", text: event.detail.message }],
  });
});

const clearChat = handler(
  (
    _: never,
    { chat, llmResponse }: {
      chat: Cell<Array<BuiltInLLMMessage>>;
      llmResponse: {
        pending: Cell<boolean>;
      };
    },
  ) => {
    chat.set([]);
    llmResponse.pending.set(false);
  },
);

export default recipe<LLMTestInput, LLMTestResult>(
  "LLM Test",
  ({ title, chat, outline, allCharms }) => {
    const calculatorResult = cell<string>("");
    const model = cell<string>("anthropic:claude-sonnet-4-0");
    const searchWebResult = cell<string>("");
    const readWebpageResult = cell<string>("");

    const tools = {
      appendOutlinerNode: {
        description: "Add a new outliner node.",
        inputSchema: {
          type: "object",
          properties: {
            body: {
              type: "string",
              description: "The title of the new node.",
            },
          },
          required: ["body"],
        } as JSONSchema,
        handler: appendOutlinerNode({ outline }),
      },
    };

    const { addMessage, cancelGeneration, pending } = llmDialog({
      system: "You are a helpful assistant with some tools.",
      messages: chat,
      tools: tools,
      model,
    });

    const { result } = fetchData({
      url: "/api/ai/llm/models",
      mode: "json",
    });

    const items = derive(result, (models) => {
      if (!models) return [];
      const items = Object.keys(models as any).map((key) => ({
        label: key,
        value: key,
      }));
      return items;
    });

    return {
      [NAME]: title,
      [UI]: (
        <ct-screen>
          <ct-hstack justify="between" slot="header">
            <ct-button
              id="clear-chat-button"
              onClick={clearChat({
                chat,
                llmResponse: { pending },
              })}
            >
              Clear Chat
            </ct-button>

            <div>
              <ct-select
                items={items}
                $value={model}
              />
            </div>
          </ct-hstack>

          <ct-autolayout tabNames={["Chat", "Tools"]}>
            <ct-screen>
              <ct-vscroll flex showScrollbar fadeEdges snapToBottom>
                <ct-chat $messages={chat} pending={pending} tools={tools} />
              </ct-vscroll>

              <div slot="footer">
                <ct-prompt-input
                  placeholder="Ask the LLM a question..."
                  pending={pending}
                  onct-send={sendMessage({ addMessage })}
                  onct-stop={cancelGeneration}
                />
              </div>
            </ct-screen>

            <ct-vscroll flex showScrollbar fadeEdges snapToBottom>
              <ct-vstack data-label="Tools">
                <Page outline={outline} allCharms={allCharms} />
              </ct-vstack>
            </ct-vscroll>
          </ct-autolayout>
        </ct-screen>
      ),
      chat,
    };
  },
);
