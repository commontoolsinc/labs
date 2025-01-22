import { State } from "mistreevous";
import { Logger, PrefixedLogger } from "./prefixed-logger.ts";

// Handles logging and instrumentation
export abstract class BaseAgent {
  protected logger: PrefixedLogger;
  protected agentName: string;
  protected stepDurations: Record<string, number> = {};
  protected logs: string[] = [];
  protected startTime: number = 0;

  constructor(logger: Logger, agentName: string) {
    this.agentName = agentName;
    this.logger = new PrefixedLogger(logger, agentName);
    this.startTime = Date.now();
  }

  protected async measureStep(
    stepName: string,
    fn: () => Promise<State>,
  ): Promise<State> {
    const start = Date.now();
    const result = await fn();
    this.stepDurations[stepName] = Date.now() - start;
    this.logger.info(
      `${this.agentName}: ${stepName} took ${this.stepDurations[stepName]}ms`,
    );
    return result;
  }

  protected getMetadata() {
    const totalDuration = Date.now() - this.startTime;
    return {
      totalDuration,
      stepDurations: this.stepDurations,
      logs: this.logs,
    };
  }
}
