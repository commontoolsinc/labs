import { anthropic, google, ai, vertex, openai } from "./deps.ts";
import { CoreMessage } from "npm:ai";
import { CoreTool } from "npm:ai";
const { generateText, streamText } = ai;

export const OPUS = "claude-3-opus-20240229";
export const HAIKU = "claude-3-haiku-20240307";
export const SONNET = "claude-3-5-sonnet-20240620";
export const LLAMA_3_1_405B = "llama3-405b-instruct-maas";
export const GPT4O_MINI = "gpt-4o-mini";
export const GPT4O = "gpt-4o";

const models = {
  [OPUS]: anthropic(OPUS),
  [HAIKU]: anthropic(HAIKU),
  [SONNET]: anthropic(SONNET),
  [LLAMA_3_1_405B]: vertex(LLAMA_3_1_405B),
  [GPT4O_MINI]: openai(GPT4O_MINI),
  [GPT4O]: openai(GPT4O),
};

const model = models[SONNET];

export type ModelName = keyof typeof models;
type Model = typeof model;

const MAX_TOKENS = 4096;

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
  activeTools: CoreTool[],
  modelOverride?: ModelName
) {
  const conversation: CoreMessage[] = [...initialConversation];

  let running = true;
  while (running) {
    console.log(`Asking ${modelOverride}...`);
    const { textStream, finishReason } = await streamText({
      model: modelOverride ? models[modelOverride] : model,
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
