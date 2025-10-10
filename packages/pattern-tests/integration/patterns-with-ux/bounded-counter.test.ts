import { env } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-runtime";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("bounded counter pattern test", () => {
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
      "bounded-counter.pattern.tsx",
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

  it("should load the bounded counter and verify initial state", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId: charm.id,
      identity,
    });

    // Wait for UI to render
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Find heading
    const heading = await page.waitForSelector("h2", {
      strategy: "pierce",
    });
    assert(heading, "Should find heading element");

    const headingText = await heading.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assert(
      headingText?.includes("Adjust within minimum and maximum bounds"),
      "Heading should describe bounded counter",
    );

    // Verify initial state
    const currentValue = charm.result.get(["currentValue"]) as number;
    const minValue = charm.result.get(["minValue"]) as number;
    const maxValue = charm.result.get(["maxValue"]) as number;

    assertEquals(currentValue, 0, "Initial value should be 0");
    assertEquals(minValue, 0, "Initial min should be 0");
    assertEquals(maxValue, 10, "Initial max should be 10");
  });

  it("should increment counter via UI button", async () => {
    const page = shell.page();

    // Wait for increment button to be ready
    const incrementButton = await page.waitForSelector("#increment-button", {
      strategy: "pierce",
    });
    assert(incrementButton, "Should find increment button");

    await incrementButton.click();

    // Wait for state to settle
    await new Promise(resolve => setTimeout(resolve, 5000));

    const currentValue = charm.result.get(["currentValue"]) as number;
    assertEquals(currentValue, 1, "Value should be incremented to 1");
  });

  it("should decrement counter via UI button", async () => {
    const page = shell.page();

    // Wait for decrement button to be ready
    const decrementButton = await page.waitForSelector("#decrement-button", {
      strategy: "pierce",
    });
    assert(decrementButton, "Should find decrement button");

    await decrementButton.click();

    // Wait for state to settle
    await new Promise(resolve => setTimeout(resolve, 5000));

    const currentValue = charm.result.get(["currentValue"]) as number;
    assertEquals(currentValue, 0, "Value should be decremented back to 0");
  });

  it("should change step size via UI input", async () => {
    const page = shell.page();

    // Find step size input (wait for it to be ready)
    const stepInput = await page.waitForSelector(
      'input[aria-label="Choose how far to adjust the counter"]',
      { strategy: "pierce" }
    );
    assert(stepInput, "Should find step size input");

    // Clear and set new step size
    await stepInput.click();
    await stepInput.evaluate((el: HTMLInputElement) => {
      el.value = "";
    });
    await stepInput.type("5");
    await new Promise(resolve => setTimeout(resolve, 300));

    // Wait for increment button to be ready
    const incrementButton = await page.waitForSelector("#increment-button", {
      strategy: "pierce",
    });
    assert(incrementButton, "Should find increment button");
    await incrementButton.click();

    // Wait for state to settle
    await new Promise(resolve => setTimeout(resolve, 5000));

    const currentValue = charm.result.get(["currentValue"]) as number;
    assertEquals(currentValue, 5, "Value should be incremented by 5");
  });

  it("should enforce maximum boundary", async () => {
    const page = shell.page();

    // Set value to 9 via direct operation
    await charm.result.set(9, ["value"]);
    // Direct manipulation causes more conflicts - wait longer
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Wait for increment button to be ready
    const incrementButton = await page.waitForSelector("#increment-button", {
      strategy: "pierce",
    });
    assert(incrementButton, "Should find increment button");
    await incrementButton.click();

    await new Promise(resolve => setTimeout(resolve, 5000));

    const currentValue = charm.result.get(["currentValue"]) as number;
    assert(currentValue <= 10, `Value should not exceed max, got ${currentValue}`);
  });

  it("should enforce minimum boundary", async () => {
    const page = shell.page();

    // Set value to 1 via direct operation
    await charm.result.set(1, ["value"]);
    // Direct manipulation causes more conflicts - wait longer
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Change step size to 5
    const stepInput = await page.waitForSelector(
      'input[aria-label="Choose how far to adjust the counter"]',
      { strategy: "pierce" }
    );
    await stepInput.click();
    await stepInput.evaluate((el: HTMLInputElement) => {
      el.value = "";
    });
    await stepInput.type("5");
    await new Promise(resolve => setTimeout(resolve, 300));

    // Wait for decrement button to be ready
    const decrementButton = await page.waitForSelector("#decrement-button", {
      strategy: "pierce",
    });
    assert(decrementButton, "Should find decrement button");
    await decrementButton.click();

    await new Promise(resolve => setTimeout(resolve, 5000));

    const currentValue = charm.result.get(["currentValue"]) as number;
    assert(currentValue >= 0, `Value should not go below min, got ${currentValue}`);
  });

  it("should update min boundary via direct operation", async () => {
    // Set min to 5
    await charm.result.set(5, ["min"]);
    // Direct manipulation causes more conflicts - wait longer
    await new Promise(resolve => setTimeout(resolve, 10000));

    const minValue = charm.result.get(["minValue"]) as number;
    assertEquals(minValue, 5, "Min should be updated to 5");

    // If current value is below new min, it should be clamped
    const currentValue = charm.result.get(["currentValue"]) as number;
    assert(currentValue >= 5, `Current value should be at least min (5), got ${currentValue}`);
  });

  it("should update max boundary via direct operation", async () => {
    // Set max to 20
    await charm.result.set(20, ["max"]);
    // Direct manipulation causes more conflicts - wait longer
    await new Promise(resolve => setTimeout(resolve, 10000));

    const maxValue = charm.result.get(["maxValue"]) as number;
    assertEquals(maxValue, 20, "Max should be updated to 20");
  });

  it("should display status with current value and boundaries", async () => {
    const page = shell.page();

    const statusElement = await page.waitForSelector('[data-testid="status"]', {
      strategy: "pierce",
    });
    assert(statusElement, "Should find status element");

    const statusText = await statusElement.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assert(
      statusText?.includes("Value") && statusText?.includes("min") && statusText?.includes("max"),
      `Status should show value and boundaries, got: ${statusText}`,
    );
  });
});
