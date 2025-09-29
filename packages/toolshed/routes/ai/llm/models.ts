import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGroq, groq } from "@ai-sdk/groq";
import { openai } from "@ai-sdk/openai";
import { createVertex, vertex } from "@ai-sdk/google-vertex";
import { createXai, xai } from "@ai-sdk/xai";
import { createPerplexity, perplexity } from "@ai-sdk/perplexity";
import type { LanguageModel } from "ai";

import env from "@/env.ts";

export type Capabilities = {
  contextWindow: number;
  maxOutputTokens: number;
  streaming: boolean;
  systemPrompt: boolean;
  systemPromptWithImages?: boolean;
  stopSequences: boolean;
  prefill: boolean;
  images: boolean;
  reasoning: boolean;
};

type ModelConfig = {
  model: LanguageModel;
  name: string;
  capabilities: Capabilities;
  aliases: string[];
};

export type ModelList = Record<string, ModelConfig>;

export const MODELS: ModelList = {};
export const ALIAS_NAMES: string[] = [];
export const PROVIDER_NAMES: Set<string> = new Set();

export const TASK_MODELS = {
  coding: "anthropic:claude-sonnet-4-5", // Best for code
  json: "anthropic:claude-sonnet-4-5", // Fast & good at structured output
  creative: "openai:gpt-5", // Best for creative tasks
  vision: "google:gemini-2.5-pro", // Best for vision tasks
} as const;

export type TaskType = keyof typeof TASK_MODELS;

const addModel = ({
  provider,
  name,
  aliases,
  capabilities,
  providerOptions,
}: {
  provider:
    | typeof anthropic
    | typeof groq
    | typeof openai
    | typeof vertex
    | typeof xai
    | typeof perplexity;
  name: string;
  aliases: string[];
  capabilities: Capabilities;
  providerOptions?: Record<string, unknown>;
}) => {
  let modelName = name.includes(":")
    ? name.split(":").slice(1).join(":")
    : name;

  // AWS includes colons in their model names, so we need to special case it.
  if (name.includes("us.amazon")) {
    modelName = name;
  }

  if (name.includes("-thinking")) {
    modelName = modelName.split("-thinking")[0];
  }

  const model = provider(modelName);

  const config: ModelConfig = {
    model,
    name,
    capabilities,
    aliases,
  };

  MODELS[name] = config;
  for (const alias of aliases) {
    MODELS[alias] = config;
    ALIAS_NAMES.push(alias);
  }
  PROVIDER_NAMES.add(name.split(":")[0]);
};

if (env.CTTS_AI_LLM_ANTHROPIC_API_KEY) {
  const anthropicProvider = createAnthropic({
    apiKey: env.CTTS_AI_LLM_ANTHROPIC_API_KEY,
  });
  console.log(" Adding 🤖 anthropic");

  addModel({
    provider: anthropicProvider,
    name: "anthropic:claude-opus-4-1",
    aliases: ["anthropic:claude-opus-4-1-latest", "claude-opus-4-1"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 32000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });

  addModel({
    provider: anthropicProvider,
    name: "anthropic:claude-opus-4-1-thinking",
    aliases: [
      "anthropic:claude-opus-4-1-thinking-latest",
      "claude-opus-4-1-thinking",
    ],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 32000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: true,
    },
    providerOptions: {
      anthropic: {
        thinking: { type: "enabled", budgetTokens: 32000 },
      },
    },
  });

  addModel({
    provider: anthropicProvider,
    name: "anthropic:claude-sonnet-4-0",
    aliases: ["anthropic:claude-sonnet-4-0-latest", "claude-sonnet-4-0"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 64000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });

  addModel({
    provider: anthropicProvider,
    name: "anthropic:claude-sonnet-4-0-thinking",
    aliases: [
      "anthropic:claude-sonnet-4-0-thinking-latest",
      "claude-sonnet-4-0-thinking",
    ],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 64000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: true,
    },
    providerOptions: {
      anthropic: {
        thinking: { type: "enabled", budgetTokens: 64000 },
      },
    },
  });

  addModel({
    provider: anthropicProvider,
    name: "anthropic:claude-sonnet-4-5",
    aliases: ["sonnet-4-5", "sonnet-4.5"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 64000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });

  addModel({
    provider: anthropicProvider,
    name: "anthropic:claude-sonnet-4-5-thinking",
    aliases: ["sonnet-4-5-thinking", "sonnet-4.5-thinking"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 64000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: true,
    },
    providerOptions: {
      anthropic: {
        thinking: { type: "enabled", budgetTokens: 64000 },
      },
    },
  });
}

if (env.CTTS_AI_LLM_GROQ_API_KEY) {
  const groqProvider = createGroq({
    apiKey: env.CTTS_AI_LLM_GROQ_API_KEY,
  });
  console.log(" Adding 🤖 groq");

  addModel({
    provider: groqProvider,
    name: "groq:moonshotai/kimi-k2-instruct",
    aliases: ["groq:kimi-k2-instruct", "kimi-k2-instruct"],
    capabilities: {
      contextWindow: 131_072,
      maxOutputTokens: 16384,
      images: false,
      prefill: false,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });

  addModel({
    provider: groqProvider,
    name: "groq:openai/gpt-oss-120b",
    aliases: ["groq:gpt-oss-120b", "gpt-oss-120b"],
    capabilities: {
      contextWindow: 131_072,
      maxOutputTokens: 65536,
      images: false,
      prefill: false,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });
}

if (env.CTTS_AI_LLM_OPENAI_API_KEY) {
  const openAIProvider = createOpenAI({
    apiKey: env.CTTS_AI_LLM_OPENAI_API_KEY,
  });
  console.log(" Adding 🤖 openai");
  addModel({
    provider: openAIProvider,
    name: "openai:gpt-5",
    aliases: ["openai:gpt-5-latest", "gpt-5"],
    capabilities: {
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      images: true,
      prefill: false,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:gpt-5-thinking",
    aliases: ["openai:gpt-5-thinking-latest", "gpt-5-thinking"],
    capabilities: {
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      images: true,
      prefill: false,
      systemPrompt: true,
      stopSequences: false,
      streaming: true,
      reasoning: true,
    },
    providerOptions: {
      reasoningEffort: "high",
    },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:gpt-5-mini",
    aliases: ["openai:gpt-5-mini-latest", "gpt-5-mini"],
    capabilities: {
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      images: true,
      prefill: false,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:gpt-5-mini-thinking",
    aliases: ["openai:gpt-5-mini-thinking-latest", "gpt-5-mini-thinking"],
    capabilities: {
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      images: true,
      prefill: false,
      systemPrompt: false,
      stopSequences: false,
      streaming: true,
      reasoning: true,
    },
    providerOptions: {
      reasoningEffort: "high",
    },
  });
}

if (env.CTTS_AI_LLM_GOOGLE_APPLICATION_CREDENTIALS) {
  const credentials = JSON.parse(
    Deno.readTextFileSync(env.CTTS_AI_LLM_GOOGLE_APPLICATION_CREDENTIALS),
  );
  console.log(" Adding 🤖 google");
  const vertexProvider = createVertex({
    googleAuthOptions: {
      credentials,
    },
    project: env.CTTS_AI_LLM_GOOGLE_VERTEX_PROJECT,
    location: env.CTTS_AI_LLM_GOOGLE_VERTEX_LOCATION,
  });

  addModel({
    provider: vertexProvider,
    name: "google:gemini-2.5-pro",
    aliases: ["google:gemini-2.5-pro-latest", "gemini-2.5-pro"],
    capabilities: {
      contextWindow: 1_000_000,
      maxOutputTokens: 65_536,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: true,
    },
  });

  addModel({
    provider: vertexProvider,
    name: "google:gemini-2.5-pro-thinking",
    aliases: [
      "google:gemini-2.5-pro-thinking-latest",
      "gemini-2.5-pro-thinking",
    ],
    capabilities: {
      contextWindow: 1_000_000,
      maxOutputTokens: 65_536,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: true,
    },
  });

  addModel({
    provider: vertexProvider,
    name: "google:gemini-2.5-flash",
    aliases: ["google:gemini-2.5-flash-latest", "gemini-2.5-flash"],
    capabilities: {
      contextWindow: 1_000_000,
      maxOutputTokens: 8_192,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: true,
    },
  });

  addModel({
    provider: vertexProvider,
    name: "google:gemini-2.5-flash-thinking",
    aliases: [
      "google:gemini-2.5-flash-thinking-latest",
      "gemini-2.5-flash-thinking",
    ],
    capabilities: {
      contextWindow: 1_000_000,
      maxOutputTokens: 8_192,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: true,
    },
  });
}

if (env.CTTS_AI_LLM_PERPLEXITY_API_KEY) {
  const perplexityProvider = createPerplexity({
    apiKey: env.CTTS_AI_LLM_PERPLEXITY_API_KEY,
  });
  console.log(" Adding 🤖 perplexity");
  addModel({
    provider: perplexityProvider,
    name: "perplexity:sonar-reasoning-pro",
    aliases: ["sonar-reasoning-pro"],
    capabilities: {
      contextWindow: 128_000,
      maxOutputTokens: 8000,
      images: false,
      prefill: false,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: true,
    },
  });

  addModel({
    provider: perplexityProvider,
    name: "perplexity:sonar-deep-research",
    aliases: ["sonar-deep-research"],
    capabilities: {
      contextWindow: 128_000,
      maxOutputTokens: 8000,
      images: false,
      prefill: false,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: true,
    },
  });
}

if (env.CTTS_AI_LLM_XAI_API_KEY) {
  const xaiProvider = createXai({
    apiKey: env.CTTS_AI_LLM_XAI_API_KEY,
  });
  console.log(" Adding 🤖 Xai");
  addModel({
    provider: xaiProvider,
    name: "xai:grok-4",
    aliases: ["grok-4", "grok-4-latest"],
    capabilities: {
      contextWindow: 256_000,
      maxOutputTokens: 128_000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: false,
    },
  });

  addModel({
    provider: xaiProvider,
    name: "xai:grok-4-thinking",
    aliases: ["grok-4-thinking", "grok-4-thinking-latest"],
    capabilities: {
      contextWindow: 256_000,
      maxOutputTokens: 128_000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
      reasoning: true,
    },
  });
}

export const findModel = (name: string) => {
  return MODELS[name];
};
