import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("cfc relevance test");
const space = signer.did();

const ifcNumberSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const plainNumberSchema = {
  type: "number",
} as const satisfies JSONSchema;

describe("CFC relevance detection", () => {
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

  it("marks tx relevant when reading through link with IFC schema", async () => {
    let tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-relevance-link-source",
      undefined,
      tx,
    );
    const aliasCell = runtime.getCell<number>(
      space,
      "cfc-relevance-link-alias",
      undefined,
      tx,
    );
    sourceCell.set(7);
    aliasCell.set(sourceCell);
    const seeded = await tx.commit();
    expect(seeded.error).toBeUndefined();

    tx = runtime.edit();
    const readValue = aliasCell.withTx(tx).asSchema(ifcNumberSchema).get();
    expect(readValue).toBe(7);
    expect(tx.cfcRelevant).toBe(true);
    tx.abort("test-complete");
  });

  it("does not mark tx relevant on plain schema read without IFC labels", async () => {
    let tx = runtime.edit();
    const plainCell = runtime.getCell<number>(
      space,
      "cfc-relevance-plain-read",
      undefined,
      tx,
    );
    plainCell.set(3);
    const seeded = await tx.commit();
    expect(seeded.error).toBeUndefined();

    tx = runtime.edit();
    const value = plainCell.withTx(tx).asSchema(plainNumberSchema).get();
    expect(value).toBe(3);
    expect(tx.cfcRelevant).toBe(false);
    tx.abort("test-complete");
  });

  it("marks tx relevant on write-only IFC target path", async () => {
    const tx = runtime.edit();
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-relevance-write-only",
      undefined,
      tx,
    );
    targetCell.withTx(tx).asSchema(ifcNumberSchema).set(11);
    expect(tx.cfcRelevant).toBe(true);
    tx.abort("test-complete");
  });

  it("marks tx relevant from persisted effective labels even without IFC schema", async () => {
    let tx = runtime.edit();
    const labeledCell = runtime.getCell<number>(
      space,
      "cfc-relevance-effective-label",
      undefined,
      tx,
    );
    labeledCell.set(5);
    tx.writeOrThrow({
      space,
      id: labeledCell.getAsNormalizedFullLink().id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/": {
        classification: ["secret"],
      },
    });
    const seeded = await tx.commit();
    expect(seeded.error).toBeUndefined();

    tx = runtime.edit();
    const value = labeledCell.withTx(tx).asSchema(plainNumberSchema).get();
    expect(value).toBe(5);
    expect(tx.cfcRelevant).toBe(true);
    expect(tx.cfcReasons).toContain("ifc-read-effective-label");
    tx.abort("test-complete");
  });

  it("does not require prepare for read-only relevant dependency collection commits", async () => {
    runtime.scheduler.enablePullMode();

    let tx = runtime.edit();
    const eventCell = runtime.getCell<number>(
      space,
      "cfc-relevance-dependency-event",
      undefined,
      tx,
    );
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-relevance-dependency-source",
      undefined,
      tx,
    );
    const resultCell = runtime.getCell<number>(
      space,
      "cfc-relevance-dependency-result",
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
            reject(
              new Error(
                `event commit failed: ${status.error?.name}`,
              ),
            );
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
