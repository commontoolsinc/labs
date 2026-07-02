import { z } from "zod";

/**
 * Results in `true` (on), `false` (off), or `undefined` (default).
 */
function flagValue() {
  return z.string().default("default").transform((v) => {
    switch (v) {
      case "default":
        return undefined;
      case "false":
        return false;
      default:
        return true;
    }
  });
}

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
  //PIECE_EXECUTION_TIMEOUT_MS: z.coerce.number().positive().default(30_000),

  // Identity
  OPERATOR_PASS: z.string().default("implicit trust"),
  // Path to the identity keyfile that the service
  // runs as.
  IDENTITY: z.string().optional(),
  // Toolshed configuration
  API_URL: z.string().default("http://localhost:8000"),

  // OpenTelemetry. When OTEL_ENABLED=true, spans are exported to the local OTel
  // Collector at OTEL_EXPORTER_OTLP_ENDPOINT, which forwards them to SigNoz.
  ENV: z.string().default("development"),
  // NOT z.coerce.boolean(): Boolean("false") === true, so OTEL_ENABLED=false would
  // wrongly enable telemetry (the same latent bug this file documents elsewhere).
  OTEL_ENABLED: z.string().default("false").transform((v) =>
    v === "true" || v === "1"
  ),
  OTEL_SERVICE_NAME: z.string().default("bg-piece-service"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default("http://localhost:4318"),

  // Experimental feature flags. See `ExperimentalOptions` in `runner`.
  // Note: We intentionally avoid `z.coerce.boolean()` here. Zod's coerce uses
  // `Boolean()`, which treats any non-empty string as truthy -- so setting an
  // env var to the string `"false"` would incorrectly enable the flag. The
  // other boolean env vars in this file have the same latent bug.
  EXPERIMENTAL_MODERN_CELL_REP: flagValue(),
  EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE: flagValue(),
  // Background Piece Service: default is public space "toolshed-system"
  //SERVICE_DID: z.string().default(
  //  "did:key:z6Mkfuw7h6jDwqVb6wimYGys14JFcyTem4Kqvdj9DjpFhY88",
  //),
});

export type EnvVars = z.infer<typeof envSchema>;

export function loadEnv(
  source: (key: string) => string | undefined = (key) => Deno.env.get(key),
): EnvVars {
  const rawEnv: Record<string, string | undefined> = {};

  for (const key of Object.keys(envSchema.shape)) {
    rawEnv[key] = source(key);
  }

  return envSchema.parse(rawEnv);
}

export const env = loadEnv();
