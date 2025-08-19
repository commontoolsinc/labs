import { env } from "@commontools/integration";
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

    const featureStatus = await page.waitForSelector("#feature-status", {
      strategy: "pierce",
    });
    const statusText = await featureStatus.evaluate((el: HTMLElement) => el.textContent);
    assertEquals(statusText?.trim(), "⚠ Feature is disabled");
  });

  it("should toggle to enabled content when checkbox is clicked", async () => {
    const page = shell.page();

    const checkbox = await page.waitForSelector("ct-checkbox", { strategy: "pierce" });
    await checkbox.click();
    
    // Use Astral's idiomatic waitForFunction
    await page.waitForFunction(() => {
      const el = document.querySelector("#feature-status");
      return el?.textContent?.trim() === "✓ Feature is enabled!";
    });
  });

  it("should toggle back to disabled content when checkbox is clicked again", async () => {
    const page = shell.page();

    const checkbox = await page.$("ct-checkbox", {
      strategy: "pierce",
    });
    await checkbox?.click();
    
    // Use Astral's idiomatic waitForFunction
    await page.waitForFunction(() => {
      const el = document.querySelector("#feature-status");
      return el?.textContent?.trim() === "⚠ Feature is disabled";
    });
  });
});
