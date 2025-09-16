/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  cell,
  Default,
  derive,
  fetchData,
  generateObject,
  h,
  handler,
  ifElse,
  JSONSchema,
  lift,
  llm,
  llmDialog,
  NAME,
  recipe,
  str,
  Stream,
  UI,
} from "commontools";

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
    { messages, pending }: {
      messages: Cell<Array<BuiltInLLMMessage>>;
      pending: Cell<boolean | undefined>;
    },
  ) => {
    messages.set([]);
    pending.set(false);
  },
);

type ChatInput = {
  messages: Default<Array<BuiltInLLMMessage>, []>;
  tools: any;
  theme?: any;
};

type ChatOutput = {
  messages: Array<BuiltInLLMMessage>;
  pending: boolean | undefined;
  addMessage: Stream<BuiltInLLMMessage>;
  cancelGeneration: Stream<void>;
  title?: string;
};

export const TitleGenerator = recipe<
  { model?: string; messages: Array<BuiltInLLMMessage> }
>("Title Generator", ({ model, messages }) => {
  const titleMessages = derive(messages, (m) => {
    if (!m || m.length === 0) return "";

    const messageCount = 2;
    const selectedMessages = m.slice(0, messageCount).filter(Boolean);

    if (selectedMessages.length === 0) return "";

    return selectedMessages.map((msg) => JSON.stringify(msg)).join("\n");
  });

  const { result } = generateObject({
    system:
      "Generate at most a 3-word title based on the following content, respond with NOTHING but the literal title text.",
    prompt: titleMessages,
    model,
    schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "The title of the chat",
        },
      },
      required: ["title"],
    },
  });

  const title = derive(result, (t) => {
    return t?.title || "Untitled Chat";
  });

  return title;
});

export default recipe<ChatInput, ChatOutput>(
  "Chat",
  ({ messages, tools, theme }) => {
    const model = cell<string>("anthropic:claude-sonnet-4-0");

    const { addMessage, cancelGeneration, pending } = llmDialog({
      system: "You are a helpful assistant with some tools.",
      messages,
      tools,
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

    const title = TitleGenerator({ model, messages });

    return {
      [NAME]: title,
      [UI]: (
        <ct-screen>
          <ct-hstack justify="between" slot="header">
            <div>
              <h2>{title}</h2>
            </div>

            <div>
              <ct-button
                id="clear-chat-button"
                onClick={clearChat({
                  messages,
                  pending,
                })}
              >
                Clear Chat
              </ct-button>
            </div>
          </ct-hstack>

          <ct-vscroll flex showScrollbar fadeEdges snapToBottom>
            <ct-chat
              theme={theme}
              $messages={messages}
              pending={pending}
              tools={tools}
            />
          </ct-vscroll>

          <div slot="footer">
            <ct-prompt-input
              placeholder="Ask the LLM a question..."
              pending={pending}
              onct-send={sendMessage({ addMessage })}
              onct-stop={cancelGeneration}
            />
            <ct-select
              items={items}
              $value={model}
            />
          </div>
        </ct-screen>
      ),
      messages,
      pending,
      addMessage,
      cancelGeneration,
      title,
    };
  },
);
