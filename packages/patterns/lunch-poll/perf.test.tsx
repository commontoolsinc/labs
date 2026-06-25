/**
 * Perf probe (not a correctness test): how does instantiating the poll scale
 * with option count? Joins as host (so the per-option image/search/LLM nodes
 * are actually built), then adds N options one at a time. The emulated runner
 * doesn't make real gateway calls, so the wall time here is pure
 * graph-instantiation + reactive-recompute cost — the suspected driver of the
 * "minutes to load" report, isolated from network latency.
 *
 * Vary OPTION_COUNT and compare the runner's reported suite time to see whether
 * the curve is linear (per-option work) or super-linear (each add rebuilding
 * all prior option cards => O(N^2)).
 */

import { action, computed, pattern } from "commonfabric";
import CozyPoll from "./main.tsx";

const OPTION_COUNT = 48;

export default pattern(() => {
  const poll = CozyPoll({});

  const join = action(() => {
    poll.joinAs.send({ name: "Host" });
  });

  const addOptions = Array(OPTION_COUNT).fill(0).map((_, i) =>
    action(() => {
      poll.addOption.send({ title: `Place ${i + 1}` });
    })
  );

  const assert_all_added = computed(() =>
    poll.options.length === OPTION_COUNT
  );

  return {
    tests: [
      { action: join },
      ...addOptions.map((a) => ({ action: a })),
      { assertion: assert_all_added },
    ],
  };
});
