import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { canonicalizeBoundaryActivity } from "../src/cfc/canonical-activity.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc cell getraw observation test",
);
const space = signer.did();

describe("CFC cell.getRaw observations", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  });

  it("records a whole-value observation for direct getRaw reads", () => {
    const cell = runtime.getCell<
      { error: { code: number; message: string; details: { reason: string } } }
    >(
      space,
      "cfc-cell-getraw-root",
      undefined,
      tx,
    );
    cell.set({
      error: {
        code: 403,
        message: "Denied",
        details: { reason: "scope-insufficient" },
      },
    });

    const beforeReads =
      canonicalizeBoundaryActivity(tx.journal.activity()).reads
        .length;

    expect(cell.getRaw()).toEqual({
      error: {
        code: 403,
        message: "Denied",
        details: { reason: "scope-insufficient" },
      },
    });

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .slice(beforeReads)
      .filter((read) => !read.internalVerifierRead);
    expect(reads.some((read) => read.path === "/" && read.op === "value")).toBe(
      true,
    );
    expect(reads.some((read) => read.path === "/" && read.op === "shape")).toBe(
      false,
    );
    expect(reads.some((read) => read.path.startsWith("/error/"))).toBe(false);
  });
});
