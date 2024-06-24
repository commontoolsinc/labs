import { Anthropic } from "./deps.ts";

export interface ConversationThread {
  id: string;
  conversation: Anthropic.Messages.MessageParam[];
  system: string;
  activeTools: Anthropic.Messages.Tool[];
  pendingToolCalls: Anthropic.Messages.ToolUseBlockParam[] | null;
}

export interface ConversationThreadManager {
  create(
    system: string,
    initialMessage: string,
    activeTools: Anthropic.Messages.Tool[],
  ): ConversationThread;
  get(id: string): ConversationThread | undefined;
  update(id: string, newMessages: Anthropic.Messages.MessageParam[]): void;
  setPendingToolCalls(
    id: string,
    toolCalls: Anthropic.Messages.ToolUseBlock[],
  ): void;
  delete(id: string): void;
}

export class InMemoryConversationThreadManager
  implements ConversationThreadManager
{
  private threads: Map<string, ConversationThread> = new Map();

  create(
    system: string,
    initialMessage: string,
    activeTools: Anthropic.Messages.Tool[],
  ): ConversationThread {
    const id = crypto.randomUUID();
    const thread: ConversationThread = {
      id,
      conversation: [
        {
          role: "user",
          content: [{ type: "text", text: initialMessage }],
        },
      ],
      system,
      activeTools,
      pendingToolCalls: null,
    };
    this.threads.set(id, thread);
    return thread;
  }

  get(id: string): ConversationThread | undefined {
    return this.threads.get(id);
  }

  update(id: string, newMessages: Anthropic.Messages.MessageParam[]): void {
    const thread = this.threads.get(id);
    if (thread) {
      thread.conversation = [...thread.conversation, ...newMessages];
      // console.log("Updated thread", thread);
      thread.pendingToolCalls = null;
    }
  }

  setPendingToolCalls(
    id: string,
    toolCalls: Anthropic.Messages.ToolUseBlockParam[],
  ): void {
    const thread = this.threads.get(id);
    if (thread) {
      thread.pendingToolCalls = toolCalls;
    }
  }

  delete(id: string): void {
    this.threads.delete(id);
  }
}
