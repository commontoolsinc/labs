/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  computed,
  Default,
  fetchData,
  generateObject,
  handler,
  llmDialog,
  NAME,
  recipe,
  Stream,
  UI,
  VNode,
  wish,
} from "commontools";
import { type MentionableCharm } from "./backlinks-index.tsx";

function schemaifyWish<T>(path: string) {
  return wish<T>(path);
}

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
      messages: Cell<Array<BuiltInLLMMessage>>;
      pending: Cell<boolean | undefined>;
    },
  ) => {
    messages.set([]);
    pending.set(false);
  },
);

type ChatInput = {
  messages?: Cell<Default<Array<BuiltInLLMMessage>, []>>;
  tools?: any;
  theme?: any;
  system?: string;
};

type PromptAttachment = {
  id: string;
  name: string;
  type: "file" | "clipboard" | "mention";
  data?: any; // File | Blob | string
  charm?: any;
  removable?: boolean; // Whether this attachment can be removed
};

type ChatOutput = {
  messages: Array<BuiltInLLMMessage>;
  pending: boolean | undefined;
  addMessage: Stream<BuiltInLLMMessage>;
  clearChat: Stream<void>;
  cancelGeneration: Stream<void>;
  title?: string;
  attachments: Array<PromptAttachment>;
  tools: any;
  ui: {
    chatLog: VNode;
    promptInput: VNode;
    attachmentsAndTools: VNode;
  };
};

export const TitleGenerator = recipe<
  { model?: string; messages: Array<BuiltInLLMMessage> }
>("Title Generator", ({ model, messages }) => {
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

const listMentionable = handler<
  {
    /** A cell to store the result text */
    result: Cell<any>;
  },
  { mentionable: Cell<MentionableCharm>[] }
>(
  (args, state) => {
    const namesList = state.mentionable.map((charm) => ({
      label: charm.get()[NAME],
      cell: charm,
    }));
    args.result.set(namesList);
  },
);

const listRecent = handler<
  {
    /** A cell to store the result text */
    result: Cell<any[]>;
  },
  { recentCharms: Cell<MentionableCharm>[] }
>(
  (args, state) => {
    const namesList = state.recentCharms.map((charm) => ({
      label: charm.get()[NAME],
      cell: charm,
    }));
    args.result.set(namesList);
  },
);

export default recipe<ChatInput, ChatOutput>(
  "Chat",
  ({ messages, tools, theme, system }) => {
    const model = Cell.of<string>("anthropic:claude-sonnet-4-5");
    const mentionable = schemaifyWish<MentionableCharm[]>("#mentionable");
    const recentCharms = schemaifyWish<MentionableCharm[]>("#recent");

    const assistantTools = {
      listMentionable: {
        description:
          "List all mentionable items in the space, read() the result.",
        handler: listMentionable({ mentionable }),
      },
      listRecent: {
        description:
          "List all recently viewed charms in the space, read() the result.",
        handler: listRecent({ recentCharms }),
      },
    };

    // Merge static and assistant tools
    const mergedTools = computed(() => ({
      ...tools,
      ...assistantTools,
    }));

    const {
      addMessage,
      cancelGeneration,
      pending,
      flattenedTools,
      attachments,
    } = llmDialog(
      {
        system: computed(() => {
          return system ?? "You are a polite but efficient assistant.";
        }),
        messages,
        tools: mergedTools,
        model,
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
          tools={flattenedTools}
        />
      </ct-vscroll>
    );

    const attachmentsAndTools = (
      <ct-hstack align="center" gap="1">
        <ct-attachments-bar attachments={attachments} />
        <ct-tools-chip tools={flattenedTools} />
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
      attachments,
      tools: flattenedTools,
      ui: {
        chatLog,
        promptInput,
        attachmentsAndTools,
      },
    };
  },
);
