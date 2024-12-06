import {
  service,
  $,
  refer,
  Fact,
  Reference,
  Instruction,
  Session,
  Task,
} from "@commontools/common-system";
import { Transact } from "../sugar.js";
export type { Reference };

const provider = refer({
  effect: { timer: { version: [0, 0, 1] } },
});

export const TIMER = {
  STATUS: "~/timer/status",
  REMAINING: "~/timer/remaining",
  TOTAL: "~/timer/total",
};

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

function dispatchEvent(target: Reference, event: string, payload: any): Fact {
  return [target, event, payload];
}

export class Timer {
  constructor(
    public consumer: Reference,
    public port: string,
    public duration: number,
    public interval: number = 1000,
  ) {
    console.log("Timer constructor", consumer, port, duration, interval);
    this.id = refer({ timer: { consumer, port, duration, interval } });
  }

  public id: Reference;

  get Assert(): Fact {
    return dispatchEvent(provider, TimerEvents.start, {
      status: "Initial",
      source: this,
    } as any);
  }
}

export const TimerEvents = {
  start: "~/timer/start",
  tick: "~/timer/tick",
  pause: "~/timer/pause",
  resume: "~/timer/resume",
  reset: "~/timer/reset",
  complete: "~/timer/complete",
};

const onTimerEvent = (
  ev: string,
  perform: ({
    timer,
  }: {
    timer: Reference;
  }) => Generator<any, Instruction[], any>,
) => ({
  select: {
    timer: $.timer,
  },
  where: [{ Case: [provider, ev, $.timer] } as const],
  perform,
});

export default service({
  "timer/start": onTimerEvent(TimerEvents.start, function* ({ timer }) {
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
        { Retract: [provider, TimerEvents.start, timer] },
        { Upsert: dispatchEvent(provider, TimerEvents.tick, newState) },
        {
          Upsert: [
            effect.source.consumer,
            effect.source.port,
            effect.source.id,
          ],
        },
        ...Transact.set(effect.source.id, {
          [TIMER.STATUS]: "Running",
          [TIMER.REMAINING]: effect.source.duration,
          [TIMER.TOTAL]: effect.source.duration,
        }),
      ];
    }
    return [];
  }),

  "timer/tick": onTimerEvent(TimerEvents.tick, function* ({ timer }) {
    const state = Session.resolve<State>(timer);
    if (state?.status === "Running") {
      if (Date.now() >= state.finish) {
        // Timer complete
        return [
          { Retract: [provider, TimerEvents.tick, timer] },
          {
            Upsert: dispatchEvent(provider, TimerEvents.complete, {
              status: "Complete",
              source: state.source,
            }),
          },
          ...Transact.set(state.source.id, {
            [TIMER.STATUS]: "Complete",
            [TIMER.REMAINING]: 0,
          }),
        ];
      }

      // Yield sleep for the interval duration
      yield* Task.sleep(state.source.interval ?? 1000);

      // Update the remaining time
      const newState = {
        status: "Running",
        source: state.source,
        finish: state.finish,
      };

      const remaining = Math.max(0, newState.finish - Date.now()) / 1000;

      return [
        { Retract: [provider, TimerEvents.tick, timer] },
        { Upsert: dispatchEvent(provider, TimerEvents.tick, newState) },
        { Upsert: [state.source.id, TIMER.REMAINING, remaining] },
      ];
    }
    return [];
  }),

  "timer/pause": onTimerEvent(TimerEvents.pause, function* ({ timer }) {
    console.log("timer/pause", timer);
    const effect = Session.resolve<State>(timer);
    if (effect?.status === "Running") {
      return [
        { Retract: [provider, TimerEvents.tick, timer] },
        { Upsert: [effect.source.id, TIMER.STATUS, "Paused"] },
      ];
    }
    return [];
  }),

  "timer/resume": onTimerEvent(TimerEvents.resume, function* ({ timer }) {
    console.log("timer/resume", timer);
    const effect = Session.resolve<State>(timer);
    if (effect?.status === "Paused") {
      // Resume ticking
      Session.upsert([
        provider,
        TimerEvents.tick,
        {
          status: "Running",
          source: effect.source,
          finish: effect.finish,
        } as any,
      ]);

      return [
        { Retract: [provider, TimerEvents.resume, timer] },
        { Upsert: [effect.source.id, TIMER.STATUS, "Running"] },
      ];
    }
    return [];
  }),

  "timer/reset": onTimerEvent(TimerEvents.reset, function* ({ timer }) {
    console.log("timer/reset", timer);
    const effect = Session.resolve<State>(timer);
    if (
      effect?.status === "Running" ||
      effect?.status === "Paused" ||
      effect?.status === "Complete"
    ) {
      return [
        ...Transact.remove(provider, {
          [TimerEvents.tick]: timer,
          [TimerEvents.complete]: timer,
        }),
        {
          Upsert: dispatchEvent(provider, TimerEvents.start, {
            status: "Initial",
            source: effect.source,
          }),
        },
        ...Transact.set(effect.source.id, {
          [TIMER.STATUS]: "Initial",
          [TIMER.REMAINING]: effect.source.duration,
        }),
      ];
    }
    return [];
  }),
});

export const timer = (
  consumer: Reference,
  port: string,
  duration: number,
  interval?: number,
) => new Timer(consumer, port, duration, interval);
