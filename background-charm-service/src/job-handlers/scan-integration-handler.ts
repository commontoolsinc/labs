import { JobHandler } from "./base-handler.ts";
import { Job, JobType, ScanIntegrationJob } from "../kv-types.ts";
import { KVStateManager } from "../kv-state-manager.ts";
import { JobQueue } from "../job-queue.ts";
import { log } from "../utils.ts";
import { getIntegration } from "../integrations/index.ts";
import type { DID } from "@commontools/identity";

/**
 * Handler for scan integration jobs
 */
export class ScanIntegrationHandler implements JobHandler {
  private kv: Deno.Kv;
  private stateManager: KVStateManager;
  private charmCache: Map<string, Array<{ space: DID; charmId: string }>> =
    new Map();
  private cacheTimestamp: Map<string, number> = new Map();
  private CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(kv: Deno.Kv) {
    this.kv = kv;
    this.stateManager = new KVStateManager(kv);
  }

  /**
   * Get cached charms for an integration
   */
  private getCachedCharms(
    integrationId: string,
  ): Array<{ space: DID; charmId: string }> | null {
    const charms = this.charmCache.get(integrationId);
    const timestamp = this.cacheTimestamp.get(integrationId);

    // Return null if no cache or cache expired
    if (!charms || !timestamp || Date.now() - timestamp > this.CACHE_TTL_MS) {
      return null;
    }

    return charms;
  }

  /**
   * Set cached charms for an integration
   */
  private setCachedCharms(
    integrationId: string,
    charms: Array<{ space: DID; charmId: string }>,
  ): void {
    this.charmCache.set(integrationId, charms);
    this.cacheTimestamp.set(integrationId, Date.now());
  }

  /**
   * Process charms and queue jobs
   */
  private async processCharms(
    charms: Array<{ space: DID; charmId: string }>,
    integrationId: string,
  ): Promise<unknown> {
    // Create a job queue to add execute jobs
    const jobQueue = new JobQueue(this.kv);

    // Queue execution jobs for each charm
    const queuedJobs: string[] = [];
    const disabledCharms: string[] = [];

    for (const { space, charmId } of charms) {
      // Check if charm is disabled
      const isDisabled = await this.stateManager.isCharmDisabled(
        space,
        charmId,
        integrationId,
      );
      if (isDisabled) {
        log(`Skipping disabled charm: ${space}/${charmId}`);
        disabledCharms.push(`${space}/${charmId}`);
        continue;
      }

      // Queue execution job with higher priority for reliability
      const jobId = await jobQueue.addExecuteCharmJob(
        integrationId,
        space,
        charmId,
        8, // Higher priority than maintenance jobs
      );

      queuedJobs.push(jobId);
    }

    // Log summary
    if (disabledCharms.length > 0) {
      log(
        `Skipped ${disabledCharms.length} disabled charm(s): ${
          disabledCharms.join(", ")
        }`,
      );
    }

    return {
      integrationId,
      charmsFound: charms.length,
      charmsQueued: queuedJobs.length,
      queuedJobIds: queuedJobs,
    };
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

    // Get the integration config (with functions)
    const config = integration.getIntegrationConfig();

    // Fetch charms with a strict timeout
    log(`Fetching charms for integration: ${integrationId}`);

    try {
      // Use Promise.race to add a strict timeout
      const fetchPromise = config.fetchCharms();
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`Fetch charms timeout for ${integrationId}`)),
          5000,
        );
      });

      // Use a cached result if available to prevent repeated timeouts
      const cachedCharms = this.getCachedCharms(integrationId);

      try {
        // Try to get fresh charms with timeout
        const charms = await Promise.race([fetchPromise, timeoutPromise]);
        log(`Found ${charms.length} charms for integration: ${integrationId}`);

        // Save successful result to cache
        this.setCachedCharms(integrationId, charms);
        return this.processCharms(charms, integrationId);
      } catch (timeoutError) {
        // If timeout, use cached charms if available
        if (cachedCharms && cachedCharms.length > 0) {
          log(
            `Fetch timed out, using ${cachedCharms.length} cached charms for integration: ${integrationId}`,
          );
          return this.processCharms(cachedCharms, integrationId);
        }

        // Re-throw if no cached charms available
        throw timeoutError;
      }
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      log(`Error fetching charms for ${integrationId}: ${errorMessage}`);
      throw error;
    }
  }
}
