// The watermark surface (server-execution v2 stage F, protocol.md §4;
// testing.md §3): W(space) is ONE integer per space — the highest seq
// such that every authored commit ≤ W has all handler consequences
// committed AND all DEMANDED derivations current through W. It rides
// every derived commit's metadata (`derivedThrough`) and one well-known
// SPACE-scoped doc per space, updated inside the same transaction as
// derived commits — never its own commit. `waitForSettled` is the
// polling replacement testing.md §3 binds integration tests to:
// "settled" for a client = W ≥ seq(its last authored commit).

import {
  SERVER_EXECUTION_WATERMARK_DOC_ID,
  type WatermarkDocValue,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import type { Runtime } from "../runtime.ts";
import type { Cell } from "../cell.ts";
import type { MemorySpace } from "../storage/interface.ts";
import type { NormalizedFullLink } from "../link-utils.ts";

export { SERVER_EXECUTION_WATERMARK_DOC_ID };

/** The watermark doc's normalized link: the well-known id, the space
 * instance (`scope_key = "space"` — protocol.md §4 states it so no one
 * infers it), the whole-document path. */
export const watermarkDocLink = (space: MemorySpace): NormalizedFullLink => ({
  space,
  id: SERVER_EXECUTION_WATERMARK_DOC_ID as NormalizedFullLink["id"],
  scope: "space",
  path: [],
});

export const watermarkCell = (
  runtime: Runtime,
  space: MemorySpace,
): Cell<WatermarkDocValue> =>
  runtime.getCellFromLink<WatermarkDocValue>(watermarkDocLink(space));

/**
 * Read W directly from the engine (the serving loop's activation read —
 * serving-loop.md §3: "W = read watermark doc (0 if absent)"). Direct
 * engine read on the co-hosted plane; clients read the same doc through
 * their ordinary subscription instead.
 */
export const readWatermarkSeq = (engine: Engine.Engine): number => {
  const state = Engine.readState(engine, {
    id: SERVER_EXECUTION_WATERMARK_DOC_ID as Parameters<
      typeof Engine.readState
    >[1]["id"],
  });
  const value = state?.document?.value as WatermarkDocValue | undefined;
  return typeof value?.seq === "number" ? value.seq : 0;
};

/**
 * Resolve when the space's watermark reaches `seq` (testing.md §3's
 * `waitForSettled(space, seq)`): the poll-loop replacement — integration
 * tests MUST use this instead of text-polling for "server done". Rides
 * the ordinary subscription path: the helper subscribes to the watermark
 * doc and resolves on the first value with `W ≥ seq`.
 */
export const waitForSettled = (
  runtime: Runtime,
  space: MemorySpace,
  seq: number,
  options: { timeoutMs?: number } = {},
): Promise<number> => {
  const cell = watermarkCell(runtime, space);
  return new Promise<number>((resolve, reject) => {
    let cancel: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: number) => {
      if (timer !== undefined) clearTimeout(timer);
      cancel?.();
      resolve(value);
    };
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        cancel?.();
        reject(
          new Error(
            `waitForSettled(${space}, ${seq}) timed out after ` +
              `${options.timeoutMs}ms (watermark W < ${seq})`,
          ),
        );
      }, options.timeoutMs);
    }
    cancel = cell.sink((value) => {
      const current = typeof value?.seq === "number" ? value.seq : 0;
      if (current >= seq) settle(current);
    });
  });
};
