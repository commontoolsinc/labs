import { JobQueue } from "./job-queue.ts";
import { StateManager } from "./state-manager.ts";
import { log } from "./utils.ts";
import { env } from "./config.ts";
import { getSharedWorkerPool } from "./utils/common.ts";
import { WorkerPool } from "./utils/worker-pool.ts";
import { BGCharmEntry, getBGUpdaterCharmsCell } from "@commontools/utils";
import { storage } from "@commontools/runner";
import { Identity } from "@commontools/identity";
import { JobType } from "./types.ts";
import { MaintenanceHandler } from "./job-handlers/maintenance-handler.ts";
/**
 * Background Charm Service using Deno KV and job queues
 */
export class BackgroundCharmService {
  private kv: Deno.Kv;
  private queue: JobQueue;
  private stateManager: StateManager;
  private cycleTimer: number | null = null;
  private isRunning = false;
  private globalErrorHandlerInstalled = false;
  private workerPool: WorkerPool<any, any> | null = null;
  private charmsCell: any | null = null;

  constructor(kv: Deno.Kv) {
    this.kv = kv;

    // Apply options, using env values as fallbacks
    this.queue = new JobQueue(this.kv, {
      maxConcurrentJobs: env.MAX_CONCURRENT_JOBS,
      maxRetries: env.MAX_RETRIES,
      pollingIntervalMs: env.POLLING_INTERVAL_MS,
    });

    this.stateManager = new StateManager(
      this.kv,
      env.LOG_INTERVAL_MS,
    );

    // Initialize the shared worker pool
    this.initializeWorkerPool();
    
    // Connect worker pool to maintenance handler
    this.connectWorkerPool();

    // Install global error handlers
    this.installGlobalErrorHandlers();

    log("Background Charm Service constructed");
    log(` - cycleInterval=${env.CYCLE_INTERVAL_MS}ms`);
    log(` - maxConcurrentJobs=${env.MAX_CONCURRENT_JOBS}`);
    log(` - maxRetries=${env.MAX_RETRIES}`);
    log(` - pollingIntervalMs=${env.POLLING_INTERVAL_MS}`);
  }

  /**
   * Initialize the shared worker pool
   */
  private initializeWorkerPool(): void {
    // Create the charm worker URL
    const workerUrl = new URL("./utils/charm-worker.ts", import.meta.url).href;

    // Initialize the shared worker pool
    this.workerPool = getSharedWorkerPool({
      maxWorkers: env.MAX_CONCURRENT_JOBS,
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
   * Connect worker pool to maintenance handler
   */
  private connectWorkerPool(): void {
    if (!this.workerPool) {
      log("Warning: Worker pool not initialized, cannot connect to maintenance handler");
      return;
    }
    
    // Get the maintenance handler from the job queue
    const maintenanceHandler = this.queue.handlers?.[JobType.MAINTENANCE];
    if (maintenanceHandler && maintenanceHandler instanceof MaintenanceHandler) {
      maintenanceHandler.setWorkerPool(this.workerPool);
      log("Connected worker pool to maintenance handler");
    } else {
      log("Warning: Could not connect worker pool to maintenance handler");
    }
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
    storage.setRemoteStorage(new URL(env.MEMORY_URL));
    storage.setSigner(await Identity.fromPassphrase(env.OPERATOR_PASS));
    this.charmsCell = await getBGUpdaterCharmsCell();
    await storage.syncCell(this.charmsCell, true);
    await storage.synced();

    // Setup reactive callback for charm changes
    this.charmsCell.sink(async (bgCharms: BGCharmEntry[]) => {
      log(`Charm cell updated: ${bgCharms.length} charms`);
      
      let queued = 0;
      let skipped = 0;
      
      // Queue each non-disabled charm for execution when the cell changes
      for (const charm of bgCharms) {
        // Check if charm is disabled in state manager
        const isDisabled = await this.stateManager.isCharmDisabled(
          charm.space, 
          charm.charmId
        );
        
        if (isDisabled) {
          log(`Skipping disabled charm on update: ${charm.space}/${charm.charmId}`);
          skipped++;
          continue;
        }
        
        // Add to queue if not disabled
        this.queue.addExecuteCharmJob(charm);
        queued++;
      }
      
      log(`Cell update: queued ${queued} charms, skipped ${skipped} disabled charms`);
    });

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
    }, env.CYCLE_INTERVAL_MS) as unknown as number;

    log(`Service started, cycle interval: ${env.CYCLE_INTERVAL_MS}ms`);
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
      // Process charms from cell for periodic execution
      if (this.charmsCell) {
        const charms = (this.charmsCell.get() || []) as BGCharmEntry[];
        log(`Cycle: processing ${charms.length} charms from cell`);
        
        let queued = 0;
        let skipped = 0;

        for (const charm of charms) {
          // Check if charm is disabled in state manager
          const isDisabled = await this.stateManager.isCharmDisabled(
            charm.space, 
            charm.charmId
          );
          
          if (isDisabled) {
            log(`Skipping disabled charm: ${charm.space}/${charm.charmId}`);
            skipped++;
            continue;
          }
          
          // Add to queue if not disabled
          this.queue.addExecuteCharmJob(charm);
          queued++;
        }
        
        log(`Queued ${queued} charms, skipped ${skipped} disabled charms`);
      }

      // Queue a single maintenance job for all maintenance tasks (medium priority)
      await this.queue.addMaintenanceJob("all", 3);

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
      queueStatus: this.queue.getStatus(),
      serviceState,
    };
  }
}
