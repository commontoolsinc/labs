import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("lazy-materialization-runner");
const space = signer.did();

const ITEM: JSONSchema = {
  type: "object",
  required: ["label"],
  properties: { label: { type: "string" } },
} as const;

const ARGUMENT: JSONSchema = {
  type: "object",
  properties: {
    items: { type: "array", items: ITEM },
    title: { type: "string" },
  },
} as const;

describe("lazy-materialization-runner", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  const start = () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  };

  beforeEach(() => {
    storageManager = undefined as never;
    runtime = undefined as never;
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /**
   * Reads an argument through a marked or unmarked transaction and returns
   * the body's result.
   */
  const readArgument = async (
    cause: string,
    input: unknown,
    body: (argument: any) => unknown,
    lazy = true,
  ): Promise<unknown> => {
    const tx = runtime.edit();
    const inputCell = runtime.getCell(space, `${cause}-input`, undefined, tx);
    inputCell.set(input);
    await tx.commit();

    const readTx = runtime.edit();
    if (lazy) {
      readTx.markLazyMaterialize(true);
    }
    const argument = runtime
      .getCell(space, `${cause}-input`, ARGUMENT, readTx)
      .get();
    try {
      return body(argument);
    } finally {
      await readTx.commit();
    }
  };

  it("hands the body a value it can read like a plain object", async () => {
    start();
    const result = await readArgument(
      "plain",
      { items: [{ label: "a" }, { label: "b" }], title: "t" },
      (argument) => `${argument.title}:${argument.items.length}`,
    );
    expect(result).toBe("t:2");
  });

  it("agrees with an eager read on what the body sees", async () => {
    start();
    const eager = await readArgument(
      "agree",
      { items: [{ label: "a" }], title: "t" },
      (argument) => JSON.stringify(argument),
      false,
    );
    await runtime.dispose();
    await storageManager.close();

    start();
    const lazy = await readArgument(
      "agree",
      { items: [{ label: "a" }], title: "t" },
      (argument) => JSON.stringify(argument),
    );
    expect(lazy).toEqual(eager);
  });

  it("refuses when the body reaches an element the schema no longer describes", async () => {
    start();
    let refused = false;
    await readArgument(
      "refuse",
      // The second element is missing the `label` the item schema requires.
      { items: [{ label: "a" }, { note: "b" }], title: "t" },
      (argument) => {
        try {
          return argument.items[1].label;
        } catch {
          refused = true;
        }
      },
    );
    expect(refused).toBe(true);
  });

  it("lets the body run when the mismatch is in an element it never reaches", async () => {
    start();
    const result = await readArgument(
      "unreached",
      { items: [{ label: "a" }, { note: "b" }], title: "t" },
      (argument) => argument.items[0].label,
    );
    expect(result).toBe("a");
  });

  it("reads arguments through an unmarked transaction", async () => {
    start();
    const result = await readArgument(
      "unmarked",
      { items: [{ label: "a" }], title: "t" },
      (argument) => argument.title,
      false,
    );
    expect(result).toBe("t");
  });
});
