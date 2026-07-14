import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { DataUnavailable } from "@commonfabric/data-model/fabric-instances";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createBuilder } from "../src/builder/factory.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("latest complete test");
const space = signer.did();

const numberSchema = {
  type: "number",
} as const satisfies JSONSchema;

const joinedSchema = {
  type: "object",
  properties: {
    repo: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    ticket: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
    variable: { type: "number" },
  },
  required: ["repo", "ticket", "variable"],
  additionalProperties: false,
} as const satisfies JSONSchema;

describe("latestComplete", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let pattern: ReturnType<typeof createBuilder>["commonfabric"]["pattern"];
  let latestComplete: (
    input: { value: unknown; schema: JSONSchema },
  ) => unknown;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    const { commonfabric } = createTrustedBuilder(runtime);
    pattern = commonfabric.pattern;
    latestComplete = commonfabric
      .latestComplete as unknown as typeof latestComplete;
  });

  afterEach(async () => {
    if (tx.status().status === "ready") {
      runtime.prepareTxForCommit(tx);
      await tx.commit();
    }
    await runtime?.dispose();
    await storageManager?.close();
  });

  async function commitAndPull<T>(result: Cell<T>): Promise<void> {
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();
    await result.pull();
    await runtime.idle();
  }

  async function writeAndSettle<T>(
    source: Cell<T>,
    value: T,
    result: Cell<unknown>,
  ): Promise<void> {
    source.withTx(tx).set(value);
    await commitAndPull(result);
  }

  function raw(cell: Cell<unknown>): unknown {
    return cell.resolveAsCell().getRaw();
  }

  it("waits initially and retains the last complete scalar", async () => {
    const source = runtime.getCell<number | DataUnavailable>(
      space,
      "latest complete scalar source",
      undefined,
      tx,
    );
    source.set(DataUnavailable.pending());

    const Root = pattern<{ source: unknown }>(({ source }) => ({
      snapshot: latestComplete({ value: source, schema: numberSchema }),
    }));
    const result = runtime.run(
      tx,
      Root,
      { source: source.getAsLink() },
      runtime.getCell(space, "latest complete scalar result", undefined, tx),
    );

    await commitAndPull(result);
    expect(raw(result.key("snapshot"))).toBe(DataUnavailable.pending());

    await writeAndSettle(source, 1, result);
    expect(result.key("snapshot").get()).toBe(1);

    await writeAndSettle(source, DataUnavailable.pending(), result);
    expect(result.key("snapshot").get()).toBe(1);

    await writeAndSettle(
      source,
      DataUnavailable.error(new Error("refresh")),
      result,
    );
    expect(result.key("snapshot").get()).toBe(1);

    await writeAndSettle(source, 2, result);
    expect(result.key("snapshot").get()).toBe(2);
  });

  it("updates an object join only when every input is complete", async () => {
    const repo = runtime.getCell<unknown>(space, "latest repo", undefined, tx);
    const ticket = runtime.getCell<unknown>(
      space,
      "latest ticket",
      undefined,
      tx,
    );
    const variable = runtime.getCell<number>(
      space,
      "latest variable",
      undefined,
      tx,
    );
    repo.set({ name: "one", ignored: true });
    ticket.set(DataUnavailable.pending());
    variable.set(1);

    const Root = pattern<{
      repo: unknown;
      ticket: unknown;
      variable: number;
    }>(({ repo, ticket, variable }) => ({
      snapshot: latestComplete({
        value: { repo, ticket, variable },
        schema: joinedSchema,
      }),
    }));
    const result = runtime.run(
      tx,
      Root,
      {
        repo: repo.getAsLink(),
        ticket: ticket.getAsLink(),
        variable: variable.getAsLink(),
      },
      runtime.getCell(space, "latest joined result", undefined, tx),
    );

    await commitAndPull(result);
    expect(raw(result.key("snapshot"))).toBe(DataUnavailable.pending());

    await writeAndSettle(variable, 2, result);
    expect(raw(result.key("snapshot"))).toBe(DataUnavailable.pending());

    await writeAndSettle(ticket, { title: "ready", ignored: true }, result);
    expect(result.key("snapshot").get()).toEqual({
      repo: { name: "one" },
      ticket: { title: "ready" },
      variable: 2,
    });

    await writeAndSettle(ticket, DataUnavailable.syncing(), result);
    await writeAndSettle(repo, { name: "two" }, result);
    await writeAndSettle(variable, 3, result);
    expect(result.key("snapshot").get()).toEqual({
      repo: { name: "one" },
      ticket: { title: "ready" },
      variable: 2,
    });

    await writeAndSettle(ticket, { title: "next" }, result);
    expect(result.key("snapshot").get()).toEqual({
      repo: { name: "two" },
      ticket: { title: "next" },
      variable: 3,
    });
  });
});
