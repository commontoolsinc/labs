import { State } from "mistreevous";

export abstract class BaseAgent {
  protected logger: any;
  protected agentName: string;
  protected stepDurations: Record<string, number> = {};
  protected logs: string[] = [];
  protected startTime: number = 0;

  constructor(logger: any, agentName: string) {
    this.agentName = agentName;
    this.logger = {
      info: (msg: string) => {
        this.logs.push(msg);
        logger.info(msg);
      },
      error: (msg: string, error?: any) => {
        this.logs.push(`ERROR: ${msg}`);
        logger.error(msg, error);
      },
    };
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
