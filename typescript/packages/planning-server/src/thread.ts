import { Anthropic } from "./deps.ts";

export interface Thread {
  id: string;
  conversation: Anthropic.Messages.MessageParam[];
  system: string;
  activeTools: Anthropic.Messages.Tool[];
  pendingToolCalls: Anthropic.Messages.ToolUseBlockParam[] | null;
}

export interface ThreadManager {
  create(
    system: string,
    initialMessage: string,
    activeTools: Anthropic.Messages.Tool[]
  ): Thread;
  get(id: string): Thread | undefined;
  update(id: string, newMessages: Anthropic.Messages.MessageParam[]): void;
  setPendingToolCalls(
    id: string,
    toolCalls: Anthropic.Messages.ToolUseBlock[]
  ): void;
  delete(id: string): void;
}

export class InMemoryThreadManager implements ThreadManager {
  private threads: Map<string, Thread> = new Map();

  create(
    system: string,
    initialMessage: string,
    activeTools: Anthropic.Messages.Tool[]
  ): Thread {
    const id = crypto.randomUUID();
    const thread: Thread = {
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

  get(id: string): Thread | undefined {
    return this.threads.get(id);
  }

  update(id: string, newMessages: Anthropic.Messages.MessageParam[]): void {
    const thread = this.threads.get(id);
    if (thread) {
      thread.conversation = [...thread.conversation, ...newMessages];
      console.log("Updated thread", thread);
      thread.pendingToolCalls = null;
    }
  }

  setPendingToolCalls(
    id: string,
    toolCalls: Anthropic.Messages.ToolUseBlockParam[]
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
