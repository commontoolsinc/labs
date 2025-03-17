/**
 * Centralized configuration for the Background Charm Service
 * Using Zod for schema validation
 */
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

/**
 * Environment variables schema using Zod
 */
const envSchema = z.object({
  // Job queue settings
  MAX_CONCURRENT_JOBS: z.coerce.number().positive().default(5),
  MAX_RETRIES: z.coerce.number().nonnegative().default(3),
  POLLING_INTERVAL_MS: z.coerce.number().positive().default(100),

  // Execution settings
  CYCLE_INTERVAL_MS: z.coerce.number().positive().default(60_000),
  LOG_INTERVAL_MS: z.coerce.number().positive().default(300_000),
  MAX_CONSECUTIVE_FAILURES: z.coerce.number().positive().default(5),

  // Timeouts (in milliseconds)
  CHARM_EXECUTION_TIMEOUT_MS: z.coerce.number().positive().default(30_000),
  TOKEN_REFRESH_TIMEOUT_MS: z.coerce.number().positive().default(10_000),
  SCAN_INTEGRATION_TIMEOUT_MS: z.coerce.number().positive().default(20_000),
  MAINTENANCE_JOB_TIMEOUT_MS: z.coerce.number().positive().default(60_000),

  // External service URLs
  TOOLSHED_API_URL: z.string().default("https://toolshed.saga-castor.ts.net/"),

  // Authentication
  OPERATOR_PASS: z.string().default("implicit trust"),
});

/**
 * Command-line arguments schema using Zod
 */
const argsSchema = z.object({
  "max-concurrent": z.union([z.string(), z.number()]).optional(),
  "interval": z.union([z.string(), z.number()]).optional(),
  "log-interval": z.union([z.string(), z.number()]).optional(),
  "max-retries": z.union([z.string(), z.number()]).optional(),
  "failures": z.union([z.string(), z.number()]).optional(),
}).passthrough(); // Allow other unspecified args

/**
 * Validated environment variable type
 */
export type EnvVars = z.infer<typeof envSchema>;

/**
 * Load and validate environment variables
 */
function loadEnv(): EnvVars {
  // Create an object with all env vars
  const rawEnv: Record<string, string | undefined> = {};

  // Add all defined environment variables
  for (const key of Object.keys(envSchema.shape)) {
    rawEnv[key] = Deno.env.get(key);
  }

  // Parse and validate with schema
  return envSchema.parse(rawEnv);
}

/**
 * Parse command line arguments
 */
function parseArgs(args: Record<string, unknown>): z.infer<typeof argsSchema> {
  return argsSchema.parse(args);
}

/**
 * Service configuration type
 */
export interface ServiceConfig {
  // Job queue settings
  maxConcurrentJobs: number;
  maxRetries: number;
  pollingIntervalMs: number;

  // Execution settings
  cycleIntervalMs: number;
  logIntervalMs: number;
  maxConsecutiveFailures: number;

  // Timeouts (in milliseconds)
  charmExecutionTimeoutMs: number;
  tokenRefreshTimeoutMs: number;
  scanIntegrationTimeoutMs: number;
  maintenanceJobTimeoutMs: number;

  // External service URLs
  toolshedUrl: string;

  // Authentication
  operatorPass: string;
}

// Singleton for the validated environment - export as `env` for direct access
export const env = loadEnv();

/**
 * Get configuration from environment variables with defaults
 */
export function getConfig(): ServiceConfig {
  return {
    // Job queue settings
    maxConcurrentJobs: env.MAX_CONCURRENT_JOBS,
    maxRetries: env.MAX_RETRIES,
    pollingIntervalMs: env.POLLING_INTERVAL_MS,

    // Execution settings
    cycleIntervalMs: env.CYCLE_INTERVAL_MS,
    logIntervalMs: env.LOG_INTERVAL_MS,
    maxConsecutiveFailures: env.MAX_CONSECUTIVE_FAILURES,

    // Timeouts
    charmExecutionTimeoutMs: env.CHARM_EXECUTION_TIMEOUT_MS,
    tokenRefreshTimeoutMs: env.TOKEN_REFRESH_TIMEOUT_MS,
    scanIntegrationTimeoutMs: env.SCAN_INTEGRATION_TIMEOUT_MS,
    maintenanceJobTimeoutMs: env.MAINTENANCE_JOB_TIMEOUT_MS,

    // External service URLs
    toolshedUrl: env.TOOLSHED_API_URL,

    // Authentication
    operatorPass: env.OPERATOR_PASS,
  };
}

/**
 * Override configuration with command line arguments
 */
export function mergeConfigWithArgs(
  config: ServiceConfig,
  args: Record<string, unknown>,
): ServiceConfig {
  // Parse and validate args
  const validatedArgs = parseArgs(args);

  // Helper function to parse a number value safely
  const parseArgNumber = (
    value: string | number | undefined,
    defaultValue: number,
  ): number => {
    if (value === undefined) return defaultValue;

    if (typeof value === "number") return value;

    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
  };

  // Return merged config
  return {
    ...config,
    maxConcurrentJobs: parseArgNumber(
      validatedArgs["max-concurrent"],
      config.maxConcurrentJobs,
    ),
    cycleIntervalMs:
      parseArgNumber(validatedArgs["interval"], config.cycleIntervalMs / 1000) *
      1000,
    logIntervalMs: parseArgNumber(
      validatedArgs["log-interval"],
      config.logIntervalMs / 1000,
    ) * 1000,
    maxRetries: parseArgNumber(validatedArgs["max-retries"], config.maxRetries),
    maxConsecutiveFailures: parseArgNumber(
      validatedArgs["failures"],
      config.maxConsecutiveFailures,
    ),
  };
}
