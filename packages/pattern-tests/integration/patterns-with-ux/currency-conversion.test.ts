import { env } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-runtime";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("currency conversion pattern test", () => {
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
      "currency-conversion.pattern.tsx",
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

  it("should load the currency converter and verify initial state", async () => {
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
    const texts = await page.$$("ct-text", { strategy: "pierce" });
    let found = false;
    for (const text of texts) {
      const content = await text.evaluate((el: HTMLElement) => el.textContent);
      if (content?.includes("Currency Converter")) {
        found = true;
        break;
      }
    }
    assert(found, "Should find currency converter heading");

    // Verify initial state
    const baseCode = charm.result.get(["baseCode"]) as string;
    const normalizedAmount = charm.result.get(["normalizedAmount"]) as number;
    const currencyCodes = charm.result.get(["currencyCodes"]) as string[];

    assertEquals(baseCode, "USD", "Base currency should be USD");
    assertEquals(normalizedAmount, 100, "Initial amount should be 100");
    assert(Array.isArray(currencyCodes), "Currency codes should be an array");
    assert(currencyCodes.length >= 3, "Should have at least 3 currencies");
  });

  it("should display conversions for all target currencies", async () => {
    const conversions = charm.result.get(["conversions"]) as Record<string, number>;
    const currencyCodes = charm.result.get(["currencyCodes"]) as string[];

    assert(typeof conversions === "object", "Conversions should be an object");

    // Verify conversions exist for all target currencies
    for (const code of currencyCodes) {
      assert(
        typeof conversions[code] === "number",
        `Should have conversion for ${code}`,
      );
    }

    // Base currency should equal the amount
    const baseCode = charm.result.get(["baseCode"]) as string;
    const normalizedAmount = charm.result.get(["normalizedAmount"]) as number;
    assertEquals(
      conversions[baseCode],
      normalizedAmount,
      "Base currency conversion should equal the amount",
    );
  });

  it("should update amount via UI", async () => {
    const page = shell.page();

    // Find amount input
    const amountInput = await page.waitForSelector("#amount-input", {
      strategy: "pierce",
    });
    assert(amountInput, "Should find amount input");

    // Get the actual input element inside ct-input
    const inputElement = await amountInput.waitForSelector("input", {
      strategy: "pierce",
    });

    // Clear and set new amount
    await inputElement.click();
    await inputElement.evaluate((el: HTMLInputElement) => {
      el.value = "";
    });
    await inputElement.type("250");
    await new Promise(resolve => setTimeout(resolve, 300));

    // Click update button
    const updateButton = await page.waitForSelector("#update-amount-button", {
      strategy: "pierce",
    });
    assert(updateButton, "Should find update amount button");
    await updateButton.click();

    // Wait for state to settle
    await new Promise(resolve => setTimeout(resolve, 5000));

    const normalizedAmount = charm.result.get(["normalizedAmount"]) as number;
    assertEquals(normalizedAmount, 250, "Amount should be updated to 250");

    // Verify conversions updated
    const conversions = charm.result.get(["conversions"]) as Record<string, number>;
    const baseCode = charm.result.get(["baseCode"]) as string;
    assertEquals(conversions[baseCode], 250, "Base conversion should match new amount");
  });

  it("should add/update exchange rate via UI", async () => {
    const page = shell.page();

    // Find currency code input
    const currencyInput = await page.waitForSelector("#currency-code-input", {
      strategy: "pierce",
    });
    assert(currencyInput, "Should find currency code input");
    const currencyInputElement = await currencyInput.waitForSelector("input", {
      strategy: "pierce",
    });

    // Enter new currency code
    await currencyInputElement.click();
    await currencyInputElement.type("JPY");
    await new Promise(resolve => setTimeout(resolve, 300));

    // Find rate input
    const rateInput = await page.waitForSelector("#exchange-rate-input", {
      strategy: "pierce",
    });
    assert(rateInput, "Should find rate input");
    const rateInputElement = await rateInput.waitForSelector("input", {
      strategy: "pierce",
    });

    // Enter exchange rate
    await rateInputElement.click();
    await rateInputElement.type("150");
    await new Promise(resolve => setTimeout(resolve, 300));

    // Click update rate button
    const updateRateButton = await page.waitForSelector("#update-rate-button", {
      strategy: "pierce",
    });
    assert(updateRateButton, "Should find update rate button");
    await updateRateButton.click();

    // Wait for state to settle
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Verify JPY was added to rates
    const rates = charm.result.get(["normalizedRates"]) as Record<string, number>;
    assert(rates.JPY !== undefined, "Should have JPY rate");
    assertEquals(rates.JPY, 150, "JPY rate should be 150");

    // Verify JPY was added to currency codes
    const currencyCodes = charm.result.get(["currencyCodes"]) as string[];
    assert(currencyCodes.includes("JPY"), "Currency codes should include JPY");

    // Verify conversion for JPY
    const conversions = charm.result.get(["conversions"]) as Record<string, number>;
    const normalizedAmount = charm.result.get(["normalizedAmount"]) as number;
    const expectedJPY = normalizedAmount * 150;
    assert(
      Math.abs(conversions.JPY - expectedJPY) < 0.01,
      `JPY conversion should be ${expectedJPY}, got ${conversions.JPY}`,
    );
  });

  it("should update rates via direct operation", async () => {
    // Get current rates
    const currentRates = charm.result.get(["rates"]) as Record<string, number>;

    // Add CNY rate
    const updatedRates = {
      ...currentRates,
      CNY: 7.2,
    };

    await charm.result.set(updatedRates, ["rates"]);

    // Wait for reactive updates
    await new Promise(resolve => setTimeout(resolve, 5000));

    const rates = charm.result.get(["normalizedRates"]) as Record<string, number>;
    assertEquals(rates.CNY, 7.2, "CNY rate should be 7.2");

    // Verify conversion calculation
    const conversions = charm.result.get(["conversions"]) as Record<string, number>;
    const normalizedAmount = charm.result.get(["normalizedAmount"]) as number;
    const expectedCNY = normalizedAmount * 7.2;
    assert(
      Math.abs(conversions.CNY - expectedCNY) < 0.01,
      `CNY conversion should be ${expectedCNY}, got ${conversions.CNY}`,
    );
  });

  it("should update amount via direct operation", async () => {
    await charm.result.set(500, ["amount"]);

    // Wait for reactive updates
    await new Promise(resolve => setTimeout(resolve, 5000));

    const normalizedAmount = charm.result.get(["normalizedAmount"]) as number;
    assertEquals(normalizedAmount, 500, "Amount should be 500");

    // Verify all conversions updated
    const conversions = charm.result.get(["conversions"]) as Record<string, number>;
    const baseCode = charm.result.get(["baseCode"]) as string;
    assertEquals(conversions[baseCode], 500, "Base conversion should be 500");

    // Verify other currencies also updated
    const rates = charm.result.get(["normalizedRates"]) as Record<string, number>;
    if (rates.EUR) {
      const expectedEUR = 500 * rates.EUR;
      assert(
        Math.abs(conversions.EUR - expectedEUR) < 0.01,
        `EUR should update with new amount, expected ${expectedEUR}, got ${conversions.EUR}`,
      );
    }
  });

  it("should maintain base currency rate at 1", async () => {
    const rates = charm.result.get(["normalizedRates"]) as Record<string, number>;
    const baseCode = charm.result.get(["baseCode"]) as string;

    assertEquals(rates[baseCode], 1, "Base currency rate should always be 1");
  });

  it("should display correct currency count", async () => {
    const currencyCount = charm.result.get(["currencyCount"]) as number;
    const currencyCodes = charm.result.get(["currencyCodes"]) as string[];

    assertEquals(
      currencyCount,
      currencyCodes.length,
      "Currency count should match length of currency codes array",
    );
  });
});
