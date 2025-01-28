import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGroq, groq } from "@ai-sdk/groq";
import { openai } from "@ai-sdk/openai";
import { createVertex, vertex } from "@ai-sdk/google-vertex";
import { cerebras, createCerebras } from "@ai-sdk/cerebras";

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
  model: string;
  capabilities: Capabilities;
  aliases: string[];
};

export type ModelList = Record<
  string,
  ModelConfig
>;

export const MODELS: ModelList = {};
export const ALIAS_NAMES: string[] = [];
export const PROVIDER_NAMES: Set<string> = new Set();

export const TASK_MODELS = {
  coding: "anthropic:claude-3-5-sonnet-20241022", // Best for code
  json: "anthropic:claude-3-5-sonnet-20241022", // Fast & good at structured output
  creative: "openai:gpt-4o-2024-08-06", // Best for creative tasks
  vision: "google:gemini-1.5-pro-002", // Best for vision tasks
} as const;

export type TaskType = keyof typeof TASK_MODELS;

const addModel = ({
  provider,
  name,
  aliases,
  capabilities,
}: {
  provider:
    | typeof anthropic
    | typeof groq
    | typeof openai
    | typeof vertex
    | typeof cerebras;
  name: string;
  aliases: string[];
  capabilities: Capabilities;
}) => {
  let modelName = name.includes(":")
    ? name.split(":").slice(1).join(":")
    : name;

  // AWS includes colons in their model names, so we need to special case it.
  if (name.includes("us.amazon")) {
    modelName = name;
  }

  const model = provider(modelName);

  const config: ModelConfig = {
    model: (model as unknown) as string,
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
    name: "anthropic:claude-3-5-haiku-20241022",
    aliases: ["anthropic:claude-3-5-haiku-latest", "claude-3-5-haiku"],
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
    name: "anthropic:claude-3-opus-20240229",
    aliases: ["anthropic:claude-3-opus-latest", "claude-3-opus"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 4096,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
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

  addModel({
    provider: groqProvider,
    name: "groq:llama-3.2-90b-vision-preview",
    aliases: ["groq:llama-3.2-90b-vision", "llama-3.2-90b-vision"],
    capabilities: {
      contextWindow: 128_000,
      maxOutputTokens: 8000,
      images: true,
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
    name: "openai:gpt-4o-2024-08-06",
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
    name: "openai:gpt-4o-mini-2024-07-18",
    aliases: ["openai:gpt-4o-mini-latest", "openai:gpt-4o-mini", "gpt-4o-mini"],
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
    name: "openai:o1-preview-2024-09-12",
    aliases: ["openai:o1-preview-latest", "openai:o1-preview", "o1-preview"],
    capabilities: {
      contextWindow: 128_000,
      maxOutputTokens: 32768,
      images: false,
      prefill: false,
      systemPrompt: false,
      stopSequences: false,
      streaming: false,
    },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:o1-mini-2024-09-12",
    aliases: ["openai:o1-mini-latest", "openai:o1-mini", "o1-mini"],
    capabilities: {
      contextWindow: 128_000,
      maxOutputTokens: 65536,
      images: false,
      prefill: false,
      systemPrompt: false,
      stopSequences: false,
      streaming: false,
    },
  });
}

if (env.CTTS_AI_LLM_GOOGLE_APPLICATION_CREDENTIALS) {
  const vertexProvider = createVertex({
    googleAuthOptions: {
      credentials: env.CTTS_AI_LLM_GOOGLE_APPLICATION_CREDENTIALS as any, // bf: taming type errors
    },
    project: env.CTTS_AI_LLM_GOOGLE_VERTEX_PROJECT,
    location: env.CTTS_AI_LLM_GOOGLE_VERTEX_LOCATION,
  });
  addModel({
    provider: vertexProvider,
    name: "google:gemini-1.5-flash-002",
    aliases: ["google:gemini-1.5-flash", "gemini-1.5-flash"],
    capabilities: {
      contextWindow: 1_000_000,
      maxOutputTokens: 8192,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });
  addModel({
    provider: vertexProvider,
    name: "gemini-2.0-flash-exp",
    aliases: ["google:gemini-2.0-flash", "gemini-2.0-flash"],
    capabilities: {
      contextWindow: 1_048_576,
      maxOutputTokens: 8192,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });

  addModel({
    provider: vertexProvider,
    name: "google:gemini-1.5-pro-002",
    aliases: ["google:gemini-1.5-pro", "gemini-1.5-pro"],
    capabilities: {
      contextWindow: 1_000_000,
      maxOutputTokens: 8192,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });
  addModel({
    provider: vertexProvider,
    name: "google:gemini-exp-1206",
    aliases: ["google:gemini-exp-1206", "gemini-exp-1206"],
    capabilities: {
      contextWindow: 2_000_000,
      maxOutputTokens: 8192,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });
}

if (env.CTTS_AI_LLM_CEREBRAS_API_KEY) {
  const cerebrasProvider = createCerebras({
    apiKey: env.CTTS_AI_LLM_CEREBRAS_API_KEY,
  });
  addModel({
    provider: cerebrasProvider,
    name: "cerebras:llama-3.3-70b",
    aliases: ["cerebras"],
    capabilities: {
      contextWindow: 8192,
      maxOutputTokens: 8192,
      images: false,
      prefill: false,
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
    name: "perplexity:llama-3.1-sonar-large-128k-online",
    aliases: ["perplexity-lg"],
    capabilities: {
      contextWindow: 127_072,
      maxOutputTokens: 8192,
      images: false,
      prefill: false,
      systemPrompt: false,
      stopSequences: true,
      streaming: true,
    },
  });

  addModel({
    provider: perplexityProvider,
    name: "perplexity:llama-3.1-sonar-small-128k-online",
    aliases: ["perplexity-sm"],
    capabilities: {
      contextWindow: 127_072,
      maxOutputTokens: 8192,
      images: false,
      prefill: false,
      systemPrompt: false,
      stopSequences: true,
      streaming: true,
    },
  });

  addModel({
    provider: perplexityProvider,
    name: "perplexity:llama-3.1-sonar-huge-128k-online",
    aliases: ["perplexity-huge"],
    capabilities: {
      contextWindow: 127_072,
      maxOutputTokens: 8192,
      images: false,
      prefill: false,
      systemPrompt: false,
      stopSequences: true,
      streaming: true,
    },
  });
}

// FIXME(jake): There's some package import error with the bedrock provider. Commenting out for now.
// if (
//   env.CTTS_AI_LLM_AWS_ACCESS_KEY_ID &&
//   env.CTTS_AI_LLM_AWS_SECRET_ACCESS_KEY
// ) {
//   addModel({
//     provider: bedrock,
//     name: "us.amazon.nova-micro-v1:0",
//     aliases: ["amazon:nova-micro", "nova-micro"],
//     capabilities: {
//       contextWindow: 128_000,
//       maxOutputTokens: 5000,
//       images: false,
//       prefill: true,
//       systemPrompt: true,
//       stopSequences: true,
//       streaming: true,
//     },
//   });

//   addModel({
//     provider: bedrock,
//     name: "us.amazon.nova-lite-v1:0",
//     aliases: ["amazon:nova-lite", "nova-lite"],
//     capabilities: {
//       contextWindow: 300_000,
//       maxOutputTokens: 5000,
//       images: true,
//       prefill: true,
//       systemPrompt: true,
//       stopSequences: true,
//       streaming: true,
//     },
//   });

//   addModel({
//     provider: bedrock,
//     name: "us.amazon.nova-pro-v1:0",
//     aliases: ["amazon:nova-pro", "nova-pro"],
//     capabilities: {
//       contextWindow: 300_000,
//       maxOutputTokens: 5000,
//       images: true,
//       prefill: true,
//       systemPrompt: true,
//       stopSequences: true,
//       streaming: true,
//     },
//   });
// }

export const findModel = (name: string) => {
  return MODELS[name];
};
