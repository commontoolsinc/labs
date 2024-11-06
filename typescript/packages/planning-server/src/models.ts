import { anthropic } from "npm:@ai-sdk/anthropic";
import { groq } from "npm:@ai-sdk/groq";
import { openai } from "npm:@ai-sdk/openai";
import { vertex } from "npm:@ai-sdk/google-vertex";
import { ollama } from "ollama-ai-provider";

type ModelConfig = {
  model: any;
  contextWindow: number;
  maxOutputTokens: number;
};

export const MODELS: Record<string, ModelConfig> = {};

const addModel = ({
  provider,
  name,
  contextWindow,
  maxOutputTokens,
  aliases,
}: {
  provider: typeof anthropic | typeof groq | typeof openai | typeof vertex;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  aliases: string[];
}) => {
  const model = provider(
    name.includes(":") ? name.split(":").slice(1).join(":") : name,
  );
  const config: ModelConfig = {
    model,
    contextWindow,
    maxOutputTokens,
  };
  MODELS[name] = config;
  for (const alias of aliases) {
    MODELS[alias] = config;
  }
};

if (Deno.env.get("ANTHROPIC_API_KEY")) {
  addModel({
    provider: anthropic,
    name: "anthropic:claude-3-5-haiku-20241022",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    aliases: [
      "anthropic:claude-3-5-haiku-latest",
      "claude-3-5-haiku",
    ],
  });

  addModel({
    provider: anthropic,
    name: "anthropic:claude-3-5-sonnet-20241022",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    aliases: [
      "anthropic:claude-3-5-sonnet-latest",
      "claude-3-5-sonnet",
    ],
  });

  addModel({
    provider: anthropic,
    name: "anthropic:claude-3-opus-20240229",
    contextWindow: 200000,
    maxOutputTokens: 4096,
    aliases: [
      "anthropic:claude-3-opus-latest",
      "claude-3-opus",
    ],
  });
}

if (Deno.env.get("GROQ_API_KEY")) {
  addModel({
    provider: groq,
    name: "groq:llama-3.1-70b-versatile",
    contextWindow: 128000,
    maxOutputTokens: 8000,
    aliases: [
      "groq:llama-3.1-70b",
    ],
  });

  addModel({
    provider: groq,
    name: "groq:llama-3.1-8b-instant",
    contextWindow: 128000,
    maxOutputTokens: 8000,
    aliases: [],
  });

  addModel({
    provider: groq,
    name: "groq:llama-3.2-11b-vision-preview",
    contextWindow: 128000,
    maxOutputTokens: 8000,
    aliases: [
      "groq:llama-3.2-11b-vision",
    ],
  });

  addModel({
    provider: groq,
    name: "groq:llama-3.2-90b-vision-preview",
    contextWindow: 128000,
    maxOutputTokens: 8000,
    aliases: [
      "groq:llama-3.2-90b-vision",
    ],
  });

  addModel({
    provider: groq,
    name: "groq:llama-3.2-3b-preview",
    contextWindow: 128000,
    maxOutputTokens: 8000,
    aliases: [],
  });
}

if (Deno.env.get("OPENAI_API_KEY")) {
  addModel({
    provider: openai,
    name: "openai:gpt-4o-2024-08-06",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    aliases: [
      "openai:gpt-4o",
      "openai:gpt-4o-latest",
      "gpt-4o",
    ],
  });

  addModel({
    provider: openai,
    name: "openai:gpt-4o-mini-2024-07-18",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    aliases: [
      "openai:gpt-4o-mini-latest",
      "openai:gpt-4o-mini",
      "gpt-4o-mini",
    ],
  });

  addModel({
    provider: openai,
    name: "openai:o1-preview-2024-09-12",
    contextWindow: 128000,
    maxOutputTokens: 32768,
    aliases: [
      "openai:o1-preview-latest",
      "openai:o1-preview",
      "o1-preview",
    ],
  });

  addModel({
    provider: openai,
    name: "openai:o1-mini-2024-09-12",
    contextWindow: 128000,
    maxOutputTokens: 65536,
    aliases: [
      "openai:o1-mini-latest",
      "openai:o1-mini",
      "o1-mini",
    ],
  });
}

if (Deno.env.get("OLLAMA_API_MODEL")) {
  addModel({
    provider: ollama,
    name: `ollama:${Deno.env.get("OLLAMA_API_MODEL")}`,
    contextWindow: 128000,
    maxOutputTokens: 8000,
    aliases: [
      `ollama`,
    ],
  });
}

if (
  Deno.env.get("GOOGLE_API_KEY") ||
  Deno.env.get("GOOGLE_APPLICATION_CREDENTIALS")
) {
  addModel({
    provider: vertex,
    name: "google:gemini-1.5-flash-002",
    contextWindow: 1_000_000,
    maxOutputTokens: 8192,
    aliases: [
      "google:gemini-1.5-flash",
    ],
  });

  addModel({
    provider: vertex,
    name: "google:gemini-1.5-pro-002",
    contextWindow: 1_000_000,
    maxOutputTokens: 8192,
    aliases: [
      "google:gemini-1.5-pro",
    ],
  });
}

export const findModel = (name: string) => {
  return MODELS[name];
};
