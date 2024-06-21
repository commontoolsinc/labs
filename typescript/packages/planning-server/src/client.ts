// client.ts

import { Anthropic } from "./deps.ts";

const SERVER_URL = "http://localhost:8000";

// Request Types
interface CreateThreadRequest {
  action: "create";
  system: string;
  message: string;
  activeTools: Anthropic.Messages.Tool[];
}

interface AppendThreadRequest {
  action: "append";
  threadId: string;
  system?: string;
  toolResponses: ToolResponse[];
}

// Response Types
interface CreateThreadResponse {
  threadId: string;
  pendingToolCalls?: Anthropic.Messages.ToolUseBlockParam[];
  assistantResponse: Anthropic.Messages.MessageParam;
  conversation: Anthropic.Messages.MessageParam[];
}

interface AppendThreadResponse {
  threadId: string;
  output?: string;
  assistantResponse: Anthropic.Messages.MessageParam;
  pendingToolCalls?: Anthropic.Messages.ToolUseBlockParam[];
  conversation: Anthropic.Messages.MessageParam[];
}

// Tool Response Type
interface ToolResponse {
  type: "tool_result";
  tool_use_id: string;
  content: { type: "text"; text: string }[];
}

// Simulated local tool
const localTool: Anthropic.Messages.Tool = {
  name: "capitalize",
  description: "Capitalize all words in the given text",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string" },
    },
    required: ["text"],
  },
};

// Simulated tool execution
function executeTool(toolCall: Anthropic.Messages.ToolUseBlockParam): string {
  console.log("Executing tool:", toolCall);
  const { input } = toolCall;
  return (input as { text: string }).text.toUpperCase() + "!";
}

async function createThread(
  initialMessage: string
): Promise<CreateThreadResponse> {
  const request: CreateThreadRequest = {
    action: "create",
    system:
      "You are a helpful assistant that uses the provided tools to create effect.",
    message: initialMessage,
    activeTools: [localTool],
  };

  const response = await fetch(SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return await response.json();
}

async function continueThread(
  threadId: string,
  toolResponses: ToolResponse[]
): Promise<AppendThreadResponse> {
  const request: AppendThreadRequest = {
    action: "append",
    threadId,
    system: "You are a helpful assistant that gives single word responses.",
    toolResponses,
  };

  const response = await fetch(SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  return await response.json();
}

async function handleConversation(initialMessage: string) {
  console.log("User: " + initialMessage);
  let thread = await createThread(initialMessage);
  console.log("Assistant: " + thread.assistantResponse.content[0].text);

  while (thread.pendingToolCalls && thread.pendingToolCalls.length > 0) {
    const toolResponses: ToolResponse[] = thread.pendingToolCalls.map(
      (toolCall) => ({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: [{ type: "text", text: executeTool(toolCall) }],
      })
    );

    thread = await continueThread(thread.threadId, toolResponses);

    if ((thread as AppendThreadResponse).output) {
      console.log("Assistant: " + (thread as AppendThreadResponse).output);
      break; // End the conversation as there are no more pending tool calls
    }
  }
}

// Start the conversation
const initialMessage = "make me uppercase";
handleConversation(initialMessage);
