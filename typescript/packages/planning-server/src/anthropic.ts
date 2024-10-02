import { anthropic, ai } from "./deps.ts";
import { CoreMessage } from "npm:ai";
import { CoreTool } from "npm:ai";
const { generateText: _generateText, streamText } = ai;

export const OPUS = "claude-3-5-opus-20240307";
export const HAIKU = "claude-3-haiku-20240307";
export const SONNET = "claude-3-5-sonnet-20240620";
const model = anthropic(SONNET);

type Model = typeof model;

const _MAX_TOKENS = 4096;

export async function single(text: string, model: Model) {
  let response = "";
  const { textStream } = await streamText({
    model,
    prompt: text,
  });

  for await (const delta of textStream) {
    response += delta;
    Deno.stdout.writeSync(new TextEncoder().encode(delta));
  }

  return response;
}

export async function ask(
  initialConversation: CoreMessage[] = [],
  systemPrompt: string = "",
  _activeTools: CoreTool[],
) {
  const conversation: CoreMessage[] = [...initialConversation];

  let running = true;
  while (running) {
    const { textStream, finishReason } = await streamText({
      model,
      system: systemPrompt,
      messages: conversation,
    });

    let message = "";
    for await (const delta of textStream) {
      message += delta;
      Deno.stdout.writeSync(new TextEncoder().encode(delta));
    }

    const reason = await finishReason;

    conversation.push({
      role: "assistant",
      content: message,
    });

    // console.log("\nMessage", stopReason);
    if (reason === "stop" || reason === "error" || reason === "length") {
      console.log("Stopping conversation", reason);
      running = false;
      return conversation;
    }

    // TODO: tools? maybe we just don't need them?
  }
  return conversation;
}
