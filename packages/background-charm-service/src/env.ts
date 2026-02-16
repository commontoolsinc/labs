import { z } from "zod";

const envSchema = z.object({
  // Job queue settings
  //MAX_CONCURRENT_JOBS: z.coerce.number().positive().default(5),
  //MAX_RETRIES: z.coerce.number().nonnegative().default(3),
  //POLLING_INTERVAL_MS: z.coerce.number().positive().default(100),

  // Execution settings
  //CYCLE_INTERVAL_MS: z.coerce.number().positive().default(60_000),
  //LOG_INTERVAL_MS: z.coerce.number().positive().default(300_000),
  //MAX_CONSECUTIVE_FAILURES: z.coerce.number().positive().default(5),

  // Timeouts (in milliseconds)
  //CHARM_EXECUTION_TIMEOUT_MS: z.coerce.number().positive().default(30_000),

  // Identity
  OPERATOR_PASS: z.string().default("implicit trust"),
  // Path to the identity keyfile that the service
  // runs as.
  IDENTITY: z.string().optional(),
  // Toolshed configuration
  API_URL: z.string().default("http://localhost:8000"),

  // Experimental space-model feature flags (see ExperimentalOptions in runner)
  // Note: We intentionally avoid z.coerce.boolean() here. Zod's coerce uses
  // Boolean(), which treats any non-empty string as truthy -- so setting an
  // env var to "false" would incorrectly enable the flag. The other boolean
  // env vars in this file have the same latent bug.
  EXPERIMENTAL_RICH_STORABLE_VALUES: z.string().default("false").transform((
    v,
  ) => v === "true"),
  EXPERIMENTAL_STORABLE_PROTOCOL: z.string().default("false").transform((
    v,
  ) => v === "true"),
  EXPERIMENTAL_UNIFIED_JSON_ENCODING: z.string().default("false").transform((
    v,
  ) => v === "true"),
  // Background Charm Service: default is public space "toolshed-system"
  //SERVICE_DID: z.string().default(
  //  "did:key:z6Mkfuw7h6jDwqVb6wimYGys14JFcyTem4Kqvdj9DjpFhY88",
  //),
});

export type EnvVars = z.infer<typeof envSchema>;

function loadEnv(): EnvVars {
  const rawEnv: Record<string, string | undefined> = {};

  for (const key of Object.keys(envSchema.shape)) {
    rawEnv[key] = Deno.env.get(key);
  }

  return envSchema.parse(rawEnv);
}

export const env = loadEnv();
