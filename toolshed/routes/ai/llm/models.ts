import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGroq, groq } from "@ai-sdk/groq";
import { openai } from "@ai-sdk/openai";
import { createVertex, vertex } from "@ai-sdk/google-vertex";

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
};

type ModelConfig = {
  model: string; // FIXME(ja): this type is wrong! it isn't a string
  name: string;
  capabilities: Capabilities;
  aliases: string[];
};

export type ModelList = Record<string, ModelConfig>;

export const MODELS: ModelList = {};
export const ALIAS_NAMES: string[] = [];
export const PROVIDER_NAMES: Set<string> = new Set();

export const TASK_MODELS = {
  coding: "anthropic:claude-3-5-sonnet-20241022", // Best for code
  json: "anthropic:claude-3-5-sonnet-20241022", // Fast & good at structured output
  creative: "openai:gpt-4o-2024-08-06", // Best for creative tasks
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
    | typeof vertex;
  name: string;
  aliases: string[];
  capabilities: Capabilities;
  providerOptions?: Record<string, any>;
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

  const model = providerOptions
    ? provider(modelName, providerOptions)
    : provider(modelName);

  const config: ModelConfig = {
    model: model as unknown as string, // FIXME(ja): this type is wrong! it isn't a string
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

  addModel({
    provider: anthropicProvider,
    name: "anthropic:claude-3-5-sonnet-20241022",
    aliases: ["anthropic:claude-3-5-sonnet-latest", "claude-3-5-sonnet"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });
  addModel({
    provider: anthropicProvider,
    name: "anthropic:claude-3-7-sonnet-20250219",
    aliases: ["anthropic:claude-3-7-sonnet-latest", "claude-3-7-sonnet"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 64000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });

  addModel({
    provider: anthropicProvider,
    name: "anthropic:claude-3-7-sonnet-20250219-thinking",
    aliases: [
      "anthropic:claude-3-7-sonnet-thinking-latest",
      "claude-3-7-sonnet-thinking",
    ],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 64000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
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
  addModel({
    provider: groqProvider,
    name: "groq:deepseek-r1-distill-llama-70b",
    aliases: ["groq:deepseek-r1-distill-llama-70b", "r1-llama-70b"],
    capabilities: {
      contextWindow: 128_000,
      maxOutputTokens: 32768,
      images: false,
      prefill: false,
      systemPrompt: false,
      stopSequences: false,
      streaming: true,
    },
  });

  addModel({
    provider: groqProvider,
    name: "groq:deepseek-r1-distill-qwen-32b",
    aliases: ["groq:deepseek-r1-distill-qwen-32b", "r1-qwen-32b"],
    capabilities: {
      contextWindow: 128_000,
      maxOutputTokens: 32768,
      images: false,
      prefill: false,
      systemPrompt: false,
      stopSequences: false,
      streaming: true,
    },
  });

  addModel({
    provider: groqProvider,
    name: "groq:qwen-qwq-32b",
    aliases: ["groq:qwen-qwq-32b", "qwen-qwq-32b"],
    capabilities: {
      contextWindow: 128_000,
      maxOutputTokens: 128_000,
      images: false,
      prefill: false,
      systemPrompt: false,
      stopSequences: false,
      streaming: true,
    },
  });

  addModel({
    provider: groqProvider,
    name: "groq:llama-3.3-70b-versatile",
    aliases: ["groq:llama-3.3-70b"],
    capabilities: {
      contextWindow: 128_000,
      maxOutputTokens: 32768,
      images: false,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: false,
    },
  });

  addModel({
    provider: groqProvider,
    name: "groq:llama-3.3-70b-specdec",
    aliases: ["groq:llama-3.3-70b-specdec"],
    capabilities: {
      contextWindow: 8192,
      maxOutputTokens: 8192,
      images: false,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: false,
    },
  });
}

if (env.CTTS_AI_LLM_OPENAI_API_KEY) {
  const openAIProvider = createOpenAI({
    apiKey: env.CTTS_AI_LLM_OPENAI_API_KEY,
  });
  addModel({
    provider: openAIProvider,
    name: "openai:gpt-4o",
    aliases: ["openai:gpt-4o", "openai:gpt-4o-latest", "gpt-4o"],
    capabilities: {
      contextWindow: 128_000,
      maxOutputTokens: 16384,
      images: true,
      prefill: false,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:o3-2025-04-16",
    aliases: ["openai:o3", "o3"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      images: true,
      prefill: false,
      systemPrompt: false,
      stopSequences: true,
      streaming: true,
    },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:o4-mini-2025-04-16",
    aliases: ["openai:o4-mini-low", "o4-mini-low"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      images: true,
      prefill: false,
      systemPrompt: false,
      stopSequences: true,
      streaming: true,
    },
    providerOptions: { reasoningEffort: "low" },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:o4-mini-2025-04-16",
    aliases: ["openai:o4-mini-medium", "o4-mini-medium"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      images: true,
      prefill: false,
      systemPrompt: false,
      stopSequences: true,
      streaming: true,
    },
    providerOptions: { reasoningEffort: "medium" },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:o4-mini-2025-04-16",
    aliases: ["openai:o4-mini-high", "o4-mini-high"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      images: true,
      prefill: false,
      systemPrompt: false,
      stopSequences: true,
      streaming: true,
    },
    providerOptions: { reasoningEffort: "high" },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:gpt-4.1-2025-04-14",
    aliases: ["openai:gpt-4.1", "gpt-4.1"],
    capabilities: {
      contextWindow: 1_047_575,
      maxOutputTokens: 32_767,
      images: true,
      prefill: false,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:gpt-4.1-mini-2025-04-14",
    aliases: ["openai:gpt-4.1-mini", "gpt-4.1-mini"],
    capabilities: {
      contextWindow: 1_047_575,
      maxOutputTokens: 32_767,
      images: true,
      prefill: false,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:gpt-4.1-nano-2025-04-14", // gpt-4.1-2025-04-14
    aliases: ["openai:gpt-4.1-nano", "gpt-4.1-nano"],
    capabilities: {
      contextWindow: 1_047_575,
      maxOutputTokens: 32_767,
      images: true,
      prefill: false,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });
}

if (env.CTTS_AI_LLM_GOOGLE_APPLICATION_CREDENTIALS) {
  const credentials = JSON.parse(
    Deno.readTextFileSync(env.CTTS_AI_LLM_GOOGLE_APPLICATION_CREDENTIALS),
  );

  const vertexProvider = createVertex({
    googleAuthOptions: {
      credentials: credentials as any,
    },
    project: env.CTTS_AI_LLM_GOOGLE_VERTEX_PROJECT,
    location: env.CTTS_AI_LLM_GOOGLE_VERTEX_LOCATION,
  });

  addModel({
    provider: vertexProvider,
    name: "google:gemini-2.5-pro-exp-03-25",
    aliases: ["google:gemini-2.5-pro", "gemini-2.5-pro"],
    capabilities: {
      contextWindow: 1_048_576,
      maxOutputTokens: 65_535,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });

  addModel({
    provider: vertexProvider,
    name: "google:gemini-2.0-flash-001",
    aliases: ["google:gemini-2.0-flash", "gemini-2.0-flash"],
    capabilities: {
      contextWindow: 1_048_576,
      maxOutputTokens: 8_191,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });

  addModel({
    provider: vertexProvider,
    name: "google:gemini-2.0-flash-lite",
    aliases: ["google:gemini-2.0-flash-lite-001", "gemini-2.0-flash-lite"],
    capabilities: {
      contextWindow: 1_048_575,
      maxOutputTokens: 8_191,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });
}

if (env.CTTS_AI_LLM_PERPLEXITY_API_KEY) {
  const perplexityProvider = createOpenAI({
    name: "perplexity",
    apiKey: env.CTTS_AI_LLM_PERPLEXITY_API_KEY,
    baseURL: "https://api.perplexity.ai/",
  });

  addModel({
    provider: perplexityProvider,
    name: "perplexity:sonar-reasoning-pro",
    aliases: ["sonar-reasoning-pro"],
    capabilities: {
      contextWindow: 127_000,
      maxOutputTokens: 8000,
      images: false,
      prefill: false,
      systemPrompt: false,
      stopSequences: true,
      streaming: true,
    },
  });

  addModel({
    provider: perplexityProvider,
    name: "perplexity:sonar-pro",
    aliases: ["sonar-pro"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 8000,
      images: false,
      prefill: false,
      systemPrompt: false,
      stopSequences: true,
      streaming: true,
    },
  });
}

export const findModel = (name: string) => {
  return MODELS[name];
};
