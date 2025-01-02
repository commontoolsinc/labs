import { anthropic } from "npm:@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { groq } from "npm:@ai-sdk/groq";
import { openai } from "npm:@ai-sdk/openai";
import { vertex } from "npm:@ai-sdk/google-vertex";
import { ollama } from "ollama-ai-provider";
import { bedrock } from "npm:@ai-sdk/amazon-bedrock";
// ensure env is ready to be read
import { config } from "https://deno.land/x/dotenv/mod.ts";
await config({ export: true });

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
  model: any;
  capabilities: Capabilities;
};

export const MODELS: Record<string, ModelConfig> = {};
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
    | typeof bedrock;
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
    model,
    capabilities,
  };

  MODELS[name] = config;
  for (const alias of aliases) {
    MODELS[alias] = config;
    ALIAS_NAMES.push(alias);
  }
  PROVIDER_NAMES.add(name.split(":")[0]);
};

if (Deno.env.get("ANTHROPIC_API_KEY")) {
  addModel({
    provider: anthropic,
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
    provider: anthropic,
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
    provider: anthropic,
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

if (Deno.env.get("GROQ_API_KEY")) {
  addModel({
    provider: groq,
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
    provider: groq,
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
    provider: groq,
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

if (Deno.env.get("OPENAI_API_KEY")) {
  addModel({
    provider: openai,
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
    provider: openai,
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
    provider: openai,
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
    provider: openai,
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

if (Deno.env.get("OLLAMA_API_MODEL")) {
  // NOTE: Ollama supports many models, so we leave the capabilities all true.
  addModel({
    provider: ollama,
    name: `ollama:${Deno.env.get("OLLAMA_API_MODEL")}`,
    aliases: [`ollama`],
    capabilities: {
      contextWindow: 128_000,
      maxOutputTokens: 8000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });
}

if (
  Deno.env.get("GOOGLE_API_KEY") ||
  Deno.env.get("GOOGLE_APPLICATION_CREDENTIALS")
) {
  addModel({
    provider: vertex,
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
    provider: vertex,
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
    provider: vertex,
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
    provider: vertex,
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

if (Deno.env.get("CEREBRAS_API_KEY")) {
  const cerebras = createOpenAI({
    name: "cerebras",
    apiKey: Deno.env.get("CEREBRAS_API_KEY"),
    baseURL: "https://api.cerebras.ai/v1",
  });
  addModel({
    provider: cerebras,
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

if (Deno.env.get("PERPLEXITY_API_KEY")) {
  const perplexity = createOpenAI({
    name: "perplexity",
    apiKey: Deno.env.get("PERPLEXITY_API_KEY"),
    baseURL: "https://api.perplexity.ai/",
  });

  addModel({
    provider: perplexity,
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
    provider: perplexity,
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
    provider: perplexity,
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

if (
  Deno.env.get("AWS_ACCESS_KEY_ID") &&
  Deno.env.get("AWS_SECRET_ACCESS_KEY")
) {
  addModel({
    provider: bedrock,
    name: "us.amazon.nova-micro-v1:0",
    aliases: ["amazon:nova-micro", "nova-micro"],
    capabilities: {
      contextWindow: 128_000,
      maxOutputTokens: 5000,
      images: false,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });

  addModel({
    provider: bedrock,
    name: "us.amazon.nova-lite-v1:0",
    aliases: ["amazon:nova-lite", "nova-lite"],
    capabilities: {
      contextWindow: 300_000,
      maxOutputTokens: 5000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });

  addModel({
    provider: bedrock,
    name: "us.amazon.nova-pro-v1:0",
    aliases: ["amazon:nova-pro", "nova-pro"],
    capabilities: {
      contextWindow: 300_000,
      maxOutputTokens: 5000,
      images: true,
      prefill: true,
      systemPrompt: true,
      stopSequences: true,
      streaming: true,
    },
  });
}

export const findModel = (name: string) => {
  return MODELS[name];
};
