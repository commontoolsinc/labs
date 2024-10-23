import { CoreMessage } from "npm:ai@3.3.21";
import { ai, anthropic, openai } from "./deps.ts";
const { streamText, generateText } = ai;

const SONNET = "claude-3-5-sonnet-latest";
const HAIKU = "claude-3-haiku-20240307";
const O1_MINI = "o1-mini";
const O1_PREVIEW = "o1-preview";
const model = anthropic(SONNET);
const fastModel = anthropic(HAIKU);
const smartModel = openai(O1_PREVIEW);

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

export function grabHtml(txt: string) {
  const html = txt.match(/```html\n([\s\S]+?)```/)?.[1];
  if (!html) {
    console.error("No HTML found in text", txt);
    return ""
  }
  return html;
}

export async function chat(
  system: string,
  messages: CoreMessage[],
  silent = false,
) {
  const { textStream: analysisStream } = await streamText({
    model: model,
    system,
    messages,
    temperature: 1.0
  });

  let message = "";
  for await (const delta of analysisStream) {
    message += delta;
    if (!silent) {
      Deno.stdout.writeSync(new TextEncoder().encode(delta));
    }
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

export async function fastCompletion(
  system: string,
  messages: CoreMessage[],
  silent = false,
) {
  const { textStream: analysisStream } = await streamText({
    model: fastModel,
    system,
    messages,
  });

  let message = "";
  for await (const delta of analysisStream) {
    message += delta;
    if (!silent) {
      Deno.stdout.writeSync(new TextEncoder().encode(delta));
    }
  }

  const analysis = grabJson(message);
  return analysis;
}

export async function smart(
  messages: CoreMessage[],
  silent = false,
) {
  const result = await generateText({
    model: smartModel,
    messages,
    temperature: 1.0,
  });

  return grabJson(result.text);
}
