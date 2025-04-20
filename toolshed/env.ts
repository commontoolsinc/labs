import { z } from "zod";
import * as Path from "@std/path";

// NOTE: This is where we define the environment variable types and defaults.
const EnvSchema = z.object({
  ENV: z.string().default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().default(8000),
  LOG_LEVEL: z.enum([
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
  ]).default("info"),
  DISABLE_LOG_REQ_RES: z.coerce.boolean().default(false),
  CACHE_DIR: z.string().default("./cache"),

  // ===========================================================================
  // OpenTelemetry Configuration
  // ===========================================================================
  OTEL_ENABLED: z.coerce.boolean().default(true),
  OTEL_SERVICE_NAME: z.string().default("toolshed"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default("http://localhost:4318"),
  OTEL_TRACES_SAMPLER: z.string().default("always_on"),
  OTEL_TRACES_SAMPLER_ARG: z.string().default("1.0"),
  // ===========================================================================

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
  CTTS_AI_LLM_PHOENIX_API_URL: z.string().default(""),
  CTTS_AI_LLM_PHOENIX_API_KEY: z.string().default(""),
  // ===========================================================================

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
  //  - MEMORY_DIR is used by toolshed to access sqlite files for common-memory
  //  - MEMORY_URL is used by toolshed to connect to memory endpoint
  // ===========================================================================
  MEMORY_DIR: z.string().default(
    new URL(`./cache/memory/`, Path.toFileUrl(`${Deno.cwd()}/`)).href,
  ),
  MEMORY_URL: z.string().default("http://localhost:8000"),
  // ===========================================================================
  // Sentry DSN global middleware
  //   * /lib/create-app.ts
  // ===========================================================================
  SENTRY_DSN: z.string().default(""),
  // ===========================================================================

  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),

  // URL of the toolshed API, for self-referring requests
  TOOLSHED_API_URL: z.string().default("http://localhost:8000"),

  // DEPRECATED: Identity signer passphrase for storage authentication
  IDENTITY_PASSPHRASE: z.string().default("implicit trust"),

  // Path to an identity key.
  IDENTITY: z.string().default(""),
});

export type env = z.infer<typeof EnvSchema>;

const { data: env, error } = EnvSchema.safeParse(Deno.env.toObject());

if (error) {
  console.error("❌ Invalid env:");
  console.error(JSON.stringify(error.flatten().fieldErrors, null, 2));
  Deno.exit(1);
}

export default env!;
