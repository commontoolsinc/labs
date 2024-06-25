import { Anthropic } from "@anthropic-ai/sdk";
export * from './dummy-data.js'

export type LlmTool = Anthropic.Messages.Tool & {
  implementation: (input: any) => Promise<string> | string;
};

export interface ClientConfig {
  serverUrl: string;
  tools: LlmTool[];
  system?: string;
}

export class ConversationThread {
  private pendingToolCalls: Anthropic.Messages.ToolUseBlockParam[] = [];

  constructor(
    private client: LLMClient,
    public id: string,
    public conversation: string[] = [],
  ) {
    this.client = client;
    this.id = id;
    this.conversation = conversation;
  }

  async processQueuedToolCalls() {
    if (!this.pendingToolCalls || this.pendingToolCalls.length === 0) {
      return;
    }
    const toolResponses = await this.handleToolCalls(this.pendingToolCalls);
    const response = await this.client.continueThread(
      this.id,
      undefined,
      toolResponses,
    );
    return response;
  }

  async sendMessage(message: string): Promise<string> {
    const response: AppendThreadResponse = await this.client.continueThread(
      this.id,
      message,
    );

    this.conversation.push(`User: ${message}`);
    let assistantResponse = "";

    if (response.pendingToolCalls && response.pendingToolCalls.length > 0) {
      this.pendingToolCalls = response.pendingToolCalls;
      assistantResponse = (
        response.assistantResponse?.content[0] as { text: string }
      ).text;
    } else {
      assistantResponse = response.output || "";
      this.pendingToolCalls = [];
    }

    await this.processQueuedToolCalls();

    this.conversation.push(`Assistant: ${assistantResponse}`);
    return assistantResponse;
  }

  private async handleToolCalls(
    toolCalls: Anthropic.Messages.ToolUseBlockParam[],
  ): Promise<ToolResponse[]> {
    console.log("Handling tool calls", toolCalls);

    return await Promise.all(
      toolCalls.map(async (toolCall) => ({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: [
          { type: "text", text: await this.client.executeTool(toolCall) },
        ],
      })),
    );
  }

  hasPendingToolCalls(): boolean {
    return this.pendingToolCalls !== null;
  }
}

export class LLMClient {
  private serverUrl: string;
  private tools: LlmTool[];
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
      const errorText = await response.text();
      throw new Error(
        `HTTP error! status: ${response.status}, body: ${errorText}`,
      );
    }

    return await response.json();
  }

  async createThread(message: string): Promise<ConversationThread> {
    const request: CreateThreadRequest = {
      action: "create",
      system: this.system,
      message,
      activeTools: this.tools.map(({ implementation, ...tool }) => tool),
    };

    const response: CreateThreadResponse = await this.sendRequest(request);
    const thread = new ConversationThread(this, response.threadId);

    const initialAssistantResponse = (
      response.assistantResponse.content[0] as { text: string }
    ).text;
    thread.conversation.push(`User: ${message}`);
    thread.conversation.push(`Assistant: ${initialAssistantResponse}`);

    if (response.pendingToolCalls && response.pendingToolCalls.length > 0) {
      // Instead of handling tool calls here, we set them as pending in the Thread
      (thread as any).pendingToolCalls = response.pendingToolCalls;
    }

    let toolResponse: AppendThreadResponse | undefined;
    let running = true;

    while (running) {
      toolResponse = await thread.processQueuedToolCalls();

      if (toolResponse) {
        thread.conversation.push(
          `Assistant: ${toolResponse.assistantResponse}`,
        );

        (thread as any).pendingToolCalls = toolResponse.pendingToolCalls;
      } else {
        running = false;
        break;
      }
    }

    return thread;
  }

  async continueThread(
    threadId: string,
    message?: string,
    toolResponses: ToolResponse[] = [],
  ): Promise<AppendThreadResponse> {
    const request: AppendThreadRequest = {
      action: "append",
      threadId,
      message,
      toolResponses,
    };

    return await this.sendRequest(request);
  }

  async executeTool(
    toolCall: Anthropic.Messages.ToolUseBlockParam,
  ): Promise<string> {
    const tool = this.tools.find((t) => t.name === toolCall.name);
    if (!tool) {
      throw new Error(`Tool not found: ${toolCall.name}`);
    }
    return await tool.implementation(toolCall.input);
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
  message?: string;
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
