import type { DID } from "@commontools/identity";
import { Job } from "./types.ts";
import { log } from "./utils.ts";
import { CharmTimeoutError } from "./errors.ts";
import { env } from "./env.ts";
import {
  createTimeoutController,
  getSharedWorkerPool,
} from "./utils/common.ts";
import { WorkerPool } from "./utils/worker-pool.ts";

export class ExecuteCharmHandler {
  private workerPool: WorkerPool<any, any>;

  constructor() {
    // Get the shared worker pool instance
    const workerUrl = new URL("./utils/charm-worker.ts", import.meta.url).href;
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

  async handle(
    job: Job,
  ): Promise<{ success: boolean; error?: string }> {
    const entry = job.bgCharmEntry.get();

    log(`Executing ${entry.integration} ${entry.charmId} (${entry.space})`);

    const startTime = Date.now();

    try {
      // Execute the charm - passing integration ID for Gmail-specific handling
      await this.executeCharmWithWorker({
        space: entry.space as DID,
        charmId: entry.charmId,
      });

      log(
        `Successfully executed: ${entry.charmId} (${Date.now() - startTime}ms)`,
      );
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      log(
        `Error executing charm ${entry.space}/${entry.charmId}: ${errorMessage} (${
          Date.now() - startTime
        }ms)`,
        { error: true },
      );

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  private async executeCharmWithWorker({
    space,
    charmId,
  }: {
    space: DID;
    charmId: string;
  }): Promise<void> {
    // Create a timeout controller for the worker execution
    const { controller, clear: clearTimeout } = createTimeoutController(
      env.CHARM_EXECUTION_TIMEOUT_MS,
    );

    try {
      log(`Submitting charm ${charmId} to worker pool`);

      // this spawns the actual worker process
      const task = this.workerPool.execute({
        spaceId: space,
        charmId,
        operatorPass: env.OPERATOR_PASS,
        toolshedUrl: env.TOOLSHED_API_URL,
      });

      // Convert AbortSignal to a promise that rejects when aborted
      // FIXME(ja): we need to actually kill the worker process?
      const abort = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(
            new CharmTimeoutError(
              `Charm execution timed out after ${env.CHARM_EXECUTION_TIMEOUT_MS}ms`,
              space as string,
              charmId || "",
              env.CHARM_EXECUTION_TIMEOUT_MS,
            ),
          );
        });
      });

      const result = await Promise.race([task, abort]);

      // Check if the result indicates an error
      if (result && typeof result === "object" && "error" in result) {
        throw new Error(result.error as string);
      }

      log(`Worker pool successfully executed charm: ${charmId}`);
    } finally {
      // Always clear the timeout to prevent memory leaks
      clearTimeout();
    }
  }
}
