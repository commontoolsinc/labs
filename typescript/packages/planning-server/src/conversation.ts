import { CoreMessage, CoreTool } from "npm:ai";

export interface ConversationThread {
  id: string;
  conversation: CoreMessage[];
  system: string;
  activeTools: CoreTool[];
}

export interface ConversationThreadManager {
  create(
    system: string,
    initialMessage: string,
    activeTools: CoreTool[]
  ): ConversationThread;
  get(id: string): ConversationThread | undefined;
  update(id: string, newMessages: CoreMessage[]): void;
  delete(id: string): void;
}

export class InMemoryConversationThreadManager
  implements ConversationThreadManager
{
  private threads: Map<string, ConversationThread> = new Map();

  create(
    system: string,
    initialMessage: string,
    activeTools: CoreTool[]
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
    };
    this.threads.set(id, thread);
    return thread;
  }

  get(id: string): ConversationThread | undefined {
    return this.threads.get(id);
  }

  update(id: string, newMessages: CoreMessage[]): void {
    const thread = this.threads.get(id);
    if (thread) {
      thread.conversation = [...thread.conversation, ...newMessages];
    }
  }

  delete(id: string): void {
    this.threads.delete(id);
  }
}
