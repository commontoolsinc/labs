import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { parseLink, resolveCellPath, Runtime } from "@commonfabric/runner";
import { taggedHashStringOf } from "@commonfabric/data-model/value-hash";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createSession, Identity } from "@commonfabric/identity";
import { PieceManager } from "../src/manager.ts";

const signer = await Identity.fromPassphrase("test link reactivity");

describe("PieceManager.link() reactivity", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: PieceManager;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager,
    });

    const session = await createSession({
      identity: signer,
      spaceName: "test-space-" + crypto.randomUUID(),
    });
    manager = new PieceManager(session, runtime);
    await manager.synced();
  });

  afterEach(async () => {
    await storageManager?.close();
  });

  it("should store a link reference, not a snapshot value", async () => {
    // Create source cell with data
    const sourceCell = runtime.getCell(manager.getSpace(), "source");
    await runtime.editWithRetry((tx) => {
      sourceCell.withTx(tx).set({ data: "source value" });
    });
    await runtime.idle();

    // Create target cell
    const targetCell = runtime.getCell(manager.getSpace(), "target");
    await runtime.editWithRetry((tx) => {
      targetCell.withTx(tx).set({ linked: null });
    });
    await runtime.idle();

    // Manually perform what link() does - set a cell as a link
    await runtime.editWithRetry((tx) => {
      const target = targetCell.withTx(tx);
      const source = sourceCell.withTx(tx);
      target.key("linked").set(source.key("data"));
    });
    await runtime.idle();

    // Reading linked value should give us the source value through indirection
    const linkedValue = targetCell.key("linked").get();
    expect(linkedValue).toBe("source value");

    // Update source
    await runtime.editWithRetry((tx) => {
      sourceCell.withTx(tx).set({ data: "updated value" });
    });
    await runtime.idle();

    // Target should see updated value through the link
    const updatedLinkedValue = targetCell.key("linked").get();
    expect(updatedLinkedValue).toBe("updated value");
  });

  it("should be idempotent - writing a link at a path that already has a link should overwrite, not follow", async () => {
    // Create source and target cells
    const sourceCell = runtime.getCell(manager.getSpace(), "source-idem");
    const targetCell = runtime.getCell(manager.getSpace(), "target-idem");

    await runtime.editWithRetry((tx) => {
      sourceCell.withTx(tx).set({ data: "original" });
    });
    await runtime.editWithRetry((tx) => {
      targetCell.withTx(tx).set({ linked: null });
    });
    await runtime.idle();

    // First link: target.linked -> source.data (using cell.set which creates a link)
    await runtime.editWithRetry((tx) => {
      const target = targetCell.withTx(tx);
      const source = sourceCell.withTx(tx);
      target.key("linked").set(source.key("data"));
    });
    await runtime.idle();

    // Verify link works
    expect(targetCell.key("linked").get()).toBe("original");

    // Now re-link: write the same link again at target.linked
    // WITHOUT resolveAsCell(), this should overwrite the link at the path
    // WITH resolveAsCell(), this would follow the existing link and corrupt source.data
    await runtime.editWithRetry((tx) => {
      const target = targetCell.withTx(tx);
      const source = sourceCell.withTx(tx);
      // This is what manager.link() does (without resolveAsCell)
      target.key("linked").setRawUntyped(
        source.key("data").getAsLink({
          base: target,
          includeSchema: true,
          keepStreams: true,
        }),
      );
    });
    await runtime.idle();

    // Source must NOT be corrupted — it should still have "original"
    expect(sourceCell.key("data").get()).toBe("original");
    // Target should still resolve the link correctly
    expect(targetCell.key("linked").get()).toBe("original");

    // Verify reactivity still works after re-linking
    await runtime.editWithRetry((tx) => {
      sourceCell.withTx(tx).set({ data: "updated" });
    });
    await runtime.idle();
    expect(targetCell.key("linked").get()).toBe("updated");
  });

  it("links scoped source cells into scoped target cells", async () => {
    const sourceId = taggedHashStringOf("scoped-source");
    const targetId = taggedHashStringOf("scoped-target");
    const sourceCell = runtime.getCellFromLink({
      id: `of:${sourceId}`,
      path: [],
      space: manager.getSpace(),
      scope: "user",
    });
    const targetCell = runtime.getCellFromLink({
      id: `of:${targetId}`,
      path: [],
      space: manager.getSpace(),
      scope: "session",
    });

    await runtime.editWithRetry((tx) => {
      sourceCell.withTx(tx).set({ data: "scoped value" });
      targetCell.withTx(tx).set({ linked: null });
    });
    await runtime.idle();

    await manager.link(
      sourceId,
      ["data"],
      targetId,
      ["linked"],
      { start: false, sourceScope: "user", targetScope: "session" },
    );
    await targetCell.sync();

    const rawLink = targetCell.key("linked").getRaw();
    expect(parseLink(rawLink, targetCell)?.scope).toBe("user");
    expect(targetCell.key("linked").get()).toBe("scoped value");
  });

  it("should link through exposed cell-valued source fields", async () => {
    const cellSchema = {
      type: "number",
      default: 0,
      asCell: ["cell"],
    } as const;
    const modelSchema = {
      type: "object",
      properties: { value: cellSchema },
      default: { value: 0 },
    } as const;
    const sourceArgument = runtime.getCell(manager.getSpace(), "source-arg");
    const sourceResult = runtime.getCell(manager.getSpace(), "source-result");
    const targetArgument = runtime.getCell(
      manager.getSpace(),
      "target-arg",
      modelSchema,
    );

    await runtime.editWithRetry((tx) => {
      sourceArgument.withTx(tx).set({ value: 10 });
      targetArgument.withTx(tx).set({ value: 0 });
    });
    await runtime.editWithRetry((tx) => {
      sourceResult.withTx(tx).set({
        value: sourceArgument.withTx(tx).key("value").asSchema(cellSchema),
      });
    });
    await runtime.idle();

    await runtime.editWithRetry((tx) => {
      const target = targetArgument.withTx(tx).key("value");
      const source = sourceResult.asSchemaFromLinks().key("value");
      target.setRawUntyped(
        source.getAsLink({
          base: targetArgument,
          includeSchema: true,
          keepStreams: true,
        }),
      );
    });
    await runtime.idle();

    expect(resolveCellPath(targetArgument, ["value"])).toBe(10);
  });
});
