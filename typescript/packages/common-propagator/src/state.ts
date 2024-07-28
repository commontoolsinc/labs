import { cid, Cid } from "./cid.js";
import debug from "./debug.js";
import * as logger from "./logger.js";

export type Time = number;

export type Causes = Record<Cid, Time>;

export const tick = (time: Time) => time + 1;

/**
 * Should we update state?
 * If all causes are equal, no.
 * If any incoming cause is out of date, no.
 * If at least one incoming cause is newer, and the rest are equal, then yes.
 */
export const shouldUpdate = (curr: Causes, next: Causes): boolean => {
  let atLeastOneNewer = false;
  for (const [cid, time] of Object.entries(next)) {
    if (curr[cid] == null) {
      continue;
    }
    if (curr[cid] == time) {
      continue;
    }
    // Incoming is stale
    if (curr[cid] > time) {
      return false;
    }
    atLeastOneNewer = true;
  }
  // If all either equal or
  return atLeastOneNewer;
};

export class State<T> {
  id: Cid;
  value: T;
  time: Time;
  causes: Record<Cid, Time>;

  constructor({
    id = cid(),
    value,
    time = 0,
    causes = {},
  }: {
    id?: Cid;
    value: T;
    time?: Time;
    causes?: Record<Cid, Time>;
  }) {
    this.id = id;
    this.value = value;
    this.time = time;
    this.causes = { ...causes, [this.id]: time };
  }

  merge(that: this): this {
    if (this.id !== that.id) {
      if (debug()) {
        logger.debug({
          topic: "state",
          msg: "Incoming state has different id. Ignoring.",
          us: this,
          them: that,
        });
      }
      return this;
    }
    if (!shouldUpdate(this.causes, that.causes)) {
      if (debug()) {
        logger.debug({
          topic: "state",
          msg: "Incoming state out of date. Ignoring.",
          us: this,
          them: that,
        });
      }
      return this;
    }
    if (debug()) {
      logger.debug({
        topic: "state",
        msg: "Advancing state",
        id: this.id,
        time: this.time,
        us: this,
        them: that,
      });
    }
    return that;
  }

  next(value: T, causes: Record<Cid, Time> = {}) {
    return new State({
      id: this.id,
      value,
      time: tick(this.time),
      causes: { ...this.causes, ...causes },
    });
  }
}

export const state = <T>(options: {
  id?: Cid;
  value: T;
  time?: Time;
  causes?: Record<Cid, Time>;
}): State<T> => new State(options);

export default state;
