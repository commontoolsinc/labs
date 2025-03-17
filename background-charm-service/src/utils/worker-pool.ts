/**
 * Worker pool for managing worker processes
 */
import { log } from "../utils.ts";
import { WorkerError } from "../errors/index.ts";

export interface WorkerPoolOptions {
  maxWorkers: number;
  workerUrl: URL | string;
  workerOptions?: Deno.WorkerOptions;
  initTimeout?: number;
}

export interface WorkerTask<T, R> {
  id: string;
  data: T;
  resolve: (result: R) => void;
  reject: (error: Error) => void;
}

/**
 * Worker pool for managing a fixed number of workers
 */
export class WorkerPool<T, R> {
  private workers: Array<{
    worker: Worker;
    busy: boolean;
    id: string;
  }> = [];

  private taskQueue: Array<WorkerTask<T, R>> = [];
  private options: WorkerPoolOptions;
  private nextWorkerId = 0;
  private isShuttingDown = false;

  constructor(options: WorkerPoolOptions) {
    this.options = {
      initTimeout: 10000, // 10 second default timeout for worker initialization
      ...options,
    };

    log(`Worker pool initialized with maxWorkers=${options.maxWorkers}`);
  }

  /**
   * Get a worker from the pool or create a new one if needed and available
   */
  private getAvailableWorker(): { worker: Worker; id: string } | null {
    // First check for existing idle workers
    for (const workerInfo of this.workers) {
      if (!workerInfo.busy) {
        workerInfo.busy = true;
        return { worker: workerInfo.worker, id: workerInfo.id };
      }
    }

    // If no idle workers, create a new one if we haven't reached the limit
    if (this.workers.length < this.options.maxWorkers) {
      const workerId = `worker-${this.nextWorkerId++}`;

      try {
        const worker = new Worker(this.options.workerUrl, {
          type: "module",
          ...this.options.workerOptions,
        });

        this.workers.push({ worker, busy: true, id: workerId });
        log(`Created new worker: ${workerId}`);

        // Set up error handling
        worker.onerror = (event) => {
          log(`Worker ${workerId} error: ${event.message}`);
          this.handleWorkerError(
            workerId,
            new WorkerError(event.message, workerId),
          );
        };

        return { worker, id: workerId };
      } catch (error) {
        log(`Error creating worker ${workerId}: ${error.message}`);
        return null;
      }
    }

    // No workers available
    return null;
  }

  /**
   * Handle a worker error
   */
  private handleWorkerError(workerId: string, error: Error): void {
    log(`Handling worker error for ${workerId}: ${error.message}`);

    // Find the worker
    const workerIndex = this.workers.findIndex((w) => w.id === workerId);
    if (workerIndex === -1) {
      log(`Worker ${workerId} not found in pool`);
      return;
    }

    // Terminate the worker
    try {
      this.workers[workerIndex].worker.terminate();
    } catch (terminateError) {
      log(`Error terminating worker ${workerId}: ${terminateError.message}`);
    }

    // Remove the worker from the pool
    this.workers.splice(workerIndex, 1);

    // Create a new worker if we're not shutting down
    if (!this.isShuttingDown) {
      log(`Attempting to create replacement worker for ${workerId}`);
      this.processQueue(); // Try to create a new worker to handle queued tasks
    }
  }

  /**
   * Execute a task using a worker from the pool
   */
  async execute(data: T): Promise<R> {
    if (this.isShuttingDown) {
      throw new Error("Worker pool is shutting down");
    }

    return new Promise<R>((resolve, reject) => {
      const taskId = crypto.randomUUID();

      // Create a task
      const task: WorkerTask<T, R> = {
        id: taskId,
        data,
        resolve,
        reject,
      };

      // Add to queue
      this.taskQueue.push(task);

      // Try to process immediately
      this.processQueue();
    });
  }

  /**
   * Process the task queue
   */
  private processQueue(): void {
    // Process tasks until queue is empty or no workers available
    while (this.taskQueue.length > 0) {
      const workerInfo = this.getAvailableWorker();
      if (!workerInfo) {
        // No workers available
        log(`No workers available, ${this.taskQueue.length} tasks in queue`);
        return;
      }

      const task = this.taskQueue.shift()!;
      this.executeTask(workerInfo.worker, workerInfo.id, task);
    }
  }

  /**
   * Execute a task on a worker
   */
  private executeTask(
    worker: Worker,
    workerId: string,
    task: WorkerTask<T, R>,
  ): void {
    log(`Executing task ${task.id} on worker ${workerId}`);

    // Set up message handler for this specific task
    const messageHandler = (event: MessageEvent) => {
      if (event.data.error) {
        // Task failed
        const errorMessage = event.data.error;
        log(`Task ${task.id} failed on worker ${workerId}: ${errorMessage}`);
        task.reject(new Error(errorMessage));
      } else {
        // Task succeeded
        log(`Task ${task.id} completed on worker ${workerId}`);
        task.resolve(event.data.result);
      }

      // Clean up
      worker.removeEventListener("message", messageHandler);

      // Mark worker as available
      const workerInfo = this.workers.find((w) => w.id === workerId);
      if (workerInfo) {
        workerInfo.busy = false;
      }

      // Process next task if any
      this.processQueue();
    };

    // Add message handler
    worker.addEventListener("message", messageHandler);

    // Send task to worker
    worker.postMessage({ taskId: task.id, data: task.data });
  }

  /**
   * Shut down the worker pool
   */
  async shutdown(): Promise<void> {
    log("Shutting down worker pool");
    this.isShuttingDown = true;

    // Wait for all workers to finish current tasks with a timeout
    const waitForIdle = new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        const busyWorkers = this.workers.filter((w) => w.busy);
        if (busyWorkers.length === 0 || this.isShuttingDown) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });

    // Wait for either all workers to become idle or timeout (5 seconds)
    await Promise.race([
      waitForIdle,
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);

    // Terminate all workers
    for (const workerInfo of this.workers) {
      try {
        workerInfo.worker.terminate();
        log(`Terminated worker ${workerInfo.id}`);
      } catch (error) {
        log(`Error terminating worker ${workerInfo.id}: ${error.message}`);
      }
    }

    // Clear the pool
    this.workers = [];

    // Reject any remaining tasks
    for (const task of this.taskQueue) {
      task.reject(new Error("Worker pool was shut down"));
    }
    this.taskQueue = [];

    log("Worker pool shutdown complete");
  }

  /**
   * Get the number of active workers
   */
  getActiveWorkerCount(): number {
    return this.workers.filter((w) => w.busy).length;
  }

  /**
   * Get the total number of workers in the pool
   */
  getTotalWorkerCount(): number {
    return this.workers.length;
  }

  /**
   * Get the number of queued tasks
   */
  getQueuedTaskCount(): number {
    return this.taskQueue.length;
  }
}
