/**
 * Unit tests for `sinkCellValue`, the subscription a long-lived caller takes
 * on one cell.
 *
 * What it adds over the sink underneath it is the settling: several fires make
 * one report, the value reported is the one the cell holds once the runtime is
 * quiet, and cancelling stops a report that was already being settled. So the
 * cases drive the fires and the settle separately — the runtime's `idle()` is
 * a promise the case resolves, which is what lets a fire land in the middle of
 * one without any wait on a clock.
 *
 * An injected controller stub is what lets all of that be asserted with no
 * live space.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { PiecesController } from "@commonfabric/piece/ops";

import { type PieceConfig, sinkCellValue } from "../lib/piece.ts";

const SPACE = "did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk";

const config: PieceConfig = {
  apiUrl: "http://localhost:8000",
  space: SPACE,
  identity: "/nonexistent/keyfile",
  piece: "fid1:watched-piece",
};

/** The runtime and the cell a case drives the subscription through. */
interface Driven {
  /** Every call the subscription made on the controller, in order. */
  readonly calls: string[];

  /** Fires the underlying sink, as a committed change does. */
  fire(): void;

  /** How many sinks are still subscribed. */
  subscribed: () => number;

  /**
   * Lets the runtime go quiet, and settles once the subscription has done
   * whatever the quiet made it do.
   *
   * The wait is on the settle itself rather than on a count of turns: the
   * promise a case resolves here is the one the subscription is waiting on, so
   * a reaction attached after the subscription's runs after it. Nothing here
   * is a clock, and a report that never comes leaves the assertion reading an
   * empty list rather than waiting for one.
   */
  quiet(): Promise<void>;

  /** Fails the settle the runtime is holding, on the same terms. */
  fails(reason: string): Promise<void>;

  /** What the cell holds, which a settled read comes back with. */
  holds(value: unknown): void;
}

/**
 * Helper for the cases below, which is a controller standing in for the
 * connection, and the handles a case drives it by.
 */
function driving(): { pieces: PiecesController; driven: Driven } {
  const calls: string[] = [];
  let fire: (() => void) | undefined;
  let subscribed = 0;
  let settling: PromiseWithResolvers<void> | undefined;
  let held: unknown = "before";
  const cell = {
    key: (...path: (string | number)[]) => {
      calls.push(`key ${path.join("/")}`);
      return cell;
    },
    get: () => held,
    sink: (callback: (value: unknown) => void) => {
      subscribed++;
      fire = () => callback(held);
      return () => {
        subscribed--;
        calls.push("cancel");
      };
    },
  };
  const pieces = {
    get: (id: string, runIt: boolean, _schema: unknown, scope?: string) => {
      calls.push(`get ${id} ${runIt} ${scope ?? "-"}`);
      return Promise.resolve({
        result: {
          getCell: () => {
            calls.push("result");
            return Promise.resolve(cell);
          },
        },
        input: {
          getCell: () => {
            calls.push("input");
            return Promise.resolve(cell);
          },
        },
      });
    },
    runtime: {
      idle: () => {
        calls.push("idle");
        settling ??= Promise.withResolvers<void>();
        return settling.promise;
      },
    },
  } as unknown as PiecesController;
  return {
    pieces,
    driven: {
      calls,
      fire: () => fire?.(),
      subscribed: () => subscribed,
      quiet: () => {
        const waiting = settling;
        settling = undefined;
        if (waiting === undefined) return Promise.resolve();
        const after = waiting.promise.then(() => {}, () => {});
        waiting.resolve();
        return after;
      },
      fails: (reason) => {
        const waiting = settling;
        settling = undefined;
        if (waiting === undefined) return Promise.resolve();
        const after = waiting.promise.then(() => {}, () => {});
        waiting.reject(new Error(reason));
        return after;
      },
      holds: (value) => {
        held = value;
      },
    },
  };
}

/** Helper for the cases below, which is the resolution a case stands in for. */
const RESOLVES = {
  resolvePieceReference: (
    _pieces: unknown,
    token: string,
    path: readonly (string | number)[],
  ) => Promise.resolve({ piece: token, pathAfter: [...path] }),
};

describe("sinkCellValue()", () => {
  it("reports the value once the runtime is quiet", async () => {
    const { pieces, driven } = driving();
    const reported: unknown[] = [];
    await sinkCellValue(
      config,
      ["title"],
      (value) => reported.push(value),
      {},
      {
        loadPieces: () => Promise.resolve(pieces),
        ...RESOLVES,
      },
    );
    driven.holds("settled");
    driven.fire();
    await driven.quiet();
    expect(reported).toEqual(["settled"]);
  });

  it("reports once for several fires that quiet together", async () => {
    // The whole of what the discipline buys. One logical change fires the
    // sink several times before the graph quiets, and a caller that saw each
    // of them would repaint on values that never stood still.

    const { pieces, driven } = driving();
    const reported: unknown[] = [];
    await sinkCellValue(config, [], (value) => reported.push(value), {}, {
      loadPieces: () => Promise.resolve(pieces),
      ...RESOLVES,
    });
    driven.holds("first");
    driven.fire();
    driven.holds("second");
    driven.fire();
    driven.holds("third");
    driven.fire();
    await driven.quiet();
    expect(reported).toEqual(["third"]);
  });

  it("reports again for a fire that arrives after the runtime went quiet", async () => {
    // The bound on the sentence above: two changes that quiet separately are
    // two reports, so folding is what a settle does and not what the sink
    // does forever after.

    const { pieces, driven } = driving();
    const reported: unknown[] = [];
    await sinkCellValue(config, [], (value) => reported.push(value), {}, {
      loadPieces: () => Promise.resolve(pieces),
      ...RESOLVES,
    });
    driven.holds("one");
    driven.fire();
    await driven.quiet();
    driven.holds("two");
    driven.fire();
    await driven.quiet();
    expect(reported).toEqual(["one", "two"]);
  });

  it("reports what the cell holds once quiet, not what the fire carried", async () => {
    // A cell passes through states that exist only until the scheduler
    // drains, and the value a sink hands its callback can be one of them.

    const { pieces, driven } = driving();
    const reported: unknown[] = [];
    await sinkCellValue(config, [], (value) => reported.push(value), {}, {
      loadPieces: () => Promise.resolve(pieces),
      ...RESOLVES,
    });
    driven.holds("part-way");
    driven.fire();
    driven.holds("settled");
    await driven.quiet();
    expect(reported).toEqual(["settled"]);
  });

  it("costs one report where a settle failed, and not every report after", async () => {
    const { pieces, driven } = driving();
    const reported: unknown[] = [];
    await sinkCellValue(config, [], (value) => reported.push(value), {}, {
      loadPieces: () => Promise.resolve(pieces),
      ...RESOLVES,
    });
    driven.fire();
    await driven.fails("the runtime threw");
    driven.holds("after the failure");
    driven.fire();
    await driven.quiet();
    expect(reported).toEqual(["after the failure"]);
  });

  it("walks to the path inside the piece the resolution reached", async () => {
    const { pieces, driven } = driving();
    await sinkCellValue(config, ["topics", 3], () => {}, {}, {
      loadPieces: () => Promise.resolve(pieces),
      ...RESOLVES,
    });
    expect(driven.calls).toEqual([
      `get ${config.piece} false -`,
      "result",
      "key topics/3",
    ]);
  });

  it("starts nothing, the start being the caller's own act", async () => {
    // A caller that watches several cells of one piece starts it once
    // (`warmPiece`), so this asks for the piece rather than for a run of it.

    const { pieces, driven } = driving();
    await sinkCellValue(config, [], () => {}, {}, {
      loadPieces: () => Promise.resolve(pieces),
      ...RESOLVES,
    });
    expect(driven.calls[0]).toBe(`get ${config.piece} false -`);
  });

  it("reads the piece at the scope the config names", async () => {
    const { pieces, driven } = driving();
    await sinkCellValue(
      { ...config, pieceScope: "session" },
      [],
      () => {},
      {},
      {
        loadPieces: () => Promise.resolve(pieces),
        ...RESOLVES,
      },
    );
    expect(driven.calls[0]).toBe(`get ${config.piece} false session`);
  });

  it("subscribes to the arguments cell under `input`", async () => {
    const { pieces, driven } = driving();
    await sinkCellValue(config, [], () => {}, { input: true }, {
      loadPieces: () => Promise.resolve(pieces),
      ...RESOLVES,
    });
    expect(driven.calls).toEqual([
      `get ${config.piece} false -`,
      "input",
      "key ",
    ]);
  });

  it("cancels the subscription underneath it", async () => {
    const { pieces, driven } = driving();
    const cancel = await sinkCellValue(config, [], () => {}, {}, {
      loadPieces: () => Promise.resolve(pieces),
      ...RESOLVES,
    });
    cancel();
    expect(driven.subscribed()).toBe(0);
  });

  it("reports nothing for a settle that was outstanding when it was cancelled", async () => {
    // The cancel is what a caller has to be able to trust: a lens closed while
    // a settle was in flight must not draw over the screen it gave back.

    const { pieces, driven } = driving();
    const reported: unknown[] = [];
    const cancel = await sinkCellValue(
      config,
      [],
      (value) => reported.push(value),
      {},
      { loadPieces: () => Promise.resolve(pieces), ...RESOLVES },
    );
    driven.fire();
    cancel();
    await driven.quiet();
    expect(reported).toEqual([]);
  });

  it("cancels once however many times the cancel is called", async () => {
    // A lens closed by a key and then again by the run ending calls it twice,
    // and a second cancel reaching the sink underneath is a call on a
    // subscription that is not there.

    const { pieces, driven } = driving();
    const cancel = await sinkCellValue(config, [], () => {}, {}, {
      loadPieces: () => Promise.resolve(pieces),
      ...RESOLVES,
    });
    cancel();
    cancel();
    expect(driven.calls.filter((call) => call === "cancel").length).toBe(1);
  });
});
