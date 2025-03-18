import { KVServiceOptions } from "./types.ts";
import { JobQueue } from "./job-queue.ts";
import { StateManager } from "./state-manager.ts";
import { log } from "./utils.ts";
import { env, getConfig } from "./config.ts";
import { getSharedWorkerPool } from "./utils/common.ts";
import { WorkerPool } from "./utils/worker-pool.ts";
import { BGCharmEntry, getBGUpdaterCharmsCell } from "@commontools/utils";
import { storage } from "@commontools/runner";

/**
 * Background Charm Service using Deno KV and job queues
 */
export class BackgroundCharmService {
  private kv: Deno.Kv;
  private queue: JobQueue;
  private stateManager: StateManager;
  private integrations: Set<string>;
  private cycleIntervalMs: number;
  private cycleTimer: number | null = null;
  private isRunning = false;
  private globalErrorHandlerInstalled = false;
  private maxConsecutiveFailures: number;
  private config: ReturnType<typeof getConfig>;
  private workerPool: WorkerPool<any, any> | null = null;
  private charmsCell: any | null = null;

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
    this.integrations = new Set<string>();
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

    // Initialize charms cell
    this.charmsCell = await getBGUpdaterCharmsCell();
    await storage.syncCell(this.charmsCell, true);
    await storage.synced();

    log("Background Charm Service initialized");
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
      // Check for new charms to watch
      if (this.charmsCell) {
        const charms = (this.charmsCell.get() || []) as BGCharmEntry[];
        log(`Found ${charms.length} charms to watch`);

        // add each charm to the service
        for (const charm of charms) {
          this.queue.addExecuteCharmJob(charm);
        }
      }

      // Queue a maintenance job for statistics (lowest priority)
      await this.queue.addMaintenanceJob("stats", 1);

      // Queue a maintenance job for cleanup (low priority)
      await this.queue.addMaintenanceJob("cleanup", 2);

      // Queue a maintenance job for resetting disabled charms (medium-low priority)
      await this.queue.addMaintenanceJob("reset", 3);

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
      integrations: Array.from(this.integrations),
      queueStatus: this.queue.getStatus(),
      serviceState,
    };
  }
}
