import { JobHandler } from "./base-handler.ts";
import { Job, JobType, ScanIntegrationJob } from "../kv-types.ts";
import { KVStateManager } from "../kv-state-manager.ts";
import { JobQueue } from "../job-queue.ts";
import { log } from "../utils.ts";
import { getIntegration } from "../integrations/index.ts";

/**
 * Handler for scan integration jobs
 */
export class ScanIntegrationHandler implements JobHandler {
  private kv: Deno.Kv;
  private stateManager: KVStateManager;
  
  constructor(kv: Deno.Kv) {
    this.kv = kv;
    this.stateManager = new KVStateManager(kv);
  }
  
  /**
   * Handle a scan integration job
   */
  async handle(job: Job): Promise<unknown> {
    if (job.type !== JobType.SCAN_INTEGRATION) {
      throw new Error(`Invalid job type: ${job.type}`);
    }
    
    const scanJob = job as ScanIntegrationJob;
    const { integrationId } = scanJob;
    
    log(`Scanning integration: ${integrationId}`);
    
    // Get the integration
    const integration = getIntegration(integrationId);
    if (!integration) {
      throw new Error(`Integration not found: ${integrationId}`);
    }
    
    // Get the integration config
    const config = integration.getIntegrationConfig();
    
    // Fetch charms
    log(`Fetching charms for integration: ${integrationId}`);
    const charms = await config.fetchCharms();
    log(`Found ${charms.length} charms for integration: ${integrationId}`);
    
    // Create a job queue to add execute jobs
    const jobQueue = new JobQueue(this.kv);
    
    // Queue execution jobs for each charm
    const queuedJobs: string[] = [];
    for (const { space, charmId } of charms) {
      // Check if charm is disabled
      const isDisabled = await this.stateManager.isCharmDisabled(space, charmId, integrationId);
      if (isDisabled) {
        log(`Skipping disabled charm: ${space}/${charmId}`);
        continue;
      }
      
      // Queue execution job
      const jobId = await jobQueue.addExecuteCharmJob(
        integrationId,
        space,
        charmId
      );
      
      queuedJobs.push(jobId);
    }
    
    return {
      integrationId,
      charmsFound: charms.length,
      charmsQueued: queuedJobs.length,
      queuedJobIds: queuedJobs,
    };
  }
}