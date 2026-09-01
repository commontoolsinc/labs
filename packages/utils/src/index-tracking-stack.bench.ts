/**
 * What a push and a pop cost, across the three states the stack can be in and
 * with and without a repeated object in play.
 *
 * The states are what make this more than one figure. `IndexTrackingStack`
 * answers by scanning until it has been `INDEX_AT` entries tall, and from an
 * index after that -- and it keeps the index for the rest of its life. So a
 * stack that once went past the threshold and came back down is not the same
 * stack as one that never went up, at the same height, and the middle group
 * below is what prices that decision:
 *
 * | state | index | height while timed |
 * | --- | --- | --- |
 * | `scanning` | never built | below `INDEX_AT` |
 * | `crossed` | built, then descended | below `INDEX_AT` |
 * | `indexed` | built | above `INDEX_AT` |
 *
 * `scanning` and `crossed` do the same work at the same height and differ only
 * in which structure answers, so the gap between them is the price of keeping
 * the index. `indexed` is what a deep graph pays.
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

/** How far above `INDEX_AT` the indexed state sits. */
const ABOVE = 8;

/** How far below `INDEX_AT` the crossed state comes back down to. */
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

/** The three states, as the height a stack is brought to and how it got there. */
const STATES = [
  { name: "scanning", climb: 0, settle: 0 },
  {
    name: "crossed",
    climb: IndexTrackingStack.INDEX_AT + ABOVE,
    settle: BELOW,
  },
  {
    name: "indexed",
    climb: IndexTrackingStack.INDEX_AT + ABOVE,
    settle: IndexTrackingStack.INDEX_AT + ABOVE,
  },
] as const;

/** A stack brought to the given state, ready for a batch to be timed against. */
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
