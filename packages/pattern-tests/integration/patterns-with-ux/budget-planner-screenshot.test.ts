import { env } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-runtime";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("budget planner screenshots", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: CharmsController;
  let charm: CharmController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    const sourcePath = join(
      import.meta.dirname!,
      "budget-planner.pattern.tsx",
    );
    const program = await cc.manager().runtime.harness
      .resolve(
        new FileSystemProgramResolver(sourcePath),
      );
    charm = await cc.create(
      program,
      { start: true },
    );
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should take screenshot of initial state", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId: charm.id,
      identity,
    });

    // Wait for UI to render
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Take screenshot
    await page.screenshot("budget-planner-initial.png");

    console.log("Screenshot saved to budget-planner-initial.png");
    assert(true);
  });

  it("should take screenshot after allocating funds", async () => {
    const page = shell.page();

    // Find and fill inputs
    const categoryInput = await page.waitForSelector(
      'input[placeholder="housing, food, etc."]',
      { strategy: "pierce" }
    );
    await categoryInput.click();
    await categoryInput.type("housing");
    await new Promise(resolve => setTimeout(resolve, 300));

    const amountInput = await page.waitForSelector(
      'input[placeholder="0.00"]',
      { strategy: "pierce" }
    );
    await amountInput.click();
    await amountInput.type("1800");
    await new Promise(resolve => setTimeout(resolve, 300));

    // Click allocate button
    const allocateButton = await page.waitForSelector("#allocate-button", {
      strategy: "pierce",
    });
    await allocateButton.click();

    // Wait for state to settle
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Take screenshot
    await page.screenshot("budget-planner-after-allocate.png");

    console.log("Screenshot saved to budget-planner-after-allocate.png");
    assert(true);
  });
});
