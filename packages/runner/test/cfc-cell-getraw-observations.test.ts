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

  it("records a whole-value observation before object update merges", () => {
    const cell = runtime.getCell<{ profile: { name: string; role: string } }>(
      space,
      "cfc-cell-update-root",
      undefined,
      tx,
    );
    cell.set({ profile: { name: "Ada", role: "admin" } });

    const beforeReads =
      canonicalizeBoundaryActivity(tx.journal.activity()).reads
        .length;

    cell.update({ profile: { role: "operator" } } as any);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .slice(beforeReads)
      .filter((read) => !read.internalVerifierRead);
    expect(reads.some((read) => read.path === "/" && read.op === "value")).toBe(
      true,
    );
  });

  it("records a whole-value observation before array push appends", () => {
    const cell = runtime.getCell<{ items: number[] }>(
      space,
      "cfc-cell-push-root",
      undefined,
      tx,
    );
    cell.set({ items: [1, 2] });
    const itemsCell = cell.key("items");

    const beforeReads =
      canonicalizeBoundaryActivity(tx.journal.activity()).reads
        .length;

    itemsCell.push(3);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .slice(beforeReads)
      .filter((read) => !read.internalVerifierRead);
    expect(
      reads.some((read) => read.path === "/items" && read.op === "value"),
    ).toBe(true);
  });

  it("records source-cell dereferences on the source metadata path", () => {
    const sourceCell = runtime.getCell<{ process: string }>(
      space,
      "cfc-cell-source-target",
      undefined,
      tx,
    );
    sourceCell.set({ process: "gmail" });

    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "cfc-cell-source-owner",
      undefined,
      tx,
    );
    resultCell.setSourceCell(sourceCell);

    const beforeReads =
      canonicalizeBoundaryActivity(tx.journal.activity()).reads
        .length;

    const resolvedSource = resultCell.getSourceCell();

    expect(resolvedSource?.entityId).toEqual(sourceCell.entityId);

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .slice(beforeReads)
      .filter((read) => !read.internalVerifierRead);
    expect(
      reads.some((read) => read.path === "/source" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/source" && read.op === "followRef"),
    ).toBe(true);
    expect(
      reads.some((read) =>
        read.id === sourceCell.getAsNormalizedFullLink().id &&
        (read.op === "shape" || read.op === "value")
      ),
    ).toBe(false);
  });

  it("records only source-path shape when no source cell is present", () => {
    const resultCell = runtime.getCell<{ result: number }>(
      space,
      "cfc-cell-source-missing",
      undefined,
      tx,
    );

    const beforeReads =
      canonicalizeBoundaryActivity(tx.journal.activity()).reads
        .length;

    expect(resultCell.getSourceCell()).toBeUndefined();

    const reads = canonicalizeBoundaryActivity(tx.journal.activity()).reads
      .slice(beforeReads)
      .filter((read) => !read.internalVerifierRead);
    expect(
      reads.some((read) => read.path === "/source" && read.op === "shape"),
    ).toBe(true);
    expect(
      reads.some((read) => read.path === "/source" && read.op === "followRef"),
    ).toBe(false);
  });
});
