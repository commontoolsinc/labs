/// <cts-enable />
import {
  BuiltInLLMMessage,
  computed,
  Default,
  fetchData,
  generateObject,
  handler,
  llmDialog,
  NAME,
  pattern,
  Stream,
  UI,
  VNode,
  wish,
  Writable,
} from "commontools";
import { type MentionablePiece } from "./system/backlinks-index.tsx";

const sendMessage = handler<
  {
    detail: {
      text: string;
      attachments: Array<PromptAttachment>;
      mentions: Array<any>;
      message: string; // Backward compatibility
    };
  },
  {
    addMessage: Stream<BuiltInLLMMessage>;
  }
>((event, { addMessage }) => {
  const { text } = event.detail;

  // Send the message as-is. Any markdown links like [name](/of:...)
  // are just text that the LLM can parse and use with addAttachment() tool.
  addMessage.send({
    role: "user",
    content: [{ type: "text" as const, text }],
  });
});

const clearChat = handler(
  (
    _: never,
    { messages, pending }: {
      messages: Writable<Array<BuiltInLLMMessage>>;
      pending: Writable<boolean | undefined>;
    },
  ) => {
    messages.set([]);
    pending.set(false);
  },
);

type ChatInput = {
  messages?: Writable<Default<Array<BuiltInLLMMessage>, []>>;
  tools?: any;
  theme?: any;
  system?: string;
};

type PromptAttachment = {
  id: string;
  name: string;
  type: "file" | "clipboard" | "mention";
  data?: any; // File | Blob | string
  piece?: any;
  removable?: boolean; // Whether this attachment can be removed
};

type ChatOutput = {
  messages: Array<BuiltInLLMMessage>;
  pending: boolean | undefined;
  addMessage: Stream<BuiltInLLMMessage>;
  clearChat: Stream<void>;
  cancelGeneration: Stream<void>;
  title?: string;
  pinnedCells: Array<{ path: string; name: string }>;
  tools: any;
  ui: {
    chatLog: VNode;
    promptInput: VNode;
    attachmentsAndTools: VNode;
  };
};

export const TitleGenerator = pattern<
  { model?: string; messages: Array<BuiltInLLMMessage> }
>(({ model, messages }) => {
  const previewMessage = computed(() => {
    if (!messages || messages.length === 0) return "";

    const firstMessage = messages[0];

    if (!firstMessage) return "";

    return JSON.stringify(firstMessage);
  });

  const { result } = generateObject({
    system:
      "Generate at most a 3-word title based on the following content, respond with NOTHING but the literal title text.",
    prompt: previewMessage,
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

  const title = computed(() => {
    return result?.title || "Untitled Chat";
  });

  return title;
});

export default pattern<ChatInput, ChatOutput>(
  ({ messages, tools, theme, system }) => {
    const model = Writable.of<string>("anthropic:claude-sonnet-4-5");
    const mentionable = wish<MentionablePiece[]>("#mentionable");
    const recentPieces = wish<{ [NAME]: string }[]>("#recent");

    const latest = computed(() => recentPieces[0]);
    const latestName = computed(() => recentPieces[0]?.[NAME] ?? "latest");

    const {
      addMessage,
      cancelGeneration,
      pending,
      flattenedTools,
      pinnedCells,
    } = llmDialog(
      {
        system: computed(() => {
          return system ?? "You are a polite but efficient assistant.";
        }),
        messages,
        tools,
        model,
        context: computed(() => ({
          [latestName]: latest,
        })),
      },
    );

    const { result } = fetchData({
      url: "/api/ai/llm/models",
      mode: "json",
    });

    const items = computed(() => {
      if (!result) return [];
      const items = Object.keys(result as any).map((key) => ({
        label: key,
        value: key,
      }));
      return items;
    });

    const title = TitleGenerator({ model, messages });

    const promptInput = (
      <ct-prompt-input
        slot="footer"
        placeholder="Ask the LLM a question..."
        pending={pending}
        $mentionable={mentionable}
        modelItems={items}
        $model={model}
        onct-send={sendMessage({ addMessage })}
        onct-stop={cancelGeneration}
      />
    );

    const chatLog = (
      <ct-vscroll
        style="padding: 1rem;"
        flex
        showScrollbar
        fadeEdges
        snapToBottom
      >
        <ct-chat
          theme={theme}
          $messages={messages}
          pending={pending}
        />
      </ct-vscroll>
    );

    const attachmentsAndTools = (
      <ct-hstack align="center" gap="1">
        <ct-cell-context $cell={pinnedCells}>
          <ct-attachments-bar pinnedCells={pinnedCells} />
        </ct-cell-context>
        <ct-tools-chip $tools={flattenedTools} />
        <ct-button
          variant="pill"
          type="button"
          title="Clear chat"
          onClick={clearChat({
            messages,
            pending,
          })}
        >
          Clear
        </ct-button>
      </ct-hstack>
    );

    return {
      [NAME]: title,
      [UI]: (
        <ct-screen>
          <ct-vstack slot="header">
            <ct-heading level={4}>{title}</ct-heading>
            {attachmentsAndTools}
          </ct-vstack>

          {chatLog}

          {promptInput}
        </ct-screen>
      ),
      messages,
      pending,
      addMessage,
      clearChat: clearChat({
        messages,
        pending,
      }),
      cancelGeneration,
      title,
      pinnedCells,
      tools: flattenedTools,
      ui: {
        chatLog,
        promptInput,
        attachmentsAndTools,
      },
    };
  },
);
