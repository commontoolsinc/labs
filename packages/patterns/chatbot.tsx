/// <cts-enable />
import {
  BuiltInLLMMessage,
  Cell,
  cell,
  Default,
  derive,
  fetchData,
  generateObject,
  handler,
  llmDialog,
  NAME,
  navigateTo,
  Opaque,
  recipe,
  Stream,
  UI,
  VNode,
  wish,
} from "commontools";
import { type MentionableCharm } from "./backlinks-index.tsx";

function schemaifyWish<T>(path: string, def: Opaque<T>) {
  return derive<T, T>(wish<T>(path, def), (i) => i);
}

const addAttachment = handler<
  {
    detail: {
      attachment: PromptAttachment;
    };
  },
  {
    allAttachments: Cell<Array<PromptAttachment>>;
  }
>((event, { allAttachments }) => {
  const { attachment } = event.detail;
  const current = allAttachments.get() || [];
  allAttachments.set([...current, attachment]);
});

const removeAttachment = handler<
  {
    detail: {
      id: string;
    };
  },
  {
    allAttachments: Cell<Array<PromptAttachment>>;
  }
>((event, { allAttachments }) => {
  const { id } = event.detail;
  const current = allAttachments.get() || [];
  allAttachments.set(current.filter((a) => a.id !== id));
});

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
  const { text } = event.detail;

  // Build content array from text and attachments
  const contentParts = [{ type: "text" as const, text }];

  // Get current attachments from the global list
  const attachments = allAttachments.get() || [];

  // Compute mentions from mention attachments so they are available to consumers
  const _mentions = attachments
    .filter((a) => a.type === "mention" && a.charm)
    .map((a) => a.charm);

  // Process attachments
  for (const attachment of attachments) {
    if (attachment.type === "file" && attachment.data) {
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

const navigateToAttachment = handler<
  { id: string },
  { allAttachments: Array<PromptAttachment> }
>(({ id }, { allAttachments }) => {
  const attachment = allAttachments.find((a) => a.id === id);

  return navigateTo(attachment?.charm);
});

const listAttachments = handler<
  { result: Cell<string> },
  { allAttachments: Array<PromptAttachment> }
>(({ result }, { allAttachments }) => {
  result.set(JSON.stringify(allAttachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    type: attachment.type,
  }))));
});

const addAttachmentTool = handler<
  {
    mentionableName: string;
  },
  {
    mentionable: Array<MentionableCharm>;
    allAttachments: Cell<Array<PromptAttachment>>;
  }
>(({ mentionableName }, { mentionable, allAttachments }) => {
  const charm = mentionable.find((c) => c[NAME] === mentionableName);

  // borrowed from `ct-prompt-input` to match
  const id = `attachment-${Date.now()}-${
    Math.random().toString(36).substring(2, 9)
  }`;

  if (!charm) {
    throw new Error(
      `Unknown mentionable "${mentionableName}", cannot add attachment.`,
    );
  }

  allAttachments.push({
    id,
    name: mentionableName,
    type: "mention",
    charm,
  });
});

const removeAttachmentTool = handler<
  {
    mentionableName: string;
  },
  {
    allAttachments: Cell<Array<PromptAttachment>>;
  }
>(({ mentionableName }, { allAttachments }) => {
  allAttachments.set(
    allAttachments.get().filter((attachment) =>
      attachment.name !== mentionableName
    ),
  );
});

const listMentionable = handler<
  {
    /** A cell to store the result text */
    result: Cell<string>;
  },
  { mentionable: MentionableCharm[] }
>(
  (args, state) => {
    try {
      const namesList = state.mentionable.map((charm) => charm[NAME]);
      args.result.set(JSON.stringify(namesList));
    } catch (error) {
      args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
    }
  },
);

export default recipe<ChatInput, ChatOutput>(
  "Chat",
  ({ messages, tools, theme }) => {
    const model = cell<string>("anthropic:claude-sonnet-4-5");
    const allAttachments = cell<Array<PromptAttachment>>([]);
    const mentionable = schemaifyWish<MentionableCharm[]>(
      "#mentionable",
      [],
    );

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

    const attachmentTools = {
      navigateToAttachment: {
        description:
          "Navigate to a mentionable by its ID in the attachments array.",
        handler: navigateToAttachment({ allAttachments }),
      },
      listAttachments: {
        description: "List all attachments in the attachments array.",
        handler: listAttachments({ allAttachments }),
      },
      listMentionable: {
        description: "List all mentionable NAMEs in the space.",
        handler: listMentionable({ mentionable }),
      },
      addAttachment: {
        description:
          "Add a new attachment to the attachments array by its mentionable NAME.",
        handler: addAttachmentTool({ mentionable, allAttachments }),
      },
      removeAttachment: {
        description:
          "Remove an attachment from the attachments array by its mentionable NAME.",
        handler: removeAttachmentTool({ allAttachments }),
      },
    };

    // Merge static and dynamic tools
    const mergedTools = derive(
      [tools, dynamicTools, attachmentTools],
      ([staticTools, dynamic, attachments]: [any, any, any]) => ({
        ...staticTools,
        ...dynamic,
        ...attachments,
      }),
    );

    const { addMessage, cancelGeneration, pending, flattenedTools } = llmDialog(
      {
        system: "You are a helpful assistant with some tools.",
        messages,
        tools: mergedTools,
        model,
      },
    );

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

    const promptInput = (
      <div slot="footer">
        <ct-prompt-input
          placeholder="Ask the LLM a question..."
          pending={pending}
          $mentionable={mentionable}
          onct-send={sendMessage({ addMessage, allAttachments })}
          onct-stop={cancelGeneration}
          onct-attachment-add={addAttachment({ allAttachments })}
          onct-attachment-remove={removeAttachment({ allAttachments })}
        />
        <ct-select
          items={items}
          $value={model}
        />
      </div>
    );

    const chatLog = (
      <ct-vscroll flex showScrollbar fadeEdges snapToBottom>
        <ct-chat
          theme={theme}
          $messages={messages}
          pending={pending}
          tools={flattenedTools}
        />
      </ct-vscroll>
    );

    const attachmentsAndTools = (
      <ct-hstack gap="normal">
        <ct-attachments-bar
          attachments={allAttachments}
          removable
          onct-remove={removeAttachment({ allAttachments })}
        />
        <ct-tools-chip tools={flattenedTools} />
        <button
          type="button"
          title="Clear chat"
          onClick={clearChat({
            messages,
            pending,
          })}
        >
          Clear
        </button>
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
      attachments: allAttachments,
      tools: flattenedTools,
      ui: {
        chatLog,
        promptInput,
        attachmentsAndTools,
      },
    };
  },
);
