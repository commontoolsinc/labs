import { z } from "zod";
import * as Path from "jsr:@std/path";

// NOTE: This is where we define the environment variable types and defaults.
const EnvSchema = z.object({
  ENV: z.string().default("development"),
  PORT: z.coerce.number().default(8000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  CACHE_DIR: z.string().default("./cache"),

  // ===========================================================================
  // (/routes/ai/llm) Environment variables for LLM Providers
  // ===========================================================================
  CTTS_AI_LLM_ANTHROPIC_API_KEY: z.string().default(""),
  CTTS_AI_LLM_GROQ_API_KEY: z.string().default(""),
  CTTS_AI_LLM_OPENAI_API_KEY: z.string().default(""),
  CTTS_AI_LLM_CEREBRAS_API_KEY: z.string().default(""),
  CTTS_AI_LLM_PERPLEXITY_API_KEY: z.string().default(""),
  CTTS_AI_LLM_AWS_ACCESS_KEY_ID: z.string().default(""),
  CTTS_AI_LLM_AWS_SECRET_ACCESS_KEY: z.string().default(""),
  CTTS_AI_LLM_GOOGLE_APPLICATION_CREDENTIALS: z.string().default(""),
  CTTS_AI_LLM_GOOGLE_VERTEX_PROJECT: z.string().default(""),
  CTTS_AI_LLM_GOOGLE_VERTEX_LOCATION: z.string().default(""),

  // LLM Observability Tool
  CTTS_AI_LLM_PHOENIX_PROJECT: z.string().default(""),
  CTTS_AI_LLM_PHOENIX_URL: z.string().default(""),
  CTTS_AI_LLM_PHOENIX_API_KEY: z.string().default(""),
  // ===========================================================================

  // ===========================================================================
  // ElevenLabs API Key
  //   * /routes/ai/voice
  // ===========================================================================
  ELEVENLABS_API_KEY: z.string().default(""),

  // ===========================================================================
  // FAL AI API Key
  //   * /routes/ai/img
  //   * /routes/ai/voice
  // ===========================================================================
  FAL_API_KEY: z.string().default(""),
  // ===========================================================================

  // ===========================================================================
  // Jina API Key
  //   * /routes/ai/webreader
  // ===========================================================================
  JINA_API_KEY: z.string().default(""),
  // ===========================================================================
  //
  // ===========================================================================
  // Discord Webhook URL
  //   * /routes/integration/discord
  // ===========================================================================
  DISCORD_WEBHOOK_URL: z.string().default(""),
  // ===========================================================================
  //
  // ===========================================================================
  // Blobby Storage
  //   * /routes/storage/blobby
  // ===========================================================================
  BLOBBY_REDIS_URL: z.string().default("redis://localhost:6379"),
  // ===========================================================================
  // Memory Store
  MEMORY_URL: z.string().default(
    new URL(`./cache/memory/`, Path.toFileUrl(`${Deno.cwd()}/`)).href,
  ),
  // ===========================================================================
  // Sentry DSN global middleware
  //   * /lib/create-app.ts
  // ===========================================================================
  SENTRY_DSN: z.string().default(""),
  // ===========================================================================
});

export type env = z.infer<typeof EnvSchema>;

const { data: env, error } = EnvSchema.safeParse(Deno.env.toObject());

if (error) {
  console.error("❌ Invalid env:");
  console.error(JSON.stringify(error.flatten().fieldErrors, null, 2));
  Deno.exit(1);
}

export default env!;
