import {
  Integration,
  IntegrationCellConfig,
  JobType,
  KV_PREFIXES,
  KVServiceOptions,
} from "./types.ts";
import { JobQueue } from "./job-queue.ts";
import { StateManager } from "./state-manager.ts";
import {
  getAvailableIntegrations,
  loadIntegrations,
} from "./integrations/index.ts";
import { log } from "./utils.ts";
import { env, getConfig } from "./config.ts";
import {
  formatError,
  formatUptime,
  getSharedWorkerPool,
} from "./utils/common.ts";
import { IntegrationError } from "./errors/index.ts";
import { WorkerPool } from "./utils/worker-pool.ts";

/**
 * Background Charm Service using Deno KV and job queues
 */
export class BackgroundCharmService {
  private kv: Deno.Kv;
  private queue: JobQueue;
  private stateManager: StateManager;
  private integrations: Map<string, Integration>;
  private cycleIntervalMs: number;
  private cycleTimer: number | null = null;
  private isRunning = false;
  private globalErrorHandlerInstalled = false;
  private maxConsecutiveFailures: number;
  private config: ReturnType<typeof getConfig>;
  private workerPool: WorkerPool<any, any> | null = null;

  constructor(options: KVServiceOptions) {
    this.kv = options.kv;
    this.config = getConfig();

    // Apply options, using env values as fallbacks
    this.queue = new JobQueue(this.kv, {
      maxConcurrentJobs: options.maxConcurrentJobs ?? env.MAX_CONCURRENT_JOBS,
      maxRetries: options.maxRetries ?? env.MAX_RETRIES,
      pollingIntervalMs: env.POLLING_INTERVAL_MS,
    });

    this.stateManager = new StateManager(
      this.kv,
      options.logIntervalMs ?? env.LOG_INTERVAL_MS,
    );
    this.integrations = new Map();
    this.cycleIntervalMs = options.cycleIntervalMs ?? env.CYCLE_INTERVAL_MS;
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ??
      env.MAX_CONSECUTIVE_FAILURES;

    // Initialize the shared worker pool
    this.initializeWorkerPool();

    // Install global error handlers
    this.installGlobalErrorHandlers();

    log("Background Charm Service constructed");
    log(
      `Configuration: cycleInterval=${this.cycleIntervalMs}ms, maxConcurrentJobs=${
        options.maxConcurrentJobs ?? env.MAX_CONCURRENT_JOBS
      }`,
    );
  }

  /**
   * Initialize the shared worker pool
   */
  private initializeWorkerPool(): void {
    // Create the charm worker URL
    const workerUrl = new URL("./utils/charm-worker.ts", import.meta.url).href;

    // Initialize the shared worker pool
    this.workerPool = getSharedWorkerPool({
      maxWorkers: this.config.maxConcurrentJobs,
      workerUrl,
      workerOptions: {
        type: "module",
        deno: {
          permissions: {
            read: true,
            write: true,
            net: true,
            env: true,
          },
        },
      },
    });
  }

  /**
   * Install global error handlers
   */
  private installGlobalErrorHandlers(): void {
    if (this.globalErrorHandlerInstalled) return;

    // Handle unhandled promise rejections
    self.addEventListener("unhandledrejection", (event) => {
      const errorMessage = event.reason instanceof Error
        ? event.reason.message
        : String(event.reason);

      log(`⚠️ Caught unhandled promise rejection: ${errorMessage}`);

      if (event.reason instanceof Error && event.reason.stack) {
        log(
          `Stack trace: ${
            event.reason.stack.split("\n").slice(0, 5).join("\n")
          }`,
        );
      } else {
        log(`Full rejection data: ${JSON.stringify(event.reason, null, 2)}`);
      }

      event.preventDefault();
    });

    // Handle uncaught exceptions
    self.addEventListener("error", (event) => {
      log(`⚠️ Caught uncaught exception: ${event.message}`);
      log(`Location: ${event.filename}:${event.lineno}:${event.colno}`);

      event.preventDefault();
    });

    this.globalErrorHandlerInstalled = true;
    log("Global error handlers installed");
  }

  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    // Initialize KV schema
    await this.stateManager.initialize();

    // Load integrations
    await loadIntegrations();

    // Register all available integrations
    for (const integration of getAvailableIntegrations()) {
      await this.registerIntegration(integration);
    }

    log("Background Charm Service initialized");
  }

  /**
   * Register an integration
   */
  private async registerIntegration(integration: Integration): Promise<void> {
    this.integrations.set(integration.id, integration);

    // Store integration config in KV
    const config = integration.getIntegrationConfig();
    await this.stateManager.setIntegrationConfig(integration.id, config);

    // Initialize integration
    await integration.initialize();

    log(`Registered integration: ${integration.id}`);
  }

  /**
   * Register a manual integration (from CLI charms list)
   */
  async registerManualIntegration(
    config: IntegrationCellConfig,
  ): Promise<void> {
    if (!config) {
      throw new IntegrationError("Invalid manual integration config", "manual");
    }

    // Store in KV
    await this.stateManager.setIntegrationConfig("manual", config);

    // Create a simple integration object to add to the map
    const manualIntegration: Integration = {
      id: "manual",
      name: "Manual Charms",

      initialize(): void {
        // No initialization needed
        log("Manual integration initialized");
      },

      getIntegrationConfig(): IntegrationCellConfig {
        return config;
      },
    };

    // Add to integrations map
    this.integrations.set("manual", manualIntegration);

    log(`Registered manual integration with fetchCharms function`);
  }

  /**
   * Start the service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      log("Service is already running");
      return;
    }

    this.isRunning = true;

    // Start job consumer
    this.queue.startConsumer();

    // Run initial cycle
    await this.runCycle();

    // Schedule regular cycles
    this.cycleTimer = setInterval(() => {
      this.runCycle().catch((error) => {
        log(
          `Error in cycle: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, this.cycleIntervalMs) as unknown as number;

    log(`Service started, cycle interval: ${this.cycleIntervalMs}ms`);
  }

  /**
   * Stop the service
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      log("Service is not running");
      return;
    }

    // Clear interval
    if (this.cycleTimer !== null) {
      clearInterval(this.cycleTimer);
      this.cycleTimer = null;
    }

    // Stop consumer
    await this.queue.stopConsumer();

    // Stop state manager
    this.stateManager.stop();

    // Get final worker pool stats
    if (this.workerPool) {
      this.workerPool.reportWorkerStats();
      await this.workerPool.shutdown();
      log("Worker pool shutdown complete");
    }

    this.isRunning = false;

    // Log final state
    await this.stateManager.logState();

    log("Service stopped");
  }

  /**
   * Run a cycle
   */
  private async runCycle(): Promise<void> {
    // Update cycle start time
    await this.stateManager.updateCycleStats(true);
    log("Starting cycle");

    try {
      // Queue a maintenance job for statistics (lowest priority)
      await this.queue.addMaintenanceJob("stats", 1);

      // Queue a maintenance job for cleanup (low priority)
      await this.queue.addMaintenanceJob("cleanup", 2);

      // Queue a maintenance job for resetting disabled charms (medium-low priority)
      await this.queue.addMaintenanceJob("reset", 3);

      // Queue scan jobs for each integration (medium-high priority)
      for (const [id, integration] of this.integrations.entries()) {
        // Scan integrations have medium-high priority (5)
        await this.queue.addScanIntegrationJob(id, 5);
      }

      // Update cycle end time
      await this.stateManager.updateCycleStats(false);

      log("Cycle completed successfully");
    } catch (error) {
      log(
        `Error in cycle: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Still update the cycle end even on error
      await this.stateManager.updateCycleStats(false);
    }
  }

  /**
   * Get service status
   */
  async getStatus(): Promise<{
    running: boolean;
    integrations: string[];
    queueStatus: {
      running: boolean;
      activeJobs: number;
      activeJobIds: string[];
    };
    serviceState: unknown;
  }> {
    const serviceState = await this.stateManager.getServiceState();

    return {
      running: this.isRunning,
      integrations: Array.from(this.integrations.keys()),
      queueStatus: this.queue.getStatus(),
      serviceState,
    };
  }

  /**
   * Initialize an integration
   */
  async initializeIntegration(integrationId: string): Promise<void> {
    const integration = this.integrations.get(integrationId);
    if (!integration) {
      throw new Error(`Integration not found: ${integrationId}`);
    }

    await integration.initialize();
    log(`Initialized integration: ${integrationId}`);
  }
}
