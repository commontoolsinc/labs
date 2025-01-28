export class Semaphore {
  private permits: number;
  private tasks: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.tasks.push(resolve);
    });
  }

  release(): void {
    this.permits++;

    if (this.tasks.length > 0 && this.permits > 0) {
      this.permits--;
      const nextTask = this.tasks.shift();
      nextTask?.();
    }
  }
}

// Create a singleton instance for browser management
export const browserSemaphore = new Semaphore(5); 