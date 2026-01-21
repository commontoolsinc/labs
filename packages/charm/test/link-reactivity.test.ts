import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { createSession, Identity } from "@commontools/identity";
import { CharmManager } from "../src/manager.ts";

const signer = await Identity.fromPassphrase("test link reactivity");

describe("CharmManager.link() reactivity", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let manager: CharmManager;

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
    manager = new CharmManager(session, runtime);
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
});
