import {
  h,
  derive,
  handler,
  JSONSchema,
  llm,
  NAME,
  recipe,
  Schema,
  str,
  UI,
} from "commontools";

const MessageSchema = {
  type: "object",
  properties: {
    role: { 
      type: "string",
      enum: ["user", "assistant"]
    },
    content: { type: "string" },
  },
  required: ["role", "content"],
} as const satisfies JSONSchema;

export type Message = Schema<typeof MessageSchema>;

const SimpleChatbotSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      default: "Simple Chatbot",
    },
    systemPrompt: {
      type: "string",
      default: "You are a helpful AI assistant. Be friendly and concise.",
    },
    userMessage: {
      type: "string",
      default: "",
    },
    chatHistory: {
      type: "array",
      items: MessageSchema,
      default: [],
    },
  },
  required: ["title", "systemPrompt", "userMessage", "chatHistory"],
} as const satisfies JSONSchema;

const ResultSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    systemPrompt: { type: "string" },
    userMessage: { type: "string" },
    chatHistory: { type: "array", items: MessageSchema },
    lastResponse: { type: "string" },
  },
  required: ["title", "systemPrompt", "userMessage", "chatHistory", "lastResponse"],
} as const satisfies JSONSchema;

const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
  ({ detail }, state) => {
    state.title = detail?.value ?? "Simple Chatbot";
  },
);

const updateSystemPrompt = handler<
  { detail: { value: string } },
  { systemPrompt: string }
>(({ detail }, state) => {
  state.systemPrompt = detail?.value ?? "";
});

const clearChat = handler<void, { chatHistory: Message[] }>((_, { chatHistory }) => {
  chatHistory.length = 0;
});

const sendMessage = handler<
  { detail: { message: string } },
  { chatHistory: Message[]; userMessage: string }
>((event, { chatHistory, userMessage }) => {
  const message = event.detail?.message?.trim();
  if (message) {
    chatHistory.push({
      role: "user",
      content: message,
    });
  }
});

export default recipe(
  SimpleChatbotSchema,
  ResultSchema,
  ({ title, systemPrompt, userMessage, chatHistory }) => {
    // Get the last user message for LLM processing
    const lastUserMessage = derive(chatHistory, (history) => {
      const userMessages = history.filter(msg => msg.role === "user");
      return userMessages[userMessages.length - 1]?.content || "";
    });

    // Get LLM response for the last user message
    const aiResponse = derive(lastUserMessage, (msg) => {
      if (!msg) return "";
      
      return llm({
        system: systemPrompt || "You are a helpful AI assistant.",
        messages: [str`${msg}`],
      });
    });

    // Convert LLM response to string
    const lastResponse = derive(aiResponse, (response) => {
      if (!response) return "";
      if (typeof response === "string") return response;
      if (response.result) return String(response.result);
      return "";
    });

    return {
      [NAME]: title,
      [UI]: (
        <os-container style={{ height: "100vh", padding: "1rem" }}>
          <common-vstack gap="lg" style={{ height: "100%" }}>
            {/* Header */}
            <ct-card style={{ flexShrink: 0 }}>
              <common-vstack gap="md">
                <common-input
                  value={title}
                  placeholder="Chatbot name"
                  oncommon-input={updateTitle({ title })}
                  customStyle="font-size: 18px; font-weight: bold;"
                />
                <div>
                  <label>System Prompt:</label>
                  <ct-textarea
                    value={systemPrompt}
                    placeholder="Define bot behavior..."
                    rows={2}
                    onct-change={updateSystemPrompt({ systemPrompt })}
                  />
                </div>
                <common-hstack gap="sm">
                  <sl-button
                    variant="neutral"
                    outline
                    onclick={clearChat({ chatHistory })}
                  >
                    Clear Chat
                  </sl-button>
                  <common-text style="color: #666; font-size: 12px;">
                    {derive(chatHistory, (msgs) => `${msgs.length} messages`)}
                  </common-text>
                </common-hstack>
              </common-vstack>
            </ct-card>

            {/* Chat Display */}
            <ct-card style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "1rem" }}>
              <common-vstack gap="md">
                {chatHistory.map((message, index) => (
                  <div
                    key={index}
                    style={{
                      display: "flex",
                      justifyContent: message.role === "user" ? "flex-end" : "flex-start",
                    }}
                  >
                    <div
                      style={{
                        maxWidth: "70%",
                        padding: "0.75rem 1rem",
                        borderRadius: "1rem",
                        backgroundColor: message.role === "user" ? "#007bff" : "#f1f3f4",
                        color: message.role === "user" ? "white" : "black",
                      }}
                    >
                      {message.content}
                    </div>
                  </div>
                ))}
                
                {/* Show AI response if there's one */}
                {derive(lastResponse, (response) => 
                  response ? (
                    <div style={{ display: "flex", justifyContent: "flex-start" }}>
                      <div
                        style={{
                          maxWidth: "70%",
                          padding: "0.75rem 1rem",
                          borderRadius: "1rem",
                          backgroundColor: "#e8f5e8",
                          color: "black",
                        }}
                      >
                        {response}
                      </div>
                    </div>
                  ) : null
                )}
              </common-vstack>
            </ct-card>

            {/* Message Input */}
            <ct-card style={{ flexShrink: 0 }}>
              <common-send-message
                name="Send"
                placeholder="Type your message..."
                appearance="rounded"
                onmessagesend={sendMessage({ chatHistory, userMessage })}
              />
            </ct-card>
          </common-vstack>
        </os-container>
      ),
      title,
      systemPrompt,
      userMessage,
      chatHistory,
      lastResponse,
    };
  }
);