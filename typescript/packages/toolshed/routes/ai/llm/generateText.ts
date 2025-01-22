import { streamText } from "npm:ai";
import { z } from "zod";

import type { AppRouteHandler } from "@/lib/types.ts";
import {
  ALIAS_NAMES,
  findModel,
  ModelList,
  MODELS,
  TASK_MODELS,
} from "./models.ts";
import * as cache from "./cache.ts";
import type { Context } from "hono";

// Core generation logic separated from HTTP handling
export interface GenerateTextParams {
  model?: string;
  task?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  system?: string;
  stream?: boolean;
  stop_token?: string;
  abortSignal?: AbortSignal;
}

export interface GenerateTextResult {
  message: { role: 'user' | 'assistant'; content: string };
  stream?: ReadableStream;
}

export async function generateText(
  params: GenerateTextParams,
): Promise<GenerateTextResult> {
  // Validate required model or task parameter
  if (!params.model && !params.task) {
    throw new Error("You must specify a `model` or `task`.");
  }

  let modelName = params.model;

  // If task specified, lookup corresponding model
  if (params.task) {
    const taskModel = TASK_MODELS[params.task as keyof typeof TASK_MODELS];
    if (!taskModel) {
      throw new Error(`Unsupported task: ${params.task}`);
    }
    modelName = taskModel;
  }

  // Validate and configure model
  const modelConfig = findModel(modelName!);
  if (!modelConfig) {
    console.error("Unsupported model:", modelName);
    throw new Error(`Unsupported model: ${modelName}`);
  }

  const messages = params.messages;
  const streamParams = {
    model: modelConfig.model || modelName!,
    messages,
    stream: params.stream,
    system: params.system,
    stopSequences: params.stop_token ? [params.stop_token] : undefined,
    abortSignal: params.abortSignal,
    experimental_telemetry: { isEnabled: true },
  };

  // Handle models that don't support system prompts
  if (
    !modelConfig.capabilities.systemPrompt &&
    params.system &&
    messages.length > 0
  ) {
    messages[0].content = `${params.system}\n\n${messages[0].content}`;
    streamParams.system = undefined;
  }

  // Add model-specific configuration
  if (modelConfig.model) {
    streamParams.model = modelConfig.model;
  }

  const llmStream = await streamText(streamParams);

  // If not streaming, handle regular response
  if (!params.stream) {
    let result = "";
    for await (const delta of llmStream.textStream) {
      result += delta;
    }

    if (!result) {
      throw new Error("No response from LLM");
    }

    if ((await llmStream.finishReason) === "stop" && params.stop_token) {
      result += params.stop_token;
    }

    if (messages[messages.length - 1].role === "user") {
      messages.push({ role: "assistant", content: result });
    } else {
      messages[messages.length - 1].content = result;
    }

    return { message: messages[messages.length - 1] };
  }

  // Create streaming response
  const stream = new ReadableStream({
    async start(controller) {
      let result = "";
      // If last message was from assistant, send it first
      if (messages[messages.length - 1].role === "assistant") {
        result = messages[messages.length - 1].content;
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify(result) + "\n"),
        );
      }

      // Stream each chunk of generated text
      for await (const delta of llmStream.textStream) {
        result += delta;
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify(delta) + "\n"),
        );
      }

      // Add stop sequence if specified
      if ((await llmStream.finishReason) === "stop" && params.stop_token) {
        result += params.stop_token;
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify(params.stop_token) + "\n"),
        );
      }

      // Update message history
      if (messages[messages.length - 1].role === "user") {
        messages.push({ role: "assistant", content: result });
      } else {
        messages[messages.length - 1].content = result;
      }

      controller.close();
    },
  });

  return {
    message: messages[messages.length - 1],
    stream,
  };
}
