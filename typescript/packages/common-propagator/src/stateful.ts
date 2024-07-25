import { cid, Cid } from "./cid.js";
import * as logger from "./logger.js";

export type Time = number;

export type Causes = Record<Cid, Time>;

export const tick = (time: Time) => time + 1;

export const isStale = (curr: Causes, next: Causes): boolean => {
  for (const [cid, time] of Object.entries(next)) {
    if (curr[cid] == null) {
      continue;
    } else if (curr[cid] >= time) {
      return true;
    }
  }
  return false;
};

export class State<T> {
  id = cid();
  value: T;
  time: Time;
  causes: Record<Cid, Time>;

  constructor(value: T, time = 0, causes: Record<Cid, Time> = {}) {
    this.value = value;
    this.time = time;
    this.causes = causes;
  }

  next(value: T, causes: Record<Cid, Time> = {}) {
    return new State(value, tick(this.time), { ...this.causes, ...causes });
  }

  merge(them: this): this {
    if (isStale(this.causes, them.causes)) {
      logger.debug({
        topic: "state",
        msg: "State out of date. Ignoring.",
        us: this,
        them: them,
      });
      return this;
    }
    logger.debug({
      topic: "state",
      msg: "Advancing state",
      id: this.id,
      time: this.time,
      us: this.causes,
      them: them.causes,
    });
    return them;
  }
}

export const state = <T>(
  value: T,
  time = 0,
  causes: Record<Cid, Time> = {},
): State<T> => new State(value, time, causes);

export default state;

// export const merge = <A, B, C>(
//   a: Stateful<A>,
//   b: Stateful<B>,
//   out: Stateful<C>,
//   fn: (a: A, b: B) => C,
// ): Stateful<C> => {
//   const out2 = new Stateful(fn(a.value, b.value), tick(out.time), {
//     ...a.causes,
//     ...b.causes,
//     [a.id]: a.time,
//     [b.id]: b.time,
//   });
//   return out.merge(out2);
// };
