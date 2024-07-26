import { CoreAssistantMessage, CoreMessage, CoreTool } from "npm:ai";
import {
  ConversationThread,
  InMemoryConversationThreadManager,
} from "./conversation.ts";
import { ask } from "./llm.ts";

const cache: Record<string, any> = {};
const threadManager = new InMemoryConversationThreadManager();

type CreateConversationThreadResponse = {
  type: "success";
  threadId: string;
  output: string;
  assistantResponse: CoreAssistantMessage;
  conversation: CoreMessage[];
};

type AppendToConversationThreadResponse = {
  type: "success";
  threadId: string;
  output: string;
  assistantResponse: CoreAssistantMessage;
  conversation: CoreMessage[];
};

type ConversationThreadResponse =
  | CreateConversationThreadResponse
  | AppendToConversationThreadResponse;

type ErrorResponse = {
  type: "error";
  error: string;
};

export async function handleCreateConversationThread(
  system: string,
  message: string,
  activeTools: CoreTool[]
): Promise<CreateConversationThreadResponse | ErrorResponse> {
  const cacheKey = `${system}:${message}`;

  if (cache[cacheKey]) {
    console.log(
      "Cache hit!",
      (cacheKey.slice(0, 20) + "..." + cacheKey.slice(-20)).replaceAll("\n", "")
    );
    return cache[cacheKey];
  }

  const thread = threadManager.create(system, message, activeTools);
  const result = await processConversationThread(thread);
  if (result.type === "error") {
    throw new Error(result.error);
  }

  if (result.assistantResponse) {
    threadManager.update(thread.id, [result.assistantResponse]);
  }

  // cache[cacheKey] = result;

  return result;
}

export async function handleAppendToConversationThread(
  threadId: string,
  message?: string
): Promise<AppendToConversationThreadResponse | ErrorResponse> {
  const thread = threadManager.get(threadId);
  if (!thread) {
    throw new Error("Thread not found");
  }

  if (message) {
    threadManager.update(threadId, [
      {
        role: "user",
        content: message,
      },
    ]);
  }

  const result = await processConversationThread(thread);
  if (result.type === "error") {
    return result;
  }

  // Update the thread with the assistant's response
  if (result.assistantResponse) {
    threadManager.update(threadId, [result.assistantResponse]);
  }

  return result;
}

type ProcessConversationThreadResult =
  | {
      type: "success";
      threadId: string;
      output: string;
      assistantResponse: CoreAssistantMessage;
      conversation: CoreMessage[];
    }
  | { type: "error"; error: string };

async function processConversationThread(
  thread: ConversationThread
): Promise<ProcessConversationThreadResult> {
  console.log("Thread", thread);

  const result = await ask(
    thread.conversation,
    thread.system,
    thread.activeTools
  );
  if (!result) {
    return { type: "error", error: "No response from Anthropic" };
  }

  // Find the new assistant's response (it should be the last message)
  const assistantResponse = result[result.length - 1];
  if (assistantResponse.role !== "assistant") {
    return { type: "error", error: "No assistant response found" };
  }

  if (Array.isArray(assistantResponse.content)) {
    assistantResponse.content = assistantResponse.content
      .filter((msg) => msg.type == "text")
      .map((msg) => msg.text)
      .join(" ");
  }

  const output = assistantResponse.content;
  console.log("Output=", output);
  return {
    type: "success",
    threadId: thread.id,
    output,
    assistantResponse,
    conversation: result,
  };
}
