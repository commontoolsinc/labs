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
  // EXPERIMENTAL_* feature flags are no longer declared here: the runtime
  // construction site reads them through the canonical mapping
  // (`experimentalOptionsFromEnv` / EXPERIMENTAL_ENV_VARS in
  // @commonfabric/runner runtime-presets), shared with toolshed and the CLI
  // so the wirings cannot drift (CT-1814).

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
