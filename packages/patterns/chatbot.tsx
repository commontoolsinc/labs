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
import { MentionableCharm } from "./chatbot-list-view.tsx";

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
    allAttachments: Cell<Array<PromptAttachment>>;
  }
>((event, { addMessage, allAttachments }) => {
  const { text, attachments = [] } = event.detail;

  // Add new attachments to the growing list
  const current = allAttachments.get() || [];
  allAttachments.set([...current, ...attachments]);

  // Build content array from text and attachments
  const contentParts = [{ type: "text" as const, text }];

  // Process attachments
  for (const attachment of attachments) {
    if (attachment.type === "file" && attachment.data) {
      // TODO: Convert File to multimodal content block
      // For now, add a text reference
      contentParts.push({
        type: "text" as const,
        text: `[Attached file: ${attachment.name}]`,
      });
    } else if (attachment.type === "clipboard" && attachment.data) {
      // Append clipboard content as additional context
      contentParts.push({
        type: "text" as const,
        text: `\n\n--- Pasted content ---\n${attachment.data}`,
      });
    }
    // Note: mentions are already in the text as clean names
    // The charm references are available in attachment.charm if needed
  }

  addMessage.send({
    role: "user",
    content: contentParts,
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
  mentionable: Cell<MentionableCharm[]>;
};

type PromptAttachment = {
  id: string;
  name: string;
  type: "file" | "clipboard" | "mention";
  data?: any; // File | Blob | string
  charm?: any;
};

type ChatOutput = {
  messages: Array<BuiltInLLMMessage>;
  pending: boolean | undefined;
  addMessage: Stream<BuiltInLLMMessage>;
  cancelGeneration: Stream<void>;
  title?: string;
  attachments: Array<PromptAttachment>;
  tools: any;
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
  ({ messages, tools, theme, mentionable }) => {
    const model = cell<string>("anthropic:claude-sonnet-4-5");
    const allAttachments = cell<Array<PromptAttachment>>([]);

    // Derive tools from attachments
    const dynamicTools = derive(allAttachments, (attachments) => {
      const tools: Record<string, any> = {};

      for (const attachment of attachments || []) {
        if (attachment.type === "mention" && attachment.charm) {
          const charmName = attachment.charm[NAME] || "Charm";
          tools[charmName] = {
            charm: attachment.charm,
            description: `Handlers from ${charmName}`,
          };
        }
      }

      return tools;
    });

    // Merge static and dynamic tools
    const mergedTools = derive([tools, dynamicTools], ([staticTools, dynamic]: [any, any]) => ({
      ...staticTools,
      ...dynamic,
    }));

    const { addMessage, cancelGeneration, pending, flattenedTools } = llmDialog({
      system: "You are a helpful assistant with some tools.",
      messages,
      tools: mergedTools,
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
          <ct-vstack slot="header">
            <ct-heading level={4}>{title}</ct-heading>
            <ct-hstack gap="normal">
              <ct-attachments-bar attachments={allAttachments} />
              <ct-tools-chip tools={flattenedTools} />
            </ct-hstack>
          </ct-vstack>

          <ct-vscroll flex showScrollbar fadeEdges snapToBottom>
            <ct-chat
              theme={theme}
              $messages={messages}
              pending={pending}
              tools={flattenedTools}
            />
          </ct-vscroll>

          <div slot="footer">
            <ct-prompt-input
              placeholder="Ask the LLM a question..."
              pending={pending}
              $mentionable={mentionable}
              onct-send={sendMessage({ addMessage, allAttachments })}
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
      attachments: allAttachments,
      tools: flattenedTools,
    };
  },
);
