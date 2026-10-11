import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { defer } from "@commonfabric/utils/defer";

import { type Cell, sendEvent } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase(
  "scheduler event start map handler",
);
const space = signer.did();

const RESULT_CAUSE = "scheduler-event-start-map-handler result";

// One handler, bound twice: once per row inside a `.map`, and once at the top
// level of the pattern. Each binding adds its own amount to `total`.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { Cell, Default, handler, pattern } from 'commonfabric';",
      "",
      "interface Row { amount: number }",
      "",
      "interface Input {",
      "  rows: Row[] | Default<[]>;",
      "  total: number | Default<0>;",
      "}",
      "",
      "const add = handler<unknown, { total: Cell<number>; amount: number }>(",
      "  (_event, { total, amount }) => {",
      "    total.set(total.get() + amount);",
      "  },",
      ");",
      "",
      "export default pattern<Input, any>(({ rows, total }) => {",
      "  const rowButtons = rows.map((row) => ({",
      "    add: add({ total, amount: row.amount }),",
      "  }));",
      "  return { total, rowButtons, addTen: add({ total, amount: 10 }) };",
      "});",
    ].join("\n"),
  }],
};

type Result = { total: number };

describe("scheduler-event-start-map-handler", () => {
  // Every case runs the pattern over two rows in one runtime, persists it, and
  // then works in a second runtime over a replica of its own, where the piece
  // is not running: the state a new session starts from.

  let server: MemoryV2Server.Server;
  const storageManagers: EmulatedStorageManager[] = [];
  const runtimes: Runtime[] = [];

  const newRuntime = () => {
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    storageManagers.push(storageManager);
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtimes.push(runtime);
    return runtime;
  };

  beforeEach(() => {
    server = new MemoryV2Server.Server(TEST_MEMORY_SERVER_AUTH);
  });

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.dispose();
    for (const manager of storageManagers.splice(0)) await manager.close();
    await server?.close();
  });

  /**
   * Runs the pattern in one runtime and persists it, then returns its result
   * cell as read by a fresh runtime that has not started the piece.
   */
  async function persistedPieceInFreshRuntime(): Promise<{
    runtime: Runtime;
    result: Cell<Result>;
  }> {
    const first = newRuntime();
    const tx = first.edit();
    const compiled = await first.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
    const running = first.run(
      tx,
      compiled,
      { rows: [{ amount: 1 }, { amount: 2 }] },
      first.getCell<Result>(space, RESULT_CAUSE, undefined, tx),
    );
    await tx.commit().settled;
    await running.pull();
    await first.idle();
    await first.patternManager.flushCompileCacheWrites();
    await first.storageManager.synced();
    await first.dispose();

    const runtime = newRuntime();
    const result = runtime.getCell<Result>(space, RESULT_CAUSE);
    await result.sync();
    return { runtime, result };
  }

  /**
   * Resolves `path` from `result` to the cell it ends at, loading each
   * document along the way, as a view rendering the stored result does.
   */
  async function cellAt(
    result: Cell<Result>,
    path: readonly (string | number)[],
  ): Promise<Cell<unknown>> {
    // deno-lint-ignore no-explicit-any
    let cell: Cell<any> = result;
    for (const key of path) {
      await cell.sync();
      cell = cell.key(key).resolveAsCell();
    }
    await cell.sync();
    return cell;
  }

  /**
   * Sends one event to `stream` and returns how it settled: `"done"` when its
   * handler committed, and otherwise the reason it was refused or dropped.
   */
  function sendAndSettle(stream: Cell<unknown>): Promise<string> {
    const settled = defer<IExtendedStorageTransaction>();
    sendEvent(stream, {}, (tx) => settled.resolve(tx));
    return outcomeOf(settled.promise);
  }

  /**
   * Queues one event at `cell`'s address, which need not be a stream, and
   * returns how it settled, as {@link sendAndSettle} does.
   */
  function queueAndSettle(
    runtime: Runtime,
    cell: Cell<unknown>,
  ): Promise<string> {
    const settled = defer<IExtendedStorageTransaction>();
    runtime.scheduler.queueEvent(
      cell.getAsNormalizedFullLink(),
      {},
      undefined,
      (tx) => settled.resolve(tx),
    );
    return outcomeOf(settled.promise);
  }

  /**
   * Helper for {@link sendAndSettle} and {@link queueAndSettle}, which reads
   * the outcome off the transaction an event settled on.
   */
  async function outcomeOf(
    settled: Promise<IExtendedStorageTransaction>,
  ): Promise<string> {
    const status = (await settled).status();
    if (status.status !== "error") return status.status;
    const { error } = status;
    return "reason" in error && error.reason instanceof Error
      ? error.reason.message
      : error.message;
  }

  /**
   * Returns the piece's `total`. It reads that field alone, so a read made
   * partway through a case demands nothing of the map.
   */
  async function totalOf(runtime: Runtime, result: Cell<Result>) {
    const total = result.key("total");
    await total.pull();
    await runtime.idle();
    return total.get();
  }

  describe("a top-level handler", () => {
    it("runs on the event that starts its piece", async () => {
      const { runtime, result } = await persistedPieceInFreshRuntime();

      const outcome = await sendAndSettle(await cellAt(result, ["addTen"]));

      expect(outcome).toBe("done");
      expect(await totalOf(runtime, result)).toBe(10);
    });
  });

  describe("a handler a map makes", () => {
    // Every event in this group goes to the handler bound for the second row,
    // through a link resolved before the map has run in this runtime. Each
    // send lets the scheduler start the piece when no handler is registered
    // for the stream, so a drop reported here comes from that start path.

    describe("in a piece a live view reads", () => {
      // A view rendering the piece holds a live read of the map's output, and
      // rendering it does not start the piece.

      it("runs on the first event to the piece, which starts it", async () => {
        const { runtime, result } = await persistedPieceInFreshRuntime();
        const rowStream = await cellAt(result, ["rowButtons", 1, "add"]);
        const cancelView = result.key("rowButtons").sink(() => {});
        await runtime.idle();

        const outcome = await sendAndSettle(rowStream);
        cancelView();

        expect(outcome).toBe("done");
        expect(await totalOf(runtime, result)).toBe(2);
      });

      it("runs on a second event, once the runtime has settled after the first", async () => {
        // The first send is the case above, and its outcome is not what this
        // one checks. Once the first event has started the piece, the view's
        // read is demand enough for the map to run and bind the handler, so
        // the same event sent again is delivered.

        const { runtime, result } = await persistedPieceInFreshRuntime();
        const rowStream = await cellAt(result, ["rowButtons", 1, "add"]);
        const cancelView = result.key("rowButtons").sink(() => {});
        await runtime.idle();
        await sendAndSettle(rowStream);
        await runtime.idle();
        const before = await totalOf(runtime, result);

        const outcome = await sendAndSettle(rowStream);
        cancelView();

        expect(outcome).toBe("done");
        expect(await totalOf(runtime, result)).toBe(before + 2);
      });
    });

    describe("in a piece nothing reads", () => {
      // A sender with no view of the piece (a command line, an agent, another
      // piece's handler) sends with nothing demanding the map's output.

      it("runs on the event that starts its piece", async () => {
        const { runtime, result } = await persistedPieceInFreshRuntime();
        const rowStream = await cellAt(result, ["rowButtons", 1, "add"]);

        const outcome = await sendAndSettle(rowStream);

        expect(outcome).toBe("done");
        expect(await totalOf(runtime, result)).toBe(2);
      });

      it("runs on an event to its started piece once the runtime has settled", async () => {
        // The runtime has settled with the piece started, so no run is still
        // under way when the event arrives.

        const { runtime, result } = await persistedPieceInFreshRuntime();
        const rowStream = await cellAt(result, ["rowButtons", 1, "add"]);
        expect(await runtime.start(result)).toBe(true);
        await runtime.idle();

        const outcome = await sendAndSettle(rowStream);

        expect(outcome).toBe("done");
        expect(await totalOf(runtime, result)).toBe(2);
      });

      it("runs on an event to its started piece once something has read the map", async () => {
        // The control for the case above, differing from it only in the read:
        // demanding the map's output once is when the map runs and binds the
        // handler for each row.

        const { runtime, result } = await persistedPieceInFreshRuntime();
        const rowStream = await cellAt(result, ["rowButtons", 1, "add"]);
        expect(await runtime.start(result)).toBe(true);
        await result.key("rowButtons").pull();
        await runtime.idle();

        const outcome = await sendAndSettle(rowStream);

        expect(outcome).toBe("done");
        expect(await totalOf(runtime, result)).toBe(2);
      });
    });
  });

  describe("an address in the piece that no handler serves", () => {
    it("drops its event", async () => {
      // The negative of the cases above. The row itself is in the piece, and
      // nothing binds a handler to it, so its event settles as a drop rather
      // than waiting, whatever the piece goes on to run.

      const { runtime, result } = await persistedPieceInFreshRuntime();
      const row = await cellAt(result, ["rowButtons", 1]);

      const outcome = await queueAndSettle(runtime, row);

      expect(outcome).toContain(
        `Event dropped: no handler registered for ${row.getAsNormalizedFullLink().id}`,
      );
      expect(await totalOf(runtime, result)).toBe(0);
    });
  });
});
