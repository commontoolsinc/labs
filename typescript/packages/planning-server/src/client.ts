// llm_client.ts

import { Anthropic } from "./deps.ts";

type Tool = Anthropic.Messages.Tool & {
  implementation: (input: any) => Promise<string> | string;
};

export interface ClientConfig {
  serverUrl: string;
  tools: Tool[];
  system?: string;
}

export class LLMClient {
  private serverUrl: string;
  private tools: Tool[];
  private system: string;

  constructor(config: ClientConfig) {
    this.serverUrl = config.serverUrl;
    this.tools = config.tools;
    this.system =
      config.system ||
      "You are a helpful assistant that uses the provided tools to create effect.";
  }

  private async sendRequest(body: any): Promise<any> {
    const response = await fetch(this.serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
  }

  async createThread(message: string): Promise<CreateThreadResponse> {
    const request: CreateThreadRequest = {
      action: "create",
      system: this.system,
      message,
      activeTools: this.tools.map(({ implementation, ...tool }) => ({
        ...tool,
      })),
    };

    return await this.sendRequest(request);
  }

  async continueThread(
    threadId: string,
    toolResponses: ToolResponse[]
  ): Promise<AppendThreadResponse> {
    const request: AppendThreadRequest = {
      action: "append",
      threadId,
      toolResponses,
    };

    return await this.sendRequest(request);
  }

  async executeTool(
    toolCall: Anthropic.Messages.ToolUseBlockParam
  ): Promise<string> {
    const tool = this.tools.find((t) => t.name === toolCall.name);
    console.log("Tool call:", toolCall.name, toolCall.input);

    if (!tool) {
      throw new Error(`Tool not found: ${toolCall.name}`);
    }
    const result = await tool.implementation(toolCall.input);
    console.log("Tool result:", result);
    return result;
  }

  async handleConversation(initialMessage: string): Promise<string[]> {
    const conversation: string[] = [];
    conversation.push(`User: ${initialMessage}`);

    let thread: CreateThreadResponse | AppendThreadResponse =
      await this.createThread(initialMessage);
    conversation.push(
      `Assistant: ${(thread.assistantResponse.content[0] as { text: string }).text}`
    );

    while (thread.pendingToolCalls && thread.pendingToolCalls.length > 0) {
      const toolResponses: ToolResponse[] = await Promise.all(
        thread.pendingToolCalls.map(async (toolCall) => ({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: [{ type: "text", text: await this.executeTool(toolCall) }],
        }))
      );

      // console.info("Tool responses", toolResponses);
      thread = await this.continueThread(thread.threadId, toolResponses);

      if (thread.output) {
        conversation.push(`Assistant: ${thread.output}`);
        break;
      }
    }

    return conversation;
  }
}

// Types (you can move these to a separate file if desired)
interface CreateThreadRequest {
  action: "create";
  system: string;
  message: string;
  activeTools: Anthropic.Messages.Tool[];
}

interface AppendThreadRequest {
  action: "append";
  threadId: string;
  toolResponses: ToolResponse[];
}

interface CreateThreadResponse {
  threadId: string;
  pendingToolCalls: Anthropic.Messages.ToolUseBlockParam[];
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

interface ToolResponse {
  type: "tool_result";
  tool_use_id: string;
  content: { type: "text"; text: string }[];
}

const client = new LLMClient({
  serverUrl: "http://localhost:8000",
  tools: [
    {
      name: "calculator",
      input_schema: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "A mathematical expression to evaluate",
          },
        },
        required: ["expression"],
      },
      implementation: async ({ expression }) => {
        return `${await eval(expression)}`;
      },
    },
  ],
});

// get input from args
const input = Deno.args.join(" ");
console.log(`Input: ${input}`);

client.handleConversation(input).then((conversation) => {
  console.log(conversation);
});
