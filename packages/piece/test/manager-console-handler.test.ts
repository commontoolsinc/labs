import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  type Cell,
  type ConsoleMessage,
  ConsoleMethod,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createSession, Identity } from "@commonfabric/identity";
import { PieceManager } from "../src/manager.ts";

const signer = await Identity.fromPassphrase(
  "piece manager console handler tests",
);

describe("PieceManager runtime diagnostics", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;
  let messages: ConsoleMessage[];

  beforeEach(async () => {
    messages = [];
    storageManager = StorageManager.emulate({ as: signer });
    const outputSink = {
      debug: () => {},
    } as unknown as Console;
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      consoleHandler: (message) => {
        messages.push(message);
        return {
          method: message.method,
          args: message.args,
          target: outputSink,
        };
      },
    });
    const session = await createSession({
      identity: signer,
      spaceName: `manager-console-${crypto.randomUUID()}`,
    });
    manager = new PieceManager(session, runtime);
    await manager.ready;

    Object.defineProperty(manager, "getPieceRegistry", {
      configurable: true,
      value: () =>
        Promise.resolve({
          get: () => [],
        } as unknown as Cell<Cell<unknown>[]>),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("sends argument read failures to the runtime console handler", async () => {
    const failure = new Error("argument read failed");
    const argumentCell = {
      getRaw: () => {
        throw failure;
      },
    } as unknown as Cell<unknown>;
    Object.defineProperty(manager, "getArgument", {
      configurable: true,
      value: () => argumentCell,
    });
    const piece = {
      resolveAsCell() {
        return this;
      },
    } as unknown as Cell<unknown>;

    assertEquals(await manager.getReadingFrom(piece), []);
    assertEquals(messages.length, 1);
    assertStrictEquals(messages[0].method, ConsoleMethod.Debug);
    assertStrictEquals(messages[0].args[0], "Error getting argument value:");
    assertStrictEquals(messages[0].args[1], failure);
  });

  it("sends argument lookup failures to the runtime console handler", async () => {
    const failure = new Error("argument lookup failed");
    Object.defineProperty(manager, "getArgument", {
      configurable: true,
      value: () => {
        throw failure;
      },
    });
    const piece = {
      resolveAsCell() {
        return this;
      },
    } as unknown as Cell<unknown>;

    assertEquals(await manager.getReadingFrom(piece), []);
    assertEquals(messages.length, 1);
    assertStrictEquals(messages[0].method, ConsoleMethod.Debug);
    assertStrictEquals(
      messages[0].args[0],
      "Error finding references in piece arguments:",
    );
    assertStrictEquals(messages[0].args[1], failure);
  });

  it("sends array traversal failures to the runtime console handler", async () => {
    const failure = new Error("array element read failed");
    const argumentValue: unknown[] = [];
    Object.defineProperty(argumentValue, 0, {
      enumerable: true,
      get: () => {
        throw failure;
      },
    });
    const argumentCell = {
      getRaw: () => argumentValue,
    } as unknown as Cell<unknown>;
    Object.defineProperty(manager, "getArgument", {
      configurable: true,
      value: () => argumentCell,
    });
    const piece = {
      resolveAsCell() {
        return this;
      },
    } as unknown as Cell<unknown>;

    assertEquals(await manager.getReadingFrom(piece), []);
    assertEquals(messages.length, 1);
    assertStrictEquals(messages[0].method, ConsoleMethod.Debug);
    assertStrictEquals(
      messages[0].args[0],
      "Error processing array item at index 0:",
    );
    assertStrictEquals(messages[0].args[1], failure);
  });

  it("sends object traversal failures to the runtime console handler", async () => {
    const failure = new Error("object property read failed");
    const argumentValue = {};
    Object.defineProperty(argumentValue, "broken", {
      enumerable: true,
      get: () => {
        throw failure;
      },
    });
    const argumentCell = {
      getRaw: () => argumentValue,
    } as unknown as Cell<unknown>;
    Object.defineProperty(manager, "getArgument", {
      configurable: true,
      value: () => argumentCell,
    });
    const piece = {
      resolveAsCell() {
        return this;
      },
    } as unknown as Cell<unknown>;

    assertEquals(await manager.getReadingFrom(piece), []);
    assertEquals(messages.length, 1);
    assertStrictEquals(messages[0].method, ConsoleMethod.Debug);
    assertStrictEquals(
      messages[0].args[0],
      "Error processing object property 'broken':",
    );
    assertStrictEquals(messages[0].args[1], failure);
  });

  it("sends result-link traversal failures to the runtime console handler", async () => {
    const argumentCell = runtime.getCell(
      manager.getSpace(),
      "diagnostic-argument",
    );
    const linkedCell = runtime.getCell(
      manager.getSpace(),
      "diagnostic-result",
    );
    const tx = runtime.edit();
    argumentCell.withTx(tx).setRawUntyped(linkedCell.getAsLink());
    assertEquals((await tx.commit()).error, undefined);

    Object.defineProperty(manager, "getArgument", {
      configurable: true,
      value: () => argumentCell,
    });
    const failure = new Error("result metadata read failed");
    const malformedResultCell = {
      entityId: linkedCell.entityId,
      getMetaRaw: () => {
        throw failure;
      },
    } as unknown as Cell<unknown>;
    Object.defineProperty(runtime, "getCellFromLink", {
      configurable: true,
      value: () => malformedResultCell,
    });
    const piece = {
      resolveAsCell() {
        return this;
      },
    } as unknown as Cell<unknown>;

    assertEquals(await manager.getReadingFrom(piece), []);
    assertEquals(messages.length, 1);
    assertStrictEquals(messages[0].method, ConsoleMethod.Debug);
    assertStrictEquals(messages[0].args[0], "Error getting doc value:");
    assertStrictEquals(messages[0].args[1], failure);
  });
});
