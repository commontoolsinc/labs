import {
  BuiltInLLMMessage,
  BuiltInLLMTool,
  computed,
  Default,
  fetchJsonUnchecked,
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
} from "commonfabric";
import { type MentionablePiece } from "./system/backlinks-index.tsx";

const sendMessage = handler<
  {
    detail: {
      text: string;
      attachments: Array<PromptAttachment>;
      mentions: Array<unknown>;
      message: string; // Backward compatibility
    };
  },
  {
    addMessage: Stream<BuiltInLLMMessage>;
  }
>((event, { addMessage }) => {
  const { text, attachments } = event.detail;

  // Resolve pasted content attachments inline so the LLM sees actual content
  // instead of just a reference like [Pasted content (4799 chars)](#attachment-xxx)
  let resolved = text;
  for (const att of attachments ?? []) {
    if (att.type === "clipboard" && typeof att.data === "string") {
      resolved = resolved.replace(`[${att.name}](#${att.id})`, att.data);
    }
  }

  // Any remaining markdown links like [name](/of:...) are just text that
  // the LLM can parse and use with tools.
  addMessage.send({
    role: "user",
    content: [{ type: "text" as const, text: resolved }],
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
  messages?: Writable<Array<BuiltInLLMMessage> | Default<[]>>;
  tools?: object;
  theme?: object;
  system?: string;
};

type PromptAttachment = {
  id: string;
  name: string;
  type: "file" | "clipboard" | "mention";
  data?: unknown; // File | Blob | string
  piece?: unknown;
  removable?: boolean; // Whether this attachment can be removed
};

const handlePinToChat = handler<
  { path: string; name: string; accumulate: boolean },
  {
    pinCell: Stream<{ path: string; name: string }>;
    unpinAllCells: Stream<void>;
  }
>((event, { pinCell, unpinAllCells }) => {
  if (!event.accumulate) {
    unpinAllCells.send(undefined);
  }
  pinCell.send({ path: event.path, name: event.name });
});

export type ChatOutput = {
  messages: Array<BuiltInLLMMessage>;
  pending: boolean | undefined;
  addMessage: Stream<BuiltInLLMMessage>;
  clearChat: Stream<void>;
  cancelGeneration: Stream<void>;
  title?: string;
  pinnedCells: Array<{ path: string; name: string }>;
  pinCell: Stream<{ path: string; name: string }>;
  unpinAllCells: Stream<void>;
  pinToChat: Stream<{ path: string; name: string; accumulate: boolean }>;
  tools: Record<string, unknown>;
  ui: {
    chatLog: VNode;
    promptInput: VNode;
    attachmentsAndTools: VNode;
  };
};

export const TitleGenerator = pattern<
  { model?: string; messages: Array<BuiltInLLMMessage> },
  string
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const asLlmTools = (
  tools: object | undefined,
): Record<string, BuiltInLLMTool> | undefined =>
  tools as Record<string, BuiltInLLMTool> | undefined;

export default pattern<ChatInput, ChatOutput>(
  ({ messages, tools, theme, system }) => {
    const model = new Writable<string>("anthropic:claude-sonnet-4-5");
    const mentionable =
      wish<MentionablePiece[]>({ query: "#mentionable" }).result;
    const recentPieces =
      wish<{ [NAME]: string }[]>({ query: "#recent" }).result;

    const latest = computed(() => recentPieces![0]);
    const latestName = computed(() => recentPieces![0]?.[NAME] ?? "latest");

    const {
      addMessage,
      cancelGeneration,
      pending,
      flattenedTools,
      pinnedCells,
      pinCell,
      unpinAllCells,
    } = llmDialog(
      {
        system: computed(() => {
          return system ?? "You are a polite but efficient assistant.";
        }),
        messages,
        tools: asLlmTools(tools),
        model,
        context: computed(() => ({
          [latestName]: latest,
        })) as never,
      },
    );

    const { result } = fetchJsonUnchecked({
      url: "/api/ai/llm/models",
    });

    const items = computed(() => {
      const modelDirectory: unknown = result;
      if (!isRecord(modelDirectory)) return [];
      const items = Object.keys(modelDirectory).map((key) => ({
        label: key,
        value: key,
      }));
      return items;
    });

    const title = TitleGenerator({ model, messages });

    const promptInput = (
      <cf-prompt-input
        slot="footer"
        placeholder="Ask the LLM a question..."
        pending={pending}
        $mentionable={mentionable}
        modelItems={items}
        $model={model}
        oncf-send={sendMessage({ addMessage })}
        oncf-stop={cancelGeneration}
      />
    );

    const chatLog = (
      <cf-vscroll
        style="padding: 1rem;"
        flex
        showScrollbar
        fadeEdges
        snapToBottom
      >
        <cf-chat
          theme={theme as never}
          $messages={messages}
          pending={pending}
        />
      </cf-vscroll>
    );

    const attachmentsAndTools = (
      <cf-hstack align="center" gap="1">
        <cf-cell-context $cell={pinnedCells}>
          <cf-attachments-bar pinnedCells={pinnedCells} />
        </cf-cell-context>
        <cf-tools-chip $tools={flattenedTools} />
        <cf-button
          variant="pill"
          type="button"
          title="Clear chat"
          onClick={clearChat({
            messages,
            pending,
          })}
        >
          Clear
        </cf-button>
      </cf-hstack>
    );

    return {
      [NAME]: title,
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header">
            <cf-heading level={4}>{title}</cf-heading>
            {attachmentsAndTools}
          </cf-vstack>

          {chatLog}

          {promptInput}
        </cf-screen>
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
      pinCell,
      unpinAllCells,
      pinToChat: handlePinToChat({ pinCell, unpinAllCells }),
      tools: flattenedTools,
      ui: {
        chatLog,
        promptInput,
        attachmentsAndTools,
      },
    };
  },
);
