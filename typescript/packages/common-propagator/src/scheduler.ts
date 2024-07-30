import debug from "./debug.js";
import { AnyTask } from "./task.js";
import * as logger from "./logger.js";

export class Scheduler {
  #isRunning = false;
  #tasks: Array<AnyTask> = [];

  queue(...tasks: AnyTask[]) {
    if (tasks.length === 0) {
      return;
    }
    if (debug()) {
      logger.debug({
        topic: "scheduler",
        msg: "queue tasks",
        count: tasks.length,
      });
    }
    this.#tasks.push(...tasks);
    this.#run();
  }

  #run() {
    if (this.#isRunning) {
      return;
    }
    if (debug()) {
      logger.debug({
        topic: "scheduler",
        msg: "start transaction",
      });
    }
    this.#isRunning = true;
    let count = 0;
    while (true) {
      const task = this.#tasks.shift();
      if (task == null) {
        break;
      }
      count++;
      task.poll();
    }
    this.#isRunning = false;
    if (debug()) {
      logger.debug({
        topic: "scheduler",
        msg: "end transaction",
        count: count,
      });
    }
  }
}

export const scheduler = new Scheduler();
export default scheduler;
