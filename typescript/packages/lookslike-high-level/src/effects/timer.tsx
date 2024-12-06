import {
  service,
  $,
  refer,
  Fact,
  Reference,
  Instruction,
  Session,
  Task,
  h,
} from "@commontools/common-system";
export type { Reference };

const provider = refer({
  effect: { timer: { version: [0, 0, 1] } },
});

export const TIMER = {
  STATUS: '~/timer/status',
  REMAINING: '~/timer/remaining',
  TOTAL: '~/timer/total',
}

type TimerConfig = {
  consumer: Reference;
  port: string;
  id: Reference;
  duration: number;
  interval?: number;
};

type State =
  | { status: "Initial"; source: TimerConfig }
  | { status: "Running"; source: TimerConfig; finish: number }
  | { status: "Paused"; source: TimerConfig; finish: number }
  | { status: "Complete"; source: TimerConfig; finish: number };

export class Timer {
  constructor(
    public consumer: Reference,
    public port: string,
    public duration: number,
    public interval: number = 1000
  ) {
    console.log("Timer constructor", consumer, port, duration, interval);
    this.id = refer({ timer: { consumer, port, duration, interval } });
  }

  public id: Reference;

  get Assert(): Fact {
    return [provider, `~/start`, { status: "Initial", source: this } as any];
  }
}

export default service({
  'timer/start': {
    select: {
      timer: $.timer,
    },
    where: [{ Case: [provider, `~/start`, $.timer] }],
    *perform({ timer }: { timer: Reference }): Task.Task<Instruction[]> {
      const effect = Session.resolve<State>(timer);
      if (effect?.status === "Initial") {
        const start = Date.now();

        // Update the state to Running
        const newState = {
          status: "Running",
          source: effect.source,
          remaining: effect.source.duration,
          finish: start + effect.source.duration * 1000,
        };

        return [
          { Retract: [provider, "~/start", timer] },
          { Upsert: [provider, "~/tick", newState as any] },
          { Upsert: [effect.source.consumer, effect.source.port, effect.source.id] },
          { Upsert: [effect.source.id, TIMER.STATUS, "Running"] },
          { Upsert: [effect.source.id, TIMER.REMAINING, effect.source.duration] },
          { Upsert: [effect.source.id, TIMER.TOTAL, effect.source.duration] },
        ];
      }
      return [];
    },
  },

  'timer/tick': {
    select: {
      timer: $.timer,
    },
    where: [{ Case: [provider, `~/tick`, $.timer] }],
    *perform({ timer }: { timer: Reference }): Task.Task<Instruction[]> {
      const state = Session.resolve<State>(timer);
      if (state?.status === "Running") {
        if (Date.now() >= state.finish) {
          // Timer complete
          return [
            { Retract: [provider, "~/tick", timer] },
            { Upsert: [provider, "~/complete", { status: "Complete", source: state.source } as any] },
            { Upsert: [state.source.id, TIMER.STATUS, "Complete"] },
            { Upsert: [state.source.id, TIMER.REMAINING, 0] },
          ];
        }

        // Yield sleep for the interval duration
        yield* Task.sleep(state.source.interval ?? 1000);

        // Update the remaining time
        const newState = {
          status: "Running",
          source: state.source,
          finish: state.finish,
        } as any

        const remaining = Math.max(0, newState.finish - Date.now()) / 1000;

        return [
          { Retract: [provider, "~/tick", timer] },
          { Upsert: [provider, "~/tick", newState as any] },
          { Upsert: [state.source.id, TIMER.REMAINING, remaining] },
        ];
      }
      return [];
    },
  },

  // 'timer/pause': {
  //   select: {
  //     timer: $.timer,
  //   },
  //   where: [{ Case: [provider, `~/pause`, $.timer] }],
  //   * perform({ timer }: { timer: Reference }) {
  //     console.log("timer/pause", timer);
  //     const effect = Session.resolve<State>(timer);
  //     if (effect?.status === "Running") {
  //       return [
  //         { Retract: [provider, "~/tick", timer] },
  //         { Upsert: [effect.source.id, TIMER.STATUS, "Paused"] },
  //       ];
  //     }
  //     return [];
  //   },
  // },

  // 'timer/resume': {
  //   select: {
  //     timer: $.timer,
  //   },
  //   where: [{ Case: [provider, `~/resume`, $.timer] }],
  //   * perform({ timer }: { timer: Reference }) {
  //     console.log("timer/resume", timer);
  //     const effect = Session.resolve<State>(timer);
  //     if (effect?.status === "Paused") {
  //       // Resume ticking
  //       Session.upsert([provider, "~/tick", {
  //         status: "Running",
  //         source: effect.source,
  //         remaining: effect.remaining,
  //       } as any]);

  //       return [
  //         { Retract: [provider, "~/resume", timer] },
  //         { Upsert: [effect.source.id, TIMER.STATUS, "Running"] },
  //       ];
  //     }
  //     return [];
  //   },
  // },

  // 'timer/reset': {
  //   select: {
  //     timer: $.timer,
  //   },
  //   where: [{ Case: [provider, `~/reset`, $.timer] }],
  //   * perform({ timer }: { timer: Reference }) {
  //     console.log("timer/reset", timer);
  //     const effect = Session.resolve<State>(timer);
  //     if (
  //       effect?.status === "Running" ||
  //       effect?.status === "Paused" ||
  //       effect?.status === "Complete"
  //     ) {
  //       return [
  //         { Retract: [provider, "~/tick", timer] },
  //         { Retract: [provider, "~/complete", timer] },
  //         { Upsert: [provider, "~/start", { status: "Initial", source: effect.source }] },
  //         { Upsert: [effect.source.id, TIMER.STATUS, "Initial"] },
  //         { Upsert: [effect.source.id, TIMER.REMAINING, effect.source.duration] },
  //       ];
  //     }
  //     return [];
  //   },
  // },
});

export const timer = (consumer: Reference, port: string, duration: number, interval?: number) =>
  new Timer(consumer, port, duration, interval);