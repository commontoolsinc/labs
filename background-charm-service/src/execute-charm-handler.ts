import type { DID } from "@commontools/identity";
import { Job } from "./types.ts";
import { log } from "./utils.ts";
import { env } from "./env.ts";
import {
  createTimeoutController,
  getSharedWorkerPool,
} from "./utils/common.ts";
import { WorkerPool } from "./utils/worker-pool.ts";
import { sleep } from "@commontools/utils";

export class ExecuteCharmHandler {
  private workerPool: WorkerPool<any, any>;

  constructor() {
    // Get the shared worker pool instance
    this.workerPool = getSharedWorkerPool(env.MAX_CONCURRENT_JOBS);
  }

  async handle(
    job: Job,
  ): Promise<{ success: boolean; error?: string }> {
    const entry = job.bgCharmEntry.get();

    log(`Executing ${entry.integration} ${entry.charmId} (${entry.space})`);

    const startTime = Date.now();

    // Execute the charm
    const result = await this.executeCharmWithWorker({
      space: entry.space as DID,
      charmId: entry.charmId,
    });

    log(
      `Successfully executed: ${entry.charmId} (${Date.now() - startTime}ms)`,
    );
    return { success: true };
    // } catch ({ error }) {
    //   console.log("execute-charm-handler error", { error });
    //   const errorMessage = typeof error === "string"
    //     ? error
    //     : error instanceof Error
    //     ? error.message
    //     : String(error);
    //   log(
    //     `Error executing charm ${entry.space}/${entry.charmId}: ${errorMessage} (${
    //       Date.now() - startTime
    //     }ms)`,
    //     { error: true },
    //   );

    //   return {
    //     success: false,
    //     error: errorMessage,
    //   };
  }

  private async executeCharmWithWorker({
    space,
    charmId,
  }: {
    space: DID;
    charmId: string;
  }): Promise<{ success: boolean; error?: string }> {
    log(`Submitting charm ${charmId} to worker pool`);

    // this spawns the actual worker process
    const task = this.workerPool.execute({
      spaceId: space,
      charmId,
      operatorPass: env.OPERATOR_PASS,
      toolshedUrl: env.TOOLSHED_API_URL,
    });

    const timeout = env.CHARM_EXECUTION_TIMEOUT_MS;

    // FIXME(ja): we need to actually kill the worker!
    const result = await Promise.race([
      task,
      sleep(timeout).then(() => ({
        error: `charm execution timed out after ${timeout}ms`,
      })),
    ]);

    console.log("execute-charm-handler", result);

    if (result && typeof result === "object" && "error" in result) {
      return {
        success: false,
        error: result.error as string,
      };
    }

    log(`Worker pool successfully executed charm: ${charmId}`);

    return {
      success: true,
    };
  }
}
