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
  ifElse,
  JSONSchema,
  lift,
  llm,
  llmDialog,
  NAME,
  OpaqueRef,
  recipe,
  str,
  Stream,
  UI,
} from "commontools";

type LLMTestInput = {
  title: Default<string, "LLM Test">;
  chat: Default<Array<BuiltInLLMMessage>, []>;
  theme: {
    accentColor: Default<string, "#3b82f6">;
    fontFace: Default<string, "Arial, sans-serif">;
    borderRadius: Default<string, "4px">;
  };
};

type LLMTestResult = {
  chat: Default<Array<BuiltInLLMMessage>, []>;
};

const setTheme = handler<
  {
    accentColor?: string;
    fontFace?: string;
    borderRadius?: string;
    result: Cell<string>;
  },
  {
    theme: {
      accentColor: Cell<string>;
      fontFace: Cell<string>;
      borderRadius: Cell<string>;
    };
  }
>((params, { theme }) => {
  try {
    const changes = [];

    if (params.accentColor) {
      theme.accentColor.set(params.accentColor);
      changes.push(`accent color to ${params.accentColor}`);
    }
    if (params.fontFace) {
      theme.fontFace.set(params.fontFace);
      changes.push(`font to ${params.fontFace}`);
    }
    if (params.borderRadius) {
      theme.borderRadius.set(params.borderRadius);
      changes.push(`border radius to ${params.borderRadius}`);
    }

    if (changes.length > 0) {
      params.result.set(`✅ Successfully updated ${changes.join(", ")}`);
    } else {
      params.result.set("⚠️ No theme changes requested");
    }
  } catch (error) {
    params.result.set(
      `❌ Error updating theme: ${(error as any)?.message || "Unknown error"}`,
    );
  }
});

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
  ({ title, chat, theme }) => {
    const calculatorResult = cell<string>("");
    const model = cell<string>("anthropic:claude-sonnet-4-0");
    const searchWebResult = cell<string>("");
    const readWebpageResult = cell<string>("");

    const tools = {
      setTheme: {
        description:
          "Change the visual theme of the chat interface. You can modify the accent color, font family, and border radius.",
        inputSchema: {
          type: "object",
          properties: {
            accentColor: {
              type: "string",
              description:
                "Hex color code for the accent color (e.g., '#3b82f6' for blue, '#10b981' for green, '#ef4444' for red)",
            },
            fontFace: {
              type: "string",
              description:
                "Font family string (e.g., 'system-ui, -apple-system, sans-serif', 'ui-monospace, Consolas, monospace')",
            },
            borderRadius: {
              type: "string",
              description:
                "Border radius value (e.g., '0px' for sharp, '0.5rem' for medium, '1rem' for rounded)",
            },
          },
        } as JSONSchema,
        handler: setTheme({ theme }),
      },
    };

    const { addMessage, cancelGeneration, pending } = llmDialog({
      system: "You are a helpful assistant with some tools.",
      messages: chat,
      tools: tools,
      model,
    });

    // Debug logging
    // derive(chat, (c) => {
    //   console.log("[CHAT] Messages:", c.length);
    //   if (c.length > 0) {
    //     const last = c[c.length - 1];
    //     console.log(
    //       "[CHAT] Last message:",
    //       last.role,
    //       typeof last.content === "string"
    //         ? last.content.substring(0, 50) + "..."
    //         : last.content,
    //     );
    //   }
    // });

    const { result } = fetchData({
      url: "/api/ai/llm/models",
      mode: "json",
    });

    const items = derive(result, (models) => {
      if (!models) return [];

      console.log("[LLM] Models:", models);
      const items = Object.keys(models as any).map((key) => ({
        label: key,
        value: key,
      }));

      console.log("[LLM] Items:", items);
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
                <ct-chat
                  theme={theme}
                  $messages={chat}
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
              </div>
            </ct-screen>

            <ct-vscroll flex showScrollbar fadeEdges snapToBottom>
              <ct-vstack data-label="Tools">
                <ct-vstack>
                  <ct-text>Font Family</ct-text>
                  <ct-select
                    items={[
                      {
                        label: "System",
                        value: "system-ui, -apple-system, sans-serif",
                      },
                      {
                        label: "Monospace",
                        value: "ui-monospace, Consolas, monospace",
                      },
                      { label: "Serif", value: "Georgia, Times, serif" },
                      {
                        label: "Sans Serif",
                        value: "Arial, Helvetica, sans-serif",
                      },
                    ]}
                    $value={theme.fontFace}
                  />
                </ct-vstack>

                <ct-vstack>
                  <ct-text>Accent Color</ct-text>
                  <ct-select
                    items={[
                      { label: "Blue", value: "#3b82f6" },
                      { label: "Purple", value: "#8b5cf6" },
                      { label: "Green", value: "#10b981" },
                      { label: "Red", value: "#ef4444" },
                      { label: "Orange", value: "#f97316" },
                      { label: "Pink", value: "#ec4899" },
                      { label: "Indigo", value: "#6366f1" },
                      { label: "Teal", value: "#14b8a6" },
                    ]}
                    $value={theme.accentColor}
                  />
                </ct-vstack>

                <ct-vstack>
                  <ct-text>Border Radius</ct-text>
                  <ct-select
                    items={[
                      { label: "None", value: "0px" },
                      { label: "Small", value: "0.25rem" },
                      { label: "Medium", value: "0.5rem" },
                      { label: "Large", value: "0.75rem" },
                      { label: "Extra Large", value: "1rem" },
                      { label: "Rounded", value: "1.5rem" },
                    ]}
                    $value={theme.borderRadius}
                  />
                </ct-vstack>
              </ct-vstack>
            </ct-vscroll>
          </ct-autolayout>
        </ct-screen>
      ),
      chat,
    };
  },
);
