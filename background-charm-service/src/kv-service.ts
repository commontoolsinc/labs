import { Integration } from "./types.ts";
import { JobQueue } from "./job-queue.ts";
import { KVStateManager } from "./kv-state-manager.ts";
import { 
  JobType, 
  KV_PREFIXES, 
  KVServiceOptions 
} from "./kv-types.ts";
import { loadIntegrations } from "./integrations/index.ts";
import { log } from "./utils.ts";

/**
 * Background Charm Service using Deno KV and job queues
 */
export class KVBackgroundCharmService {
  private kv: Deno.Kv;
  private queue: JobQueue;
  private stateManager: KVStateManager;
  private integrations: Map<string, Integration>;
  private cycleIntervalMs: number;
  private cycleTimer: number | null = null;
  private isRunning = false;
  private globalErrorHandlerInstalled = false;
  
  constructor(options: KVServiceOptions) {
    this.kv = options.kv;
    this.queue = new JobQueue(this.kv, {
      maxConcurrentJobs: options.maxConcurrentJobs,
      maxRetries: options.maxRetries
    });
    this.stateManager = new KVStateManager(this.kv, options.logIntervalMs);
    this.integrations = new Map();
    this.cycleIntervalMs = options.cycleIntervalMs ?? 60_000; // Default 1 minute
    
    // Install global error handlers
    this.installGlobalErrorHandlers();
    
    log("KV Background Charm Service constructed");
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
        log(`Stack trace: ${event.reason.stack.split("\n").slice(0, 5).join("\n")}`);
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
    
    // Register integrations
    for (const integration of await loadIntegrations()) {
      await this.registerIntegration(integration);
    }
    
    log("KV Background Charm Service initialized");
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
      this.runCycle().catch(error => {
        log(`Error in cycle: ${error instanceof Error ? error.message : String(error)}`);
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
      // Queue a maintenance job for statistics
      await this.queue.addMaintenanceJob("stats", 10);
      
      // Queue a maintenance job for cleanup
      await this.queue.addMaintenanceJob("cleanup", 1);
      
      // Queue a maintenance job for resetting disabled charms
      await this.queue.addMaintenanceJob("reset", 2);
      
      // Queue scan jobs for each integration
      for (const [id, integration] of this.integrations.entries()) {
        await this.queue.addScanIntegrationJob(id, 5);
      }
      
      // Update cycle end time
      await this.stateManager.updateCycleStats(false);
      
      log("Cycle completed successfully");
    } catch (error) {
      log(`Error in cycle: ${error instanceof Error ? error.message : String(error)}`);
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