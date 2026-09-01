/**
 * What a push and a pop cost, across the three states the stack can be in and
 * with and without a repeated object in play.
 *
 * The states are what make this more than one figure. `IndexTrackingStack`
 * answers by scanning while it is short, from an index once it has been
 * `ADD_INDEX_AT` entries tall, and by scanning again once it has come back
 * below `DROP_INDEX_BELOW`:
 *
 * | state | index | height while timed |
 * | --- | --- | --- |
 * | `scanning` | never built | below `ADD_INDEX_AT` |
 * | `crossed` | built, then dropped | below `DROP_INDEX_BELOW` |
 * | `indexed` | built | above `ADD_INDEX_AT` |
 *
 * `scanning` and `crossed` do the same work at the same height, so the two of
 * them meeting is what says the index was dropped rather than carried. No test
 * can say it, the drop changing no answer.  `indexed` is what a deep graph
 * pays.
 *
 * The `oscillating` group is what says the two marks are far enough apart. A
 * stack swinging inside either mark neither builds nor drops; only one
 * swinging across the whole gap rebuilds, and that band is here to be watched
 * rather than because it is expected.
 *
 * A repeated object is measured separately throughout, because it is what the
 * index has to record per object rather than as a single number: a push adds a
 * position to an existing entry rather than making one, and a pop takes a
 * position off rather than removing the entry.
 *
 * Every case times a batch of operations of one kind, and nothing else. The
 * scaffolding -- the state each stack has to be brought to, and the pushes a
 * pop batch needs -- is built outside the timed region.
 *
 * That is why an iteration works over a pool of stacks rather than one. Deno
 * ignores `start()` and `end()` for an iteration averaging under 10 us, and a
 * batch small enough to stay inside the `crossed` state's height band is far
 * under that on its own -- so the figure would silently become the scaffolding
 * plus the batch, which is a different measurement and a much larger one.
 * Running the batch against `POOL` stacks puts the timed region well past the
 * threshold while leaving each stack inside its band.
 *
 * Run with:
 *
 *     deno task bench
 */

import { IndexTrackingStack } from "@commonfabric/utils/index-tracking-stack";

/** How many operations one timed batch performs, against one stack. */
const BATCH = 32;

/**
 * How many stacks one iteration runs its batch against. Sized so that the
 * timed region is long enough for Deno to honor the explicit timer, `BATCH`
 * being capped by the height band the `crossed` state has to stay inside.
 */
const POOL = 128;

/** How far above `ADD_INDEX_AT` the indexed state sits. */
const ABOVE = 8;

/** How far below `DROP_INDEX_BELOW` the crossed state comes back down to. */
const BELOW = 8;

/** Distinct objects, as many as asked for. */
function objects(count: number): object[] {
  const out: object[] = [];

  for (let at = 0; at < count; at++) out.push({ at });

  return out;
}

/**
 * A batch of `BATCH` objects. Every fourth one is the same object where
 * `repeated` asks for it, so the batch holds several positions of one object
 * rather than a single incidental pair.
 */
function batchOf(repeated: boolean): object[] {
  const out = objects(BATCH);

  if (repeated) {
    const shared = {};

    for (let at = 0; at < BATCH; at += 4) out[at] = shared;
  }

  return out;
}

/** The three states, as the height a stack reaches and where it settles. */
const STATES = [
  { name: "scanning", climb: 0, settle: 0 },
  {
    name: "crossed",
    climb: IndexTrackingStack.ADD_INDEX_AT + ABOVE,
    settle: IndexTrackingStack.DROP_INDEX_BELOW - BELOW,
  },
  {
    name: "indexed",
    climb: IndexTrackingStack.ADD_INDEX_AT + ABOVE,
    settle: IndexTrackingStack.ADD_INDEX_AT + ABOVE,
  },
] as const;

/** A stack in the given state, ready for a batch to be timed against it. */
function stackIn(state: typeof STATES[number]): IndexTrackingStack {
  const stack = new IndexTrackingStack();

  for (const value of objects(state.climb)) stack.push(value);
  while (stack.depth > state.settle) stack.pop();

  return stack;
}

/** A pool of stacks, each brought to the given state. */
function poolIn(state: typeof STATES[number]): IndexTrackingStack[] {
  const out: IndexTrackingStack[] = [];

  for (let at = 0; at < POOL; at++) out.push(stackIn(state));

  return out;
}

/**
 * The oscillating cases, as the band a stack swings through: one that never
 * indexes, one that indexes and stays above `DROP_INDEX_BELOW`, and one that
 * crosses both marks on every swing.
 */
const BANDS = [
  {
    name: "below the threshold",
    floor: 0,
    ceiling: IndexTrackingStack.ADD_INDEX_AT - 8,
  },
  {
    name: "above the low mark",
    floor: IndexTrackingStack.ADD_INDEX_AT - 8,
    ceiling: IndexTrackingStack.ADD_INDEX_AT + 48,
  },
  {
    name: "across both marks",
    floor: IndexTrackingStack.DROP_INDEX_BELOW - 8,
    ceiling: IndexTrackingStack.ADD_INDEX_AT + 48,
  },
] as const;

/** How many operations one oscillating iteration performs. */
const SWING_OPS = 10240;

for (const band of BANDS) {
  const swing = band.ceiling - band.floor;

  Deno.bench({
    name: `oscillating ${band.name}`,
    group: "oscillating",
    baseline: band.name === "below the threshold",
  }, (b) => {
    const stack = new IndexTrackingStack();
    const batch = objects(band.ceiling);

    for (const value of batch.slice(0, band.floor)) stack.push(value);

    b.start();
    for (let done = 0; done < SWING_OPS; done += swing * 2) {
      for (let at = 0; at < swing; at++) stack.push(batch[band.floor + at]!);
      for (let at = 0; at < swing; at++) stack.pop();
    }
    b.end();
  });
}

for (const repeated of [false, true]) {
  const which = repeated ? "one object repeated" : "distinct objects";

  for (const state of STATES) {
    const baseline = state.name === "scanning";

    Deno.bench({
      name: `push, ${state.name}`,
      group: `push — ${which}`,
      baseline,
    }, (b) => {
      const pool = poolIn(state);
      const batch = batchOf(repeated);

      b.start();
      for (const stack of pool) {
        for (const value of batch) stack.push(value);
      }
      b.end();
    });

    Deno.bench({
      name: `pop, ${state.name}`,
      group: `pop — ${which}`,
      baseline,
    }, (b) => {
      const pool = poolIn(state);
      const batch = batchOf(repeated);

      for (const stack of pool) {
        for (const value of batch) stack.push(value);
      }

      b.start();
      for (const stack of pool) {
        for (let at = 0; at < BATCH; at++) stack.pop();
      }
      b.end();
    });
  }
}
