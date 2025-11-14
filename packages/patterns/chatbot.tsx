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
    removable: true, // User-added attachments can be removed
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
  { mentionable: Cell<MentionableCharm>[] }
>(
  (args, state) => {
    const namesList = state.mentionable.map((charm) => ({
      label: charm.get()[NAME],
      cell: charm,
    }));
    args.result.set(JSON.stringify(namesList));
  },
);

const listRecent = handler<
  {
    /** A cell to store the result text */
    result: Cell<string>;
  },
  { recentCharms: Cell<MentionableCharm>[] }
>(
  (args, state) => {
    const namesList = state.recentCharms.map((charm) => ({
      label: charm.get()[NAME],
      cell: charm,
    }));
    args.result.set(JSON.stringify(namesList));
  },
);

export default recipe<ChatInput, ChatOutput>(
  "Chat",
  ({ messages, tools, theme, system }) => {
    const model = Cell.of<string>("anthropic:claude-sonnet-4-5");
    const allAttachments = Cell.of<Array<PromptAttachment>>([]);
    const mentionable = schemaifyWish<MentionableCharm[]>("#mentionable");
    const recentCharms = schemaifyWish<MentionableCharm[]>("#recent");

    // Auto-attach the most recent charm (union with user attachments)
    const attachmentsWithRecent = computed((): Array<PromptAttachment> => {
      const userAttachments = allAttachments.get();
      const attachments = [...(userAttachments || [])];

      // If there's a most recent charm, auto-inject it
      if (recentCharms && recentCharms.length > 0) {
        const mostRecent = recentCharms[0];
        const mostRecentName = mostRecent[NAME];

        // Check if it's already in the attachments
        const alreadyAttached = attachments.some(
          (a) => a.type === "mention" && a.name === mostRecentName,
        );

        if (!alreadyAttached && mostRecentName) {
          // Add the most recent charm to the beginning
          const id = `attachment-auto-recent-${mostRecentName}`;
          return [
            {
              id,
              name: mostRecentName,
              type: "mention" as const,
              charm: mostRecent,
              removable: false, // Auto-attached charm cannot be removed
            },
            ...attachments,
          ];
        }
      }

      return attachments;
    });

    // Surface attached charms so the LLM can use read/run/schema helpers.
    const dynamicTools = computed(() => {
      const attached: Record<string, any> = {};

      for (const attachment of attachmentsWithRecent || []) {
        if (attachment.type !== "mention" || !attachment.charm) continue;
        const charmName = attachment.charm[NAME] || "Charm";
        attached[charmName] = {
          charm: attachment.charm,
          description:
            `Attached charm ${charmName}. Use schema("${charmName}") to ` +
            `inspect it, then read("${charmName}/path") or ` +
            `run("${charmName}/handler").`,
        };
      }

      return attached;
    });

    const attachmentTools = {
      listMentionable: {
        description: "List all mentionable items in the space, read() the result.",
        handler: listMentionable({ mentionable }),
      },
      listRecent: {
        description: "List all recently viewed charms in the space, read() the result.",
        handler: listRecent({ recentCharms }),
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
    const mergedTools = computed(() => ({
      ...tools,
      ...dynamicTools,
      ...attachmentTools,
    }));

    const { addMessage, cancelGeneration, pending, flattenedTools } = llmDialog(
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
        onct-send={sendMessage({
          addMessage,
          allAttachments: attachmentsWithRecent,
        })}
        onct-stop={cancelGeneration}
        onct-attachment-add={addAttachment({ allAttachments })}
        onct-attachment-remove={removeAttachment({ allAttachments })}
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
        <ct-attachments-bar
          attachments={attachmentsWithRecent}
          removable
          onct-remove={removeAttachment({ allAttachments })}
        />
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
      attachments: attachmentsWithRecent,
      tools: flattenedTools,
      ui: {
        chatLog,
        promptInput,
        attachmentsAndTools,
      },
    };
  },
);
