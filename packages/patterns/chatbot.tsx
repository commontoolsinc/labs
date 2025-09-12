/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  cell,
  Default,
  derive,
  fetchData,
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
}

type ChatOutput = {
  messages: Array<BuiltInLLMMessage>;
  pending: boolean | undefined;
  addMessage: Stream<BuiltInLLMMessage>;
  cancelGeneration: Stream<void>;
}

export default recipe<ChatInput, ChatOutput>(
  "Chat",
  ({ messages, tools }) => {
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

    return {
      [NAME]: "Chat",
      [UI]: (
        <ct-screen>
          <ct-hstack justify="between" slot="header">
            <div>
            <h2>Chat</h2>
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
            <ct-chat $messages={messages} pending={pending} tools={tools} />
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
    };
  },
);
