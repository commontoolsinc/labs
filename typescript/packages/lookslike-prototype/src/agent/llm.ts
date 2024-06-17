import Instructor from "@instructor-ai/instructor";
import OpenAI from "openai";
import { fetchApiKey } from "../apiKey.js";
import {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionChunk
} from "openai/resources/index.mjs";
import { recordThought } from "./model.js";
import { toolSpec } from "./tools.js";

export let model = "gpt-4o";
export const apiKey = fetchApiKey() as string;

const openai = new OpenAI({
  apiKey: apiKey,
  dangerouslyAllowBrowser: true
});

export const client = Instructor({
  client: openai,
  mode: "JSON"
});

export async function generateImage(prompt: string) {
  const response = await openai.images.generate({
    model: "dall-e-3",
    prompt: prompt,
    n: 1,
    size: "1024x1024"
  });
  return response.data[0].url;
}

export function messageReducer(
  previous: ChatCompletionMessage,
  item: ChatCompletionChunk
): ChatCompletionMessage {
  const reduce = (acc: any, delta: any) => {
    acc = { ...acc };
    for (const [key, value] of Object.entries(delta)) {
      // console.log("kv", key, value, acc);
      if (acc[key] === undefined || acc[key] === null) {
        acc[key] = value;
      } else if (typeof acc[key] === "string" && typeof value === "string") {
        (acc[key] as string) += value;
      } else if (typeof acc[key] === "object" && !Array.isArray(acc[key])) {
        acc[key] = reduce(acc[key], value);
      } else if (Array.isArray(acc[key])) {
        acc[key] = acc[key].map((v, i) => reduce(v, value[i]));
      }
    }
    return acc;
  };

  return reduce(previous, item.choices[0]!.delta) as ChatCompletionMessage;
}

export async function processUserInput(
  input: string,
  system: string,
  availableFunctions: { [key: string]: Function }
) {
  console.group(`process`);

  let messages: ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user", content: input }
  ];

  await recordThought(messages[0]);
  await recordThought(messages[1]);

  let running = true;
  while (running) {
    console.log("messages", messages);
    const response = await client.chat.completions.create({
      messages,
      model,
      tools: toolSpec,
      tool_choice: "auto",
      temperature: 0
    });

    const message = response.choices[0].message;
    if (response.choices[0].finish_reason === "stop") {
      return message;
    }

    const latest = message;
    await recordThought(latest);
    messages.push(latest);

    const toolCalls = latest.tool_calls;
    if (toolCalls) {
      for (const toolCall of toolCalls) {
        console.log("toolCall", toolCall);
        const functionName = toolCall.function.name;
        const functionToCall = availableFunctions[functionName];
        // escape all newlines in arguments string
        const functionArgs = JSON.parse(
          toolCall.function.arguments.replace(/\n/g, "\n")
        );
        const functionResponse = functionToCall(functionArgs);
        console.log("response", toolCall.id, functionResponse);
        const toolResponse = {
          tool_call_id: toolCall.id,
          role: "tool" as const,
          content: functionResponse
        };
        messages.push(toolResponse);
      }
    }
  }

  console.groupEnd();
  return null;
}

export async function doLLM(input: string, system: string, _: any = undefined) {
  console.group("doLLM");
  try {
    console.log("input", input);
    console.log("system", system);

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      { role: "user", content: input }
    ];

    console.groupEnd();
    return await client.chat.completions.create({
      messages,
      model,
      temperature: 0
    });
  } catch (error) {
    console.groupEnd();
    console.error("Error analyzing text:", error);
    return null;
  }
}

export async function streamLlm(
  input: string,
  system: string,
  respond: (response: any) => void
) {
  console.group("streamLlm");
  try {
    console.log("input", input);
    console.log("system", system);

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      { role: "user", content: input }
    ];

    const response = await client.chat.completions.create({
      messages,
      model,
      temperature: 0,
      stream: true
    });

    const responses = [] as string[];
    for await (const message of response) {
      const delta = message.choices[0].delta.content;
      if (!delta) continue;
      responses.push(delta);
      respond(responses.join(""));
    }

    console.groupEnd();
    return responses.join("");
  } catch (error) {
    console.error("Error analyzing text:", error);
    console.groupEnd();
    return null;
  }
}

export function grabViewTemplate(txt: string) {
  return txt.match(/```vue\n([\s\S]+?)```/)?.[1];
}

export function grabJson(txt: string) {
  const json = txt.match(/```json\n([\s\S]+?)```/)?.[1];
  if (!json) {
    console.error("No JSON found in text", txt);
    return {};
  }
  return JSON.parse(json);
}

export function extractResponse(data: any) {
  return data.choices[0].message.content;
}

export function extractImage(data: any) {
  return data.data[0].url;
}
