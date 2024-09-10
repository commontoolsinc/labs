import { CoreMessage } from "npm:ai@3.3.21";
import { ai, anthropic } from "./deps.ts";
const streamText = ai.streamText;

const SONNET = "claude-3-5-sonnet-20240620";
const model = anthropic(SONNET);

export function grabJson(txt: string) {
  // try parsing whole string first
  try {
    return JSON.parse(txt);
  } catch (error) {
    // if that fails, try to grab it from the text
  }

  const json = txt.match(/```json\n([\s\S]+?)```/)?.[1];
  if (!json) {
    console.error("No JSON found in text", txt);
    return {};
  }
  return JSON.parse(json);
}

export async function chat(system: string, messages: CoreMessage[]) {
  const { textStream: analysisStream } = await streamText({
    model: model,
    system,
    messages,
  });

  let message = "";
  for await (const delta of analysisStream) {
    message += delta;
    Deno.stdout.writeSync(new TextEncoder().encode(delta));
  }

  return message;
}

export async function completion(system: string, messages: CoreMessage[]) {
  const { textStream: analysisStream } = await streamText({
    model: model,
    system,
    messages,
  });

  let message = "";
  for await (const delta of analysisStream) {
    message += delta;
    Deno.stdout.writeSync(new TextEncoder().encode(delta));
  }

  const analysis = grabJson(message);
  return analysis;
}
