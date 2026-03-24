import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { markCfcRelevantForEffectiveLabels } from "../src/cfc/relevance.ts";

const signer = await Identity.fromPassphrase(
  "cfc relevance from static descendant read",
);
const space = signer.did();

describe("CFC relevance from static descendant read", () => {
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

  it("marks tx relevant when a descendant value observation is labeled", async () => {
    let tx = runtime.edit();
    const labeledCell = runtime.getCell<{ items: number[] }>(
      space,
      "cfc-relevance-static-descendant-read",
      undefined,
      tx,
    );
    labeledCell.set({ items: [5] });
    tx.writeOrThrow({
      space,
      id: labeledCell.getAsNormalizedFullLink().id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/items/*": {
        value: {
          classification: ["secret-item"],
        },
      },
    });
    const seeded = await tx.commit();
    expect(seeded.error).toBeUndefined();

    tx = runtime.edit();
    markCfcRelevantForEffectiveLabels(
      tx,
      {
        space,
        id: labeledCell.getAsNormalizedFullLink().id,
        type: "application/json",
        path: ["items", "0"],
      },
      "ifc-read-effective-label",
      "value",
    );
    expect(tx.cfcRelevant).toBe(true);
    expect(tx.cfcReasons).toContain("ifc-read-effective-label");
    tx.abort("test-complete");
  });

  it("does not mark tx relevant from parent enumeration labels alone", async () => {
    let tx = runtime.edit();
    const labeledCell = runtime.getCell<{ items: number[] }>(
      space,
      "cfc-relevance-static-descendant-vs-enumeration",
      undefined,
      tx,
    );
    labeledCell.set({ items: [5] });
    tx.writeOrThrow({
      space,
      id: labeledCell.getAsNormalizedFullLink().id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/items": {
        iterate: {
          order: {
            classification: ["secret-enumeration"],
          },
        },
      },
    });
    const seeded = await tx.commit();
    expect(seeded.error).toBeUndefined();

    tx = runtime.edit();
    markCfcRelevantForEffectiveLabels(
      tx,
      {
        space,
        id: labeledCell.getAsNormalizedFullLink().id,
        type: "application/json",
        path: ["items", "0"],
      },
      "ifc-read-effective-label",
      "value",
    );
    expect(tx.cfcRelevant).toBe(false);
    expect(tx.cfcReasons).not.toContain("ifc-read-effective-label");
    tx.abort("test-complete");
  });
});
