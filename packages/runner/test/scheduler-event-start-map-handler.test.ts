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
   * Resolves `path` from `result` to the stream it ends at, loading each
   * document along the way, as a view rendering the stored result does.
   */
  async function streamAt(
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
      true,
      (tx) => settled.resolve(tx),
    );
    return outcomeOf(settled.promise);
  }

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

  async function totalOf(runtime: Runtime, result: Cell<Result>) {
    await result.pull();
    await runtime.idle();
    return result.get().total;
  }

  describe("a top-level handler", () => {
    it("runs on the event that starts its piece", async () => {
      const { runtime, result } = await persistedPieceInFreshRuntime();

      const outcome = await sendAndSettle(await streamAt(result, ["addTen"]));

      expect(outcome).toBe("done");
      expect(await totalOf(runtime, result)).toBe(10);
    });
  });

  describe("a handler a map makes", () => {
    it("runs on the event that starts its piece", async () => {
      const { runtime, result } = await persistedPieceInFreshRuntime();

      const outcome = await sendAndSettle(
        await streamAt(result, ["rowButtons", 1, "add"]),
      );

      expect(outcome).toBe("done");
      expect(await totalOf(runtime, result)).toBe(2);
    });

    it("runs on an event to its running piece before anything reads the map", async () => {
      const { runtime, result } = await persistedPieceInFreshRuntime();
      const rowStream = await streamAt(result, ["rowButtons", 1, "add"]);
      expect(await sendAndSettle(await streamAt(result, ["addTen"])))
        .toBe("done");

      const outcome = await sendAndSettle(rowStream);

      expect(outcome).toBe("done");
      expect(await totalOf(runtime, result)).toBe(12);
    });

    it("runs on an event to its running piece once something has read the map", async () => {
      // The control for the two cases above: the same send succeeds once the
      // map's output has been demanded, which is when the map runs and binds
      // the handler for each row.

      const { runtime, result } = await persistedPieceInFreshRuntime();
      const rowStream = await streamAt(result, ["rowButtons", 1, "add"]);
      expect(await runtime.start(result)).toBe(true);
      await result.key("rowButtons").pull();
      await runtime.idle();

      const outcome = await sendAndSettle(rowStream);

      expect(outcome).toBe("done");
      expect(await totalOf(runtime, result)).toBe(2);
    });
  });

  describe("an address in the piece that no handler serves", () => {
    it("drops its event once the piece has run", async () => {
      // The negative of the cases above: demanding the piece's computations
      // for an event is bounded by their running, so an address none of them
      // binds a handler to still settles as a drop rather than waiting.

      const { runtime, result } = await persistedPieceInFreshRuntime();
      const row = await streamAt(result, ["rowButtons", 1]);

      const outcome = await queueAndSettle(runtime, row);

      expect(outcome).toBe(
        `Event dropped: no handler registered for ${row.getAsNormalizedFullLink().id} after its piece ran`,
      );
      expect(await totalOf(runtime, result)).toBe(0);
    });
  });
});
