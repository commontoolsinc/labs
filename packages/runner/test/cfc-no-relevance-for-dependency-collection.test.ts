import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase(
  "cfc dependency collection no-prepare requirement",
);
const space = signer.did();

const ifcNumberSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

describe("CFC dependency collection transactions", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    runtime.scheduler.enablePullMode();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("does not require prepare for read-only relevant dependency collection commits", async () => {
    let tx = runtime.edit();
    const eventCell = runtime.getCell<number>(
      space,
      "cfc-no-prepare-dependency-event",
      undefined,
      tx,
    );
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-no-prepare-dependency-source",
      undefined,
      tx,
    );
    const resultCell = runtime.getCell<number>(
      space,
      "cfc-no-prepare-dependency-result",
      undefined,
      tx,
    );
    eventCell.set(0);
    sourceCell.set(9);
    resultCell.set(0);
    const seeded = await tx.commit();
    expect(seeded.error).toBeUndefined();

    const originalEdit = runtime.edit.bind(runtime);
    const readOnlyRelevantCommitErrors: Array<string | undefined> = [];
    let captureCommits = false;
    const runtimeWithMutableEdit = runtime as Runtime & {
      edit: Runtime["edit"];
    };
    runtimeWithMutableEdit.edit = () => {
      const editedTx = originalEdit();
      const originalCommit = editedTx.commit.bind(editedTx);
      editedTx.commit = async () => {
        const result = await originalCommit();
        if (captureCommits && editedTx.cfcRelevant) {
          const hasWrite = [...editedTx.journal.activity()].some((activity) =>
            "write" in activity && Boolean(activity.write)
          );
          if (!hasWrite) {
            readOnlyRelevantCommitErrors.push(result.error?.name);
          }
        }
        return result;
      };
      return editedTx;
    };

    runtime.scheduler.addEventHandler(
      (handlerTx, _event) => {
        const source = Number(
          sourceCell.withTx(handlerTx).asSchema(ifcNumberSchema).get() ?? 0,
        );
        resultCell.withTx(handlerTx).set(source + 1);
      },
      eventCell.getAsNormalizedFullLink(),
      (depTx, _event) => {
        sourceCell.withTx(depTx).asSchema(ifcNumberSchema).get();
      },
    );

    captureCommits = true;
    await new Promise<void>((resolve, reject) => {
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
        undefined,
        (commitTx) => {
          const status = commitTx.status();
          if (status.status === "error") {
            reject(new Error(`event commit failed: ${status.error?.name}`));
            return;
          }
          resolve();
        },
      );
    });
    captureCommits = false;
    runtimeWithMutableEdit.edit = originalEdit;

    await resultCell.pull();
    expect(resultCell.get()).toBe(10);
    expect(readOnlyRelevantCommitErrors.length).toBeGreaterThan(0);
    expect(readOnlyRelevantCommitErrors).toEqual([undefined]);
  });
});
