import { env } from "@commontools/integration";
import { sleep } from "@commontools/utils/sleep";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { CharmsController } from "@commontools/charm/ops";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("ct-checkbox-simple integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let charmId: string;
  let identity: Identity;
  let cc: CharmsController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    const charm = await cc.create(
      await Deno.readTextFile(
        join(
          import.meta.dirname!,
          "..",
          "ct-checkbox-simple.tsx",
        ),
      ),
    );
    charmId = charm.id;
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should load the ct-checkbox-simple charm", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId,
      identity,
    });
    await page.waitForSelector("ct-checkbox", { strategy: "pierce" });
  });

  it("should show disabled content initially", async () => {
    const page = shell.page();

    // Wait for component to stabilize
    await sleep(1000);

    // Initially, feature should be disabled
    const disabledContent = await page.$("[data-testid='disabled-content']", {
      strategy: "pierce",
    });
    assert(disabledContent, "Should show disabled content initially");

    // Enabled content should not be present
    const enabledContent = await page.$("[data-testid='enabled-content']", {
      strategy: "pierce",
    });
    assertEquals(enabledContent, null, "Enabled content should be hidden initially");

    // Status should show "OFF"
    const status = await page.$("[data-testid='status']", {
      strategy: "pierce",
    });
    const statusText = await status?.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(statusText?.trim(), "Status: OFF");
  });

  it("should toggle to enabled content when checkbox is clicked", async () => {
    const page = shell.page();

    // Find and click the checkbox
    const checkbox = await page.waitForSelector(
      "[data-testid='main-checkbox']",
      { strategy: "pierce" }
    );
    await checkbox.click();
    await sleep(500);

    // Now enabled content should appear
    const enabledContent = await page.waitForSelector(
      "[data-testid='enabled-content']",
      { strategy: "pierce" }
    );
    assert(enabledContent, "Should show enabled content after clicking checkbox");

    // Disabled content should be gone
    const disabledContent = await page.$("[data-testid='disabled-content']", {
      strategy: "pierce",
    });
    assertEquals(disabledContent, null, "Disabled content should be hidden when enabled");

    // Status should show "ON"
    const status = await page.$("[data-testid='status']", {
      strategy: "pierce",
    });
    const statusText = await status?.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(statusText?.trim(), "Status: ON");
  });

  it("should toggle back to disabled content when checkbox is clicked again", async () => {
    const page = shell.page();

    // Click the checkbox again to disable
    const checkbox = await page.$("[data-testid='main-checkbox']", {
      strategy: "pierce",
    });
    await checkbox?.click();
    await sleep(500);

    // Disabled content should reappear
    const disabledContent = await page.waitForSelector(
      "[data-testid='disabled-content']",
      { strategy: "pierce" }
    );
    assert(disabledContent, "Should show disabled content after unchecking");

    // Enabled content should be gone
    const enabledContent = await page.$("[data-testid='enabled-content']", {
      strategy: "pierce",
    });
    assertEquals(enabledContent, null, "Enabled content should be hidden when disabled");

    // Status should show "OFF"
    const status = await page.$("[data-testid='status']", {
      strategy: "pierce",
    });
    const statusText = await status?.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(statusText?.trim(), "Status: OFF");
  });
});