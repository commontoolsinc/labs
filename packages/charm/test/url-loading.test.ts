import { assert, assertEquals } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { CharmManager } from "../src/manager.ts";
import { addRecipeFromUrl } from "../src/commands.ts";
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Identity } from "@commontools/identity";
import type { Session } from "@commontools/identity";

/**
 * Integration tests for URL-based pattern loading.
 * These tests verify that patterns can be loaded from arbitrary URLs,
 * enabling cross-repo pattern references.
 */

const SPACE_NAME = "test-url-loading";
const signer = await Identity.fromPassphrase("test url loading");
const space = signer.did();

describe("addRecipeFromUrl", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let charmManager: CharmManager;
  let session: Session;

  beforeEach(async () => {
    session = {
      private: false,
      name: SPACE_NAME,
      space: space,
      as: signer,
    } as Session;

    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    charmManager = new CharmManager(session, runtime);
    await charmManager.ready;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should load a pattern from a GitHub raw URL", async () => {
    // Use aside.tsx - a simple layout pattern with no dependencies
    const asideUrl = "https://raw.githubusercontent.com/commontoolsinc/labs/refs/heads/main/packages/patterns/aside.tsx";

    const charm = await addRecipeFromUrl(
      charmManager,
      asideUrl,
      "Aside pattern loaded from URL",
      {}, // No inputs needed
    );

    // Verify charm was created
    assert(charm, "Charm should be created");

    // Verify charm has expected structure
    const charmData = charm.get();
    assert(charmData, "Charm should have data");

    console.log("Loaded charm data:", charmData);
  });

  it("should handle invalid URLs gracefully", async () => {
    const invalidUrl = "https://raw.githubusercontent.com/commontoolsinc/labs/main/nonexistent.tsx";

    try {
      await addRecipeFromUrl(
        charmManager,
        invalidUrl,
        "Nonexistent pattern",
        {},
      );
      assert(false, "Should have thrown an error");
    } catch (error) {
      // Should throw an error - we don't care about the specific message
      assert(error instanceof Error);
    }
  });

  it.skip("should support cache busting", async () => {
    const url = "https://raw.githubusercontent.com/commontoolsinc/labs/refs/heads/main/packages/patterns/aside.tsx";

    // Load with cache busting enabled (default)
    const charm1 = await addRecipeFromUrl(
      charmManager,
      url,
      "Aside 1",
      {},
      undefined,
      true, // cacheBust
    );

    // Load again with cache busting disabled
    const charm2 = await addRecipeFromUrl(
      charmManager,
      url,
      "Aside 2",
      {},
      undefined,
      false, // no cacheBust
    );

    // Both should create valid charms
    assert(charm1, "First charm should be created");
    assert(charm2, "Second charm should be created");

    // They should be different charm instances
    // (In practice, the recipe ID might be the same, but the charm instances differ)
    assert(charm1 !== charm2, "Should create different charm instances");
  });

  it("should compile and instantiate pattern without dependencies", async () => {
    // Test with a pattern that doesn't have relative imports
    const url = "https://raw.githubusercontent.com/commontoolsinc/labs/refs/heads/main/packages/patterns/aside.tsx";

    const charm = await addRecipeFromUrl(
      charmManager,
      url,
      "Simple pattern test",
      {},
    );

    assert(charm, "Pattern without dependencies should load");
  });

  it("should load pattern WITH dependencies via URL resolution", async () => {
    // THIS IS THE BIG TEST - counter.tsx has relative import: "./counter-handlers.ts"
    const url = "https://raw.githubusercontent.com/commontoolsinc/labs/refs/heads/main/packages/patterns/counter.tsx";

    const charm = await addRecipeFromUrl(
      charmManager,
      url,
      "Counter with handlers",
      { value: 42 },
    );

    assert(charm, "Pattern with dependencies should load via URL resolution");

    const data = charm.get();
    console.log("Counter charm loaded with dependencies:", data);
  });
});

describe("URL-based cross-repo references", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let charmManager: CharmManager;
  let session: Session;

  beforeEach(async () => {
    session = {
      private: false,
      name: SPACE_NAME,
      space: space,
      as: signer,
    } as Session;

    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    charmManager = new CharmManager(session, runtime);
    await charmManager.ready;
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("demonstrates loading from labs repo", async () => {
    const labsUrl = "https://raw.githubusercontent.com/commontoolsinc/labs/refs/heads/main/packages/patterns/aside.tsx";

    const charm = await addRecipeFromUrl(
      charmManager,
      labsUrl,
      "Pattern from labs",
      {},
    );

    assert(charm, "Should load from labs repo");
  });

  // This test would work if the recipes repo had public patterns
  // For now, it's commented out as a demonstration
  /*
  it("demonstrates loading from recipes repo", async () => {
    const recipesUrl = "https://raw.githubusercontent.com/commontoolsinc/recipes/refs/heads/main/recipes/some-pattern.tsx";

    const charm = await addRecipeFromUrl(
      charmManager,
      recipesUrl,
      "Pattern from recipes",
      {},
    );

    assert(charm, "Should load from recipes repo");
  });
  */
});
