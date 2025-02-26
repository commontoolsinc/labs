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

export type ModelList = Record<string, ModelConfig>;

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
  providerOptions,
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
    model: model as unknown as string,
    capabilities,
    aliases,
  };
  console.log("#############################");
  console.log(config);
  console.log("#############################");

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
    name: "openai:o1",
    aliases: ["openai:o1-low", "o1-low"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      images: false,
      prefill: false,
      systemPrompt: false,
      stopSequences: false,
      streaming: true,
    },
    providerOptions: {
      reasoningEffort: "low",
    },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:o1",
    aliases: ["openai:o1-medium", "o1-medium"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      images: false,
      prefill: false,
      systemPrompt: false,
      stopSequences: false,
      streaming: true,
    },
    providerOptions: {
      reasoningEffort: "medium",
    },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:o1",
    aliases: ["openai:o1-high", "o1-high"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      images: false,
      prefill: false,
      systemPrompt: false,
      stopSequences: false,
      streaming: true,
    },
    providerOptions: {
      reasoningEffort: "high",
    },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:o3-mini",
    aliases: ["openai:o3-mini-low-latest", "o3-mini-low"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      images: false,
      prefill: false,
      systemPrompt: false,
      stopSequences: false,
      streaming: true,
    },
    providerOptions: {
      reasoningEffort: "low",
    },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:o3-mini",
    aliases: ["openai:o3-mini-medium-latest", "o3-mini-medium"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      images: false,
      prefill: false,
      systemPrompt: false,
      stopSequences: false,
      streaming: true,
    },
    providerOptions: {
      reasoningEffort: "medium",
    },
  });

  addModel({
    provider: openAIProvider,
    name: "openai:o3-mini",
    aliases: ["openai:o3-mini-high-latest", "o3-mini-high"],
    capabilities: {
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      images: false,
      prefill: false,
      systemPrompt: false,
      stopSequences: false,
      streaming: true,
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

  const vertexProvider = createVertex({
    googleAuthOptions: {
      credentials: credentials as any,
    },
    project: env.CTTS_AI_LLM_GOOGLE_VERTEX_PROJECT,
    location: env.CTTS_AI_LLM_GOOGLE_VERTEX_LOCATION,
  });

  addModel({
    provider: vertexProvider,
    name: "google:gemini-2.0-flash",
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
    name: "google:gemini-2.0-flash-lite-preview-02-05",
    aliases: ["google:gemini-2.0-flash-lite", "gemini-2.0-flash-lite"],
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
    name: "google:gemini-2.0-flash-thinking-exp-01-21",
    aliases: ["google:gemini-2.0-flash-thinking", "gemini-2.0-flash-thinking"],
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
    name: "google:gemini-2.0-pro-exp-02-05",
    aliases: ["google:gemini-2.0-pro", "gemini-2.0-pro"],
    capabilities: {
      contextWindow: 2_097_152,
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

  addModel({
    provider: perplexityProvider,
    name: "perplexity:sonar",
    aliases: ["sonar"],
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
