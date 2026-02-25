import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("cfc scheduler prepare shim test");
const space = signer.did();

const ifcNumberSchema: JSONSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
};

describe("CFC scheduler prepare shim", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    runtime.scheduler.disablePullMode();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("commits reactive action with IFC-relevant read/write via prepare shim", async () => {
    let tx = runtime.edit();
    const input = runtime.getCell<number>(space, "cfc-prepare-input", undefined, tx);
    const output = runtime.getCell<number>(space, "cfc-prepare-output", undefined, tx);
    input.set(1);
    output.set(0);
    await tx.commit();

    const action = (actionTx: IExtendedStorageTransaction) => {
      const value = Number(
        input.withTx(actionTx).asSchema(ifcNumberSchema).get() ?? 0,
      );
      output.withTx(actionTx).set(value + 1);
    };

    await runtime.scheduler.run(action);
    for (let attempt = 0; attempt < 20; attempt++) {
      await output.pull();
      if (output.get() === 2) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(output.get()).toBe(2);
  });

  it("commits event handler path with IFC-relevant read/write via prepare shim", async () => {
    let tx = runtime.edit();
    const eventCell = runtime.getCell<number>(space, "cfc-prepare-event", undefined, tx);
    const sourceCell = runtime.getCell<number>(space, "cfc-prepare-source", undefined, tx);
    const resultCell = runtime.getCell<number>(space, "cfc-prepare-result", undefined, tx);
    eventCell.set(0);
    sourceCell.set(5);
    resultCell.set(0);
    await tx.commit();

    runtime.scheduler.addEventHandler(
      (handlerTx, _event) => {
        const source = Number(
          sourceCell.withTx(handlerTx).asSchema(ifcNumberSchema).get() ?? 0,
        );
        resultCell.withTx(handlerTx).set(source + 10);
      },
      eventCell.getAsNormalizedFullLink(),
    );

    await new Promise<void>((resolve, reject) => {
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
        undefined,
        (commitTx) => {
          const status = commitTx.status().status;
          if (status === "error") {
            reject(new Error("event handler commit failed"));
            return;
          }
          resolve();
        },
      );
    });
    await resultCell.pull();

    expect(resultCell.get()).toBe(15);
  });

  it("retries event handler attempts and still commits through prepare shim", async () => {
    let tx = runtime.edit();
    const eventCell = runtime.getCell<number>(space, "cfc-prepare-retry-event", undefined, tx);
    const sourceCell = runtime.getCell<number>(space, "cfc-prepare-retry-source", undefined, tx);
    const resultCell = runtime.getCell<number>(space, "cfc-prepare-retry-result", undefined, tx);
    eventCell.set(0);
    sourceCell.set(7);
    resultCell.set(0);
    await tx.commit();

    let attempts = 0;
    let callbackStatus: string | undefined;

    runtime.scheduler.addEventHandler(
      (handlerTx, _event) => {
        attempts++;
        const source = Number(
          sourceCell.withTx(handlerTx).asSchema(ifcNumberSchema).get() ?? 0,
        );
        if (attempts === 1) {
          resultCell.withTx(handlerTx).set(source + 1);
          handlerTx.abort("intentional-first-attempt-failure");
          return;
        }
        resultCell.withTx(handlerTx).set(source + 20);
      },
      eventCell.getAsNormalizedFullLink(),
    );

    await new Promise<void>((resolve) => {
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
        1,
        (commitTx) => {
          callbackStatus = commitTx.status().status;
          resolve();
        },
      );
    });
    await resultCell.pull();

    expect(attempts).toBe(2);
    expect(callbackStatus).toBe("done");
    expect(resultCell.get()).toBe(27);
  });
});
