import { CoreMessage, CoreTool } from "ai";
export * from "./dummy-data.js";

export type LlmTool = CoreTool & {
  implementation: (input: any) => Promise<string> | string;
};

export interface ClientConfig {
  serverUrl: string;
  tools: LlmTool[];
  system?: string;
}

export class ConversationThread {
  constructor(
    private client: LLMClient,
    public id: string,
    public conversation: string[] = [],
  ) {
    this.client = client;
    this.id = id;
    this.conversation = conversation;
  }

  async sendMessage(message: string): Promise<string> {
    const response: AppendThreadResponse = await this.client.continueThread(
      this.id,
      message,
    );

    this.conversation.push(`User: ${message}`);
    let assistantResponse = response.assistantResponse;
    this.conversation.push(`Assistant: ${assistantResponse.content}`);

    return response.output;
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

    const initialAssistantResponse = response.output;
    thread.conversation.push(`User: ${message}`);
    thread.conversation.push(`Assistant: ${initialAssistantResponse}`);

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
}

// Types (you can move these to a separate file if desired)
interface CreateThreadRequest {
  action: "create";
  system: string;
  message: string;
  activeTools: CoreTool[];
}

interface AppendThreadRequest {
  action: "append";
  threadId: string;
  message?: string;
  toolResponses: ToolResponse[];
}

interface CreateThreadResponse {
  threadId: string;
  output: string;
  assistantResponse: CoreMessage;
  conversation: CoreMessage[];
}

interface AppendThreadResponse {
  threadId: string;
  assistantResponse: CoreMessage;
  output: string;
  conversation: CoreMessage[];
}

interface ToolResponse {
  type: "tool_result";
  tool_use_id: string;
  content: { type: "text"; text: string }[];
}
