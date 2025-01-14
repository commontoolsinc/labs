import { z } from "zod";

// NOTE: This is where we define the environment variable types and defaults.
const EnvSchema = z.object({
  ENV: z.string().default("development"),
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

  // LLM API Keys
  CTTS_AI_LLM_ANTHROPIC_API_KEY: z.string().default(""),
  CTTS_AI_LLM_GROQ_API_KEY: z.string().default(""),
  CTTS_AI_LLM_OPENAI_API_KEY: z.string().default(""),
  CTTS_AI_LLM_VERTEX_API_KEY: z.string().default(""),
  CTTS_AI_LLM_CEREBRAS_API_KEY: z.string().default(""),
  CTTS_AI_LLM_PERPLEXITY_API_KEY: z.string().default(""),
  CTTS_AI_LLM_AWS_ACCESS_KEY_ID: z.string().default(""),
  CTTS_AI_LLM_AWS_SECRET_ACCESS_KEY: z.string().default(""),
});

export type env = z.infer<typeof EnvSchema>;

const { data: env, error } = EnvSchema.safeParse(Deno.env.toObject());

if (error) {
  console.error("❌ Invalid env:");
  console.error(JSON.stringify(error.flatten().fieldErrors, null, 2));
  Deno.exit(1);
}

export default env!;
