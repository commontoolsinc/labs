import {
  ExecuteCharmJob,
  Job,
  JobResult,
  JobStatus,
  JobType,
  KV_PREFIXES,
  MaintenanceJob,
  ScanIntegrationJob,
} from "./kv-types.ts";
import { log } from "./utils.ts";

// Import handlers
import { JobHandler } from "./job-handlers/base-handler.ts";
import { ScanIntegrationHandler } from "./job-handlers/scan-integration-handler.ts";
import { ExecuteCharmHandler } from "./job-handlers/execute-charm-handler.ts";
import { MaintenanceHandler } from "./job-handlers/maintenance-handler.ts";

/**
 * Options for the job queue
 */
export interface JobQueueOptions {
  maxConcurrentJobs?: number;
  maxRetries?: number;
  pollingIntervalMs?: number;
}

/**
 * Job queue system for handling background tasks
 */
export class JobQueue {
  private kv: Deno.Kv;
  private consumerRunning = false;
  private maxConcurrentJobs: number;
  private maxRetries: number;
  private pollingIntervalMs: number;
  private activeJobs = new Set<string>();
  private handlers: Record<JobType, JobHandler>;

  constructor(kv: Deno.Kv, options: JobQueueOptions = {}) {
    this.kv = kv;
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? 5;
    this.maxRetries = options.maxRetries ?? 3;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 100;

    // Register handlers
    this.handlers = {
      [JobType.SCAN_INTEGRATION]: new ScanIntegrationHandler(kv),
      [JobType.EXECUTE_CHARM]: new ExecuteCharmHandler(kv),
      [JobType.MAINTENANCE]: new MaintenanceHandler(kv),
    };

    log(
      `Job queue initialized with maxConcurrentJobs=${this.maxConcurrentJobs}, maxRetries=${this.maxRetries}`,
    );
  }

  /**
   * Add a job to the queue
   */
  async addJob<T extends Job>(
    jobData: Omit<
      T,
      "id" | "createdAt" | "retryCount" | "status" | "maxRetries"
    >,
  ): Promise<string> {
    const jobId = crypto.randomUUID();
    const job: Job = {
      id: jobId,
      createdAt: Date.now(),
      retryCount: 0,
      maxRetries: this.maxRetries,
      status: "pending",
      ...jobData,
    };

    // Add to KV
    await this.kv.set([...KV_PREFIXES.JOB_QUEUE, jobId], job);
    log(`Added job to queue: ${jobId} (type=${job.type})`);

    return jobId;
  }

  /**
   * Add a scan integration job
   */
  async addScanIntegrationJob(
    integrationId: string,
    priority: number = 5,
  ): Promise<string> {
    return this.addJob<ScanIntegrationJob>({
      type: JobType.SCAN_INTEGRATION,
      integrationId,
      priority,
    });
  }

  /**
   * Add an execute charm job
   */
  async addExecuteCharmJob(
    integrationId: string,
    spaceId: string,
    charmId: string,
    priority: number = 3,
  ): Promise<string> {
    return this.addJob<ExecuteCharmJob>({
      type: JobType.EXECUTE_CHARM,
      integrationId,
      spaceId,
      charmId,
      priority,
    });
  }

  /**
   * Add a maintenance job
   */
  async addMaintenanceJob(
    task: "cleanup" | "stats" | "reset",
    priority: number = 10,
  ): Promise<string> {
    return this.addJob<MaintenanceJob>({
      type: JobType.MAINTENANCE,
      task,
      priority,
    });
  }

  /**
   * Start the job consumer
   */
  startConsumer(): void {
    if (this.consumerRunning) {
      log("Job consumer is already running");
      return;
    }

    this.consumerRunning = true;
    this.runConsumerLoop();
    log("Job consumer started");
  }

  /**
   * Stop the job consumer
   */
  async stopConsumer(): Promise<void> {
    log("Stopping job consumer...");
    this.consumerRunning = false;

    // Wait for active jobs to finish with a timeout
    if (this.activeJobs.size > 0) {
      log(`Waiting for ${this.activeJobs.size} active jobs to complete...`);
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 10000)), // 10 sec timeout
        new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            if (this.activeJobs.size === 0) {
              clearInterval(checkInterval);
              resolve(true);
            }
          }, 100);
        }),
      ]);
    }

    log("Job consumer stopped");
  }

  /**
   * Get the job consumer status
   */
  getStatus(): {
    running: boolean;
    activeJobs: number;
    activeJobIds: string[];
  } {
    return {
      running: this.consumerRunning,
      activeJobs: this.activeJobs.size,
      activeJobIds: Array.from(this.activeJobs),
    };
  }

  /**
   * Main consumer loop
   */
  private async runConsumerLoop(): Promise<void> {
    log("Starting job consumer loop");

    while (this.consumerRunning) {
      try {
        // Check if we can process more jobs
        if (this.activeJobs.size >= this.maxConcurrentJobs) {
          // Wait a bit and check again
          await new Promise((resolve) =>
            setTimeout(resolve, this.pollingIntervalMs)
          );
          continue;
        }

        // Get next job from queue
        const job = await this.getNextJob();

        if (!job) {
          // No jobs, wait a bit
          await new Promise((resolve) =>
            setTimeout(resolve, this.pollingIntervalMs)
          );
          continue;
        }

        log(`Processing job: ${job.id} (type=${job.type})`);

        // Process job in the background
        this.activeJobs.add(job.id);
        this.processJob(job).finally(() => {
          this.activeJobs.delete(job.id);
        });
      } catch (error) {
        log(
          `Error in job consumer: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait a bit on error
      }
    }
  }

  /**
   * Get the next job to process from the queue
   */
  private async getNextJob(): Promise<Job | null> {
    // Get all pending jobs
    const pendingJobs: Job[] = [];
    const entries = this.kv.list<Job>({ prefix: KV_PREFIXES.JOB_QUEUE });

    for await (const entry of entries) {
      const job = entry.value;
      if (job.status === "pending") {
        pendingJobs.push(job);

        // Get versionstamp for later usage
        job._versionstamp = entry.versionstamp;
      }
    }

    if (pendingJobs.length === 0) {
      return null;
    }

    // Sort by priority (higher first) and then by creation time (older first)
    pendingJobs.sort((a, b) => {
      if (a.priority !== b.priority) {
        return b.priority - a.priority; // Higher priority first
      }
      return a.createdAt - b.createdAt; // Older first
    });

    // Pick the highest priority job
    const job = pendingJobs[0];

    try {
      // Mark as processing using atomic operations to avoid race conditions
      const jobKey = [...KV_PREFIXES.JOB_QUEUE, job.id];
      const result = await this.kv.atomic()
        .check({ key: jobKey, versionstamp: job._versionstamp as string })
        .set(jobKey, { ...job, status: "processing" })
        .commit();

      if (!result.ok) {
        // Job was modified by another process
        return null;
      }

      // Remove internal versionstamp property
      const { _versionstamp, ...cleanJob } = job;
      return { ...cleanJob, status: "processing" };
    } catch (error) {
      log(`Error marking job ${job.id} as processing: ${error.message}`);
      return null;
    }
  }

  /**
   * Process a job
   */
  private async processJob(job: Job): Promise<void> {
    const startTime = Date.now();
    let success = false;
    let error: string | undefined;
    let resultData: unknown;

    log(`Starting job ${job.id} (${job.type})`);

    try {
      // Get the appropriate handler
      const handler = this.handlers[job.type];
      if (!handler) {
        throw new Error(`No handler for job type: ${job.type}`);
      }

      // Execute with timeout (based on job type)
      const timeout = this.getTimeoutForJobType(job.type);
      try {
        // CRITICAL FIX: Special handling for execute_charm jobs
        if (job.type === JobType.EXECUTE_CHARM) {
          try {
            // Use a longer timeout for execute charm jobs
            resultData = await Promise.race([
              handler.handle(job),
              new Promise((_resolve, reject) => {
                setTimeout(
                  () =>
                    reject(
                      new Error(`Job execution timed out after ${timeout}ms`),
                    ),
                  timeout,
                );
              }),
            ]);

            // Explicitly check the result of execute charm jobs
            if (
              resultData && typeof resultData === "object" &&
              "success" in resultData
            ) {
              // If the handler explicitly returns success: false, respect that
              success = resultData.success === true;
              if (!success && "error" in resultData) {
                error = resultData.error as string;
                throw new Error(error || "Unknown error in charm execution");
              }
            } else {
              success = true;
            }

            if (success) {
              log(
                `Job ${job.id} completed successfully (${
                  Date.now() - startTime
                }ms)`,
              );
            } else {
              log(
                `Job ${job.id} failed (${Date.now() - startTime}ms): ${
                  error || "Unknown error"
                }`,
              );
              throw new Error(error || "Unknown error in charm execution");
            }
          } catch (e) {
            // Re-throw to outer catch
            throw e;
          }
        } else {
          // Regular handling for other job types
          resultData = await Promise.race([
            handler.handle(job),
            new Promise((_resolve, reject) => {
              setTimeout(
                () =>
                  reject(
                    new Error(`Job execution timed out after ${timeout}ms`),
                  ),
                timeout,
              );
            }),
          ]);
          success = true;
          log(
            `Job ${job.id} completed successfully (${
              Date.now() - startTime
            }ms)`,
          );
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        throw e; // Re-throw for outer catch
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      log(`Job ${job.id} (${job.type}) failed: ${error}`);

      try {
        // Get fresh copy of job in case it was updated
        const jobKey = [...KV_PREFIXES.JOB_QUEUE, job.id];
        const freshJobResult = await this.kv.get<Job>(jobKey);
        const freshJob = freshJobResult.value;

        if (!freshJob) {
          log(`Job ${job.id} no longer exists, skipping update`);
          return;
        }

        // Update job status based on retry policy
        if (freshJob.retryCount < freshJob.maxRetries) {
          // Retry the job
          const updatedJob = {
            ...freshJob,
            retryCount: freshJob.retryCount + 1,
            status: "pending" as JobStatus,
          };

          // Add exponential backoff delay
          const backoffMs = Math.min(
            30000,
            1000 * Math.pow(2, freshJob.retryCount),
          );
          log(
            `Retrying job ${job.id} after ${backoffMs}ms (attempt ${updatedJob.retryCount} of ${freshJob.maxRetries})`,
          );

          setTimeout(() => {
            this.kv.set(jobKey, updatedJob)
              .catch((err) =>
                log(`Error scheduling job retry: ${err.message}`)
              );
          }, backoffMs);
        } else {
          // Mark as failed
          const failedJob = { ...freshJob, status: "failed" as JobStatus };
          await this.kv.set(jobKey, failedJob);

          // Store failed job result
          const jobResult: JobResult = {
            jobId: job.id,
            success: false,
            error,
            completedAt: Date.now(),
            executionTimeMs: Date.now() - startTime,
          };

          await this.kv.set([...KV_PREFIXES.JOB_RESULTS, job.id], jobResult);
          log(
            `Job ${job.id} permanently failed after ${freshJob.maxRetries} attempts`,
          );
        }
      } catch (updateError) {
        log(`Error updating job status: ${updateError.message}`);
      }

      return;
    }

    try {
      // Get fresh copy of job in case it was updated
      const jobKey = [...KV_PREFIXES.JOB_QUEUE, job.id];
      const freshJobResult = await this.kv.get<Job>(jobKey);
      const freshJob = freshJobResult.value;

      if (!freshJob) {
        log(`Job ${job.id} no longer exists, skipping update`);
        return;
      }

      // Job completed successfully
      const completedJob = { ...freshJob, status: "completed" as JobStatus };
      await this.kv.set(jobKey, completedJob);

      // Store result
      const jobResult: JobResult = {
        jobId: job.id,
        success: true,
        data: resultData,
        completedAt: Date.now(),
        executionTimeMs: Date.now() - startTime,
      };

      await this.kv.set([...KV_PREFIXES.JOB_RESULTS, job.id], jobResult);
    } catch (updateError) {
      log(`Error updating job status: ${updateError.message}`);
    }
  }

  /**
   * Get appropriate timeout based on job type
   */
  private getTimeoutForJobType(type: JobType): number {
    switch (type) {
      case JobType.EXECUTE_CHARM:
        return 30000; // 30 seconds for charm execution
      case JobType.SCAN_INTEGRATION:
        return 20000; // 20 seconds for integration scanning
      case JobType.MAINTENANCE:
        return 60000; // 60 seconds for maintenance tasks
      default:
        return 30000; // Default 30 seconds
    }
  }

  /**
   * Get a job result
   */
  async getJobResult(jobId: string): Promise<JobResult | null> {
    const result = await this.kv.get<JobResult>([
      ...KV_PREFIXES.JOB_RESULTS,
      jobId,
    ]);
    return result.value;
  }

  /**
   * Cleanup old jobs and results
   */
  async cleanup(maxAgeMs: number = 86400000): Promise<number> {
    let count = 0;
    const cutoff = Date.now() - maxAgeMs;

    // Clean up completed and failed jobs
    const jobs = this.kv.list<Job>({ prefix: KV_PREFIXES.JOB_QUEUE });
    for await (const entry of jobs) {
      const job = entry.value;
      if (
        (job.status === "completed" || job.status === "failed") &&
        job.createdAt < cutoff
      ) {
        await this.kv.delete(entry.key);
        count++;
      }
    }

    // Clean up job results
    const results = this.kv.list<JobResult>({
      prefix: KV_PREFIXES.JOB_RESULTS,
    });
    for await (const entry of results) {
      const result = entry.value;
      if (result.completedAt < cutoff) {
        await this.kv.delete(entry.key);
        count++;
      }
    }

    log(`Cleaned up ${count} old jobs and results`);
    return count;
  }
}
