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
  }
};

type LLMTestResult = {
  chat: Default<Array<BuiltInLLMMessage>, []>;
};

// put a node at the end of the outline (by appending to root.children)
// const appendOutlinerNode = handler<
//   { body: string; result: Cell<string> },
//   { outline: Cell<Outliner> }
// >(
//   (args, state) => {
//     try {
//       state.outline.key("root").key("children").set([
//         ...state.outline.key("root").key("children").get(),
//         {
//           body: args.body,
//           children: [],
//           attachments: [],
//         },
//       ]);
//       args.result.set(
//         `${state.outline.key("root").key("children").get().length} nodes`,
//       );
//     } catch (error) {
//       args.result.set(`Error: ${(error as any)?.message || "<error>"}`);
//     }
//   },
// );

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
      // appendOutlinerNode: {
      //   description: "Add a new outliner node.",
      //   inputSchema: {
      //     type: "object",
      //     properties: {
      //       body: {
      //         type: "string",
      //         description: "The title of the new node.",
      //       },
      //     },
      //     required: ["body"],
      //   } as JSONSchema,
      //   handler: appendOutlinerNode({ outline }),
      // },
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
                <ct-chat theme={theme} $messages={chat} pending={pending} tools={tools} />
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
                      { label: 'System', value: 'system-ui, -apple-system, sans-serif' }, 
                      { label: 'Monospace', value: 'ui-monospace, Consolas, monospace' }, 
                      { label: 'Serif', value: 'Georgia, Times, serif' }, 
                      { label: 'Sans Serif', value: 'Arial, Helvetica, sans-serif' }
                    ]}
                    $value={theme.fontFace}
                  />
                </ct-vstack>
                
                <ct-vstack>
                  <ct-text>Accent Color</ct-text>
                  <ct-select
                    items={[
                      { label: 'Blue', value: '#3b82f6' },
                      { label: 'Purple', value: '#8b5cf6' },
                      { label: 'Green', value: '#10b981' },
                      { label: 'Red', value: '#ef4444' },
                      { label: 'Orange', value: '#f97316' },
                      { label: 'Pink', value: '#ec4899' },
                      { label: 'Indigo', value: '#6366f1' },
                      { label: 'Teal', value: '#14b8a6' }
                    ]}
                    $value={theme.accentColor}
                  />
                </ct-vstack>
                
                <ct-vstack>
                  <ct-text>Border Radius</ct-text>
                  <ct-select
                    items={[
                      { label: 'None', value: '0px' },
                      { label: 'Small', value: '0.25rem' },
                      { label: 'Medium', value: '0.5rem' },
                      { label: 'Large', value: '0.75rem' },
                      { label: 'Extra Large', value: '1rem' },
                      { label: 'Rounded', value: '1.5rem' }
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
