import { Job } from "../kv-types.ts";

/**
 * Base interface for job handlers
 */
export interface JobHandler {
  /**
   * Handle a job
   * @param job The job to handle
   * @returns The result of the job (can be any data)
   */
  handle(job: Job): Promise<unknown>;
}