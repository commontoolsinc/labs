import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTRender } from "./ct-render.ts";
import { type Cell, Runtime } from "@commontools/runner";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

describe("CTRender", () => {
  it("should be defined", () => {
    expect(CTRender).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(CTRender.name).toBe("CTRender");
  });

  it("should create element instance", () => {
    const element = new CTRender();
    expect(element).toBeInstanceOf(CTRender);
  });

  it("should have cell property", () => {
    const element = new CTRender();
    expect(element.cell).toBeUndefined();
  });

  it("should have variant property", () => {
    const element = new CTRender();
    expect(element.variant).toBeUndefined();
  });
});

describe("CTRender async cell handling", () => {
  let runtime: Runtime;
  let space: string;

  beforeEach(async () => {
    const signer = await Identity.fromPassphrase("test-ct-render");
    space = signer.did();
    const storageManager = StorageManager.emulate({ as: signer });

    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
  });

  afterEach(() => {
    // Cleanup runtime if needed
  });

  it("should have _hasRendered false initially", () => {
    const element = new CTRender();
    // Access private property for testing
    expect((element as any)._hasRendered).toBe(false);
  });

  it("should reset _hasRendered when cell property changes", async () => {
    const element = new CTRender();
    document.body.appendChild(element);

    // Create a cell with a value
    const tx = runtime.edit();
    const cell1 = runtime.getCell<{ value: string }>(
      space as any,
      "test-cell-1",
      undefined,
      tx,
    );
    cell1.set({ value: "test1" });
    await tx.commit();

    // Set the first cell
    element.cell = cell1 as unknown as Cell;
    await element.updateComplete;

    // Manually set _hasRendered for testing
    (element as any)._hasRendered = true;

    // Create a second cell
    const tx2 = runtime.edit();
    const cell2 = runtime.getCell<{ value: string }>(
      space as any,
      "test-cell-2",
      undefined,
      tx2,
    );
    cell2.set({ value: "test2" });
    await tx2.commit();

    // Change to a different cell - should reset _hasRendered
    element.cell = cell2 as unknown as Cell;
    await element.updateComplete;

    // _hasRendered should be reset to false when cell changes
    expect((element as any)._hasRendered).toBe(false);

    document.body.removeChild(element);
  });

  it("should clean up subscription on disconnect", async () => {
    const element = new CTRender();
    document.body.appendChild(element);

    // Create and set a cell
    const tx = runtime.edit();
    const cell = runtime.getCell<{ value: string }>(
      space as any,
      "test-cell-disconnect",
      undefined,
      tx,
    );
    cell.set({ value: "test" });
    await tx.commit();

    element.cell = cell as unknown as Cell;
    await element.updateComplete;

    // Verify subscription exists
    expect((element as any)._cellValueUnsubscribe).toBeDefined();

    // Disconnect
    document.body.removeChild(element);

    // Subscription should be cleaned up
    expect((element as any)._cellValueUnsubscribe).toBeUndefined();
    expect((element as any)._hasRendered).toBe(false);
  });

  it("should clean up old subscription when cell changes", async () => {
    const element = new CTRender();
    document.body.appendChild(element);

    // Create first cell
    const tx1 = runtime.edit();
    const cell1 = runtime.getCell<{ value: string }>(
      space as any,
      "test-cell-sub-1",
      undefined,
      tx1,
    );
    cell1.set({ value: "test1" });
    await tx1.commit();

    element.cell = cell1 as unknown as Cell;
    await element.updateComplete;

    const firstSub = (element as any)._cellValueUnsubscribe;
    expect(firstSub).toBeDefined();

    // Create second cell
    const tx2 = runtime.edit();
    const cell2 = runtime.getCell<{ value: string }>(
      space as any,
      "test-cell-sub-2",
      undefined,
      tx2,
    );
    cell2.set({ value: "test2" });
    await tx2.commit();

    // Change cell
    element.cell = cell2 as unknown as Cell;
    await element.updateComplete;

    // Should have a new subscription (different reference)
    const secondSub = (element as any)._cellValueUnsubscribe;
    expect(secondSub).toBeDefined();
    // The subscriptions should be different functions
    expect(secondSub).not.toBe(firstSub);

    document.body.removeChild(element);
  });

  it("should not render when cell value is undefined", async () => {
    const element = new CTRender();
    document.body.appendChild(element);

    // Create a cell with undefined value
    const tx = runtime.edit();
    const cell = runtime.getCell<{ value: string } | undefined>(
      space as any,
      "test-cell-undefined",
      undefined,
      tx,
    );
    // Don't set any value - it will be undefined
    await tx.commit();

    element.cell = cell as unknown as Cell;
    await element.updateComplete;

    // Allow time for async render attempt
    await new Promise((r) => setTimeout(r, 50));

    // Should not have rendered because value is undefined
    expect((element as any)._hasRendered).toBe(false);

    document.body.removeChild(element);
  });
});

describe("CTRender variant handling", () => {
  it("should accept variant property", () => {
    const element = new CTRender();
    element.variant = "preview";
    expect(element.variant).toBe("preview");
  });

  it("should accept embedded variant", () => {
    const element = new CTRender();
    element.variant = "embedded";
    expect(element.variant).toBe("embedded");
  });

  it("should accept all valid variants", () => {
    const element = new CTRender();
    const variants = [
      "default",
      "preview",
      "thumbnail",
      "sidebar",
      "fab",
      "embedded",
    ] as const;

    for (const variant of variants) {
      element.variant = variant;
      expect(element.variant).toBe(variant);
    }
  });
});
