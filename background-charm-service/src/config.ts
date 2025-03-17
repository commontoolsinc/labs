/**
 * Centralized configuration for the Background Charm Service
 */

/**
 * Service configuration
 */
export interface ServiceConfig {
  // Job queue settings
  maxConcurrentJobs: number;
  maxRetries: number;
  pollingIntervalMs: number;

  // Execution settings
  cycleIntervalMs: number;
  logIntervalMs: number;

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

/**
 * Get configuration from environment variables with defaults
 */
export function getConfig(): ServiceConfig {
  return {
    // Job queue settings
    maxConcurrentJobs: getNumberEnv("MAX_CONCURRENT_JOBS", 5),
    maxRetries: getNumberEnv("MAX_RETRIES", 3),
    pollingIntervalMs: getNumberEnv("POLLING_INTERVAL_MS", 100),

    // Execution settings
    cycleIntervalMs: getNumberEnv("CYCLE_INTERVAL_MS", 60_000),
    logIntervalMs: getNumberEnv("LOG_INTERVAL_MS", 300_000),

    // Timeouts
    charmExecutionTimeoutMs: getNumberEnv("CHARM_EXECUTION_TIMEOUT_MS", 30_000),
    tokenRefreshTimeoutMs: getNumberEnv("TOKEN_REFRESH_TIMEOUT_MS", 10_000),
    scanIntegrationTimeoutMs: getNumberEnv(
      "SCAN_INTEGRATION_TIMEOUT_MS",
      20_000,
    ),
    maintenanceJobTimeoutMs: getNumberEnv("MAINTENANCE_JOB_TIMEOUT_MS", 60_000),

    // External service URLs
    toolshedUrl: getStringEnv(
      "TOOLSHED_API_URL",
      "https://toolshed.saga-castor.ts.net/",
    ),

    // Authentication
    operatorPass: getStringEnv("OPERATOR_PASS", "implicit trust"),
  };
}

/**
 * Override configuration with command line arguments
 */
export function mergeConfigWithArgs(
  config: ServiceConfig,
  args: Record<string, unknown>,
): ServiceConfig {
  return {
    ...config,
    maxConcurrentJobs: getNumberArg(
      args,
      "max-concurrent",
      config.maxConcurrentJobs,
    ),
    cycleIntervalMs:
      getNumberArg(args, "interval", config.cycleIntervalMs / 1000) * 1000,
    logIntervalMs:
      getNumberArg(args, "log-interval", config.logIntervalMs / 1000) * 1000,
    maxRetries: getNumberArg(args, "max-retries", config.maxRetries),
  };
}

/**
 * Helper to get a string environment variable with default
 */
function getStringEnv(name: string, defaultValue: string): string {
  return Deno.env.get(name) ?? defaultValue;
}

/**
 * Helper to get a number environment variable with default
 */
function getNumberEnv(name: string, defaultValue: number): number {
  const value = Deno.env.get(name);
  if (value === undefined) return defaultValue;

  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Helper to get a number argument with default
 */
function getNumberArg(
  args: Record<string, unknown>,
  name: string,
  defaultValue: number,
): number {
  const value = args[name];
  if (value === undefined) return defaultValue;

  // Handle string and number values
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  return defaultValue;
}
