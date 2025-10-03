import { env, waitFor } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-runtime";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("budget planner pattern test", () => {
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

  it("should load the budget planner and verify initial state", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId: charm.id,
      identity,
    });

    // Wait for the UI to render - look for heading
    const heading = await page.waitForSelector("h2", {
      strategy: "pierce",
    });
    assert(heading, "Should find heading element");

    const headingText = await heading.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assertEquals(
      headingText?.trim(),
      "Allocate funds across categories",
    );

    // Verify initial state has default categories
    const categories = charm.result.get(["categoryCatalog"]);
    assert(Array.isArray(categories), "Categories should be an array");
    assert(categories.length > 0, "Should have default categories");

    const totalBudget = charm.result.get(["totalBudget"]);
    assertEquals(totalBudget, 4000, "Default total budget should be 4000");
  });

  it("should display budget categories with targets", async () => {
    const page = shell.page();

    // Find category cards by looking for elements with category names
    const categoryElements = await page.$$("strong", {
      strategy: "pierce",
    });
    assert(categoryElements.length >= 5, "Should have at least 5 categories");

    // Verify we can see category names
    const categoryNames = await Promise.all(
      categoryElements.slice(0, 5).map(async (el) =>
        await el.evaluate((elem: HTMLElement) => elem.textContent?.trim())
      ),
    );

    assert(
      categoryNames.some((name) => name?.includes("Housing")),
      "Should include Housing category",
    );
    assert(
      categoryNames.some((name) => name?.includes("Food")),
      "Should include Food category",
    );
  });

  it("should allocate funds to a category via UI", async () => {
    const page = shell.page();

    // Find input by placeholder attribute (pierce will find it inside ct-input shadow DOM)
    const categoryInput = await page.waitForSelector(
      'input[placeholder="housing, food, etc."]',
      { strategy: "pierce" }
    );
    assert(categoryInput, "Should find category input");
    await categoryInput.click();
    await categoryInput.type("housing");

    // Find amount input by placeholder
    const amountInput = await page.waitForSelector(
      'input[placeholder="0.00"]',
      { strategy: "pierce" }
    );
    assert(amountInput, "Should find amount input");
    await amountInput.click();
    await amountInput.type("1800");

    // Find and click the Allocate button by ID
    const allocateButton = await page.waitForSelector("#allocate-button", {
      strategy: "pierce",
    });
    assert(allocateButton, "Should find Allocate button");
    await allocateButton.click();

    // Wait for allocation to be applied
    await waitFor(async () => {
      const allocations = charm.result.get(["allocations"]) as Record<string, number>;
      return allocations?.housing === 1800;
    });

    const allocatedTotal = charm.result.get(["allocatedTotal"]) as number;
    assertEquals(allocatedTotal, 1800, "Allocated total should be 1800");

    const remaining = charm.result.get(["remainingBudget"]) as number;
    assertEquals(remaining, 2200, "Remaining budget should be 2200");
  });

  it("should show status message when budget is not balanced", async () => {
    const page = shell.page();

    // Find the status element
    const statusElement = await page.waitForSelector('[data-testid="status"]', {
      strategy: "pierce",
    });
    assert(statusElement, "Should find status element");

    const statusText = await statusElement.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assert(
      statusText?.includes("Remaining allocation"),
      "Status should show remaining allocation",
    );
  });

  it("should balance budget by targets", async () => {
    const page = shell.page();

    // Find the "Balance by Targets" button by ID
    const balanceButton = await page.waitForSelector("#balance-targets-button", {
      strategy: "pierce",
    });
    assert(balanceButton, "Should find Balance by Targets button");

    await balanceButton.click();

    // Wait for budget to be balanced
    await waitFor(async () => {
      const balanced = charm.result.get(["balanced"]);
      return balanced === true;
    });

    const remaining = charm.result.get(["remainingBudget"]) as number;
    assert(
      remaining <= 0.01,
      "Remaining budget should be close to 0 when balanced",
    );

    const allocatedTotal = charm.result.get(["allocatedTotal"]) as number;
    const totalBudget = charm.result.get(["totalBudget"]) as number;
    assert(
      Math.abs(allocatedTotal - totalBudget) <= 0.01,
      "Allocated total should match total budget",
    );
  });

  it("should reset all allocations", async () => {
    const page = shell.page();

    // Find the "Reset All" button by ID
    const resetButton = await page.waitForSelector("#reset-all-button", {
      strategy: "pierce",
    });
    assert(resetButton, "Should find Reset All button");

    await resetButton.click();

    // Wait for allocations to be reset
    await waitFor(async () => {
      const allocatedTotal = charm.result.get(["allocatedTotal"]);
      return allocatedTotal === 0;
    });

    const allocations = charm.result.get(["allocations"]) as Record<string, number>;
    const allocationValues = Object.values(allocations);
    const allZero = allocationValues.every((val) => val === 0);
    assert(allZero, "All allocations should be reset to 0");

    const remaining = charm.result.get(["remainingBudget"]) as number;
    const totalBudget = charm.result.get(["totalBudget"]) as number;
    assertEquals(
      remaining,
      totalBudget,
      "Remaining should equal total budget after reset",
    );
  });

  it("should update allocations via direct operation", async () => {
    // Directly set allocation for food category
    await charm.result.set(600, ["allocations", "food"]);

    await waitFor(async () => {
      const allocations = charm.result.get(["allocations"]) as Record<string, number>;
      return allocations?.food === 600;
    });

    const allocatedTotal = charm.result.get(["allocatedTotal"]) as number;
    assertEquals(allocatedTotal, 600, "Allocated total should be 600");
  });
});
