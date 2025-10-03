import { env, waitFor } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-runtime";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

interface InvoiceItem {
  name: string;
  description: string;
  quantity: number;
  unitPrice: number;
  itemDiscountRate: number;
}

interface LineSummary {
  baseTotal: number;
  itemDiscountAmount: number;
  lineTotal: number;
}

interface InvoiceTotals {
  subtotal: number;
  itemDiscountTotal: number;
  invoiceDiscountAmount: number;
  discountedSubtotal: number;
  taxAmount: number;
  totalDue: number;
  taxRate: number;
  invoiceDiscountRate: number;
}

describe("invoice generator pattern test", () => {
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
      "invoice-generator.pattern.tsx",
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

  it("should load the invoice generator and verify initial state", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      spaceName: SPACE_NAME,
      charmId: charm.id,
      identity,
    });

    // Allow time for initial state to stabilize
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Wait for the UI to render
    const heading = await page.waitForSelector("h1", {
      strategy: "pierce",
    });
    assert(heading, "Should find heading element");

    const headingText = await heading.evaluate((el: HTMLElement) =>
      el.textContent
    );
    assert(
      headingText?.includes("Invoice"),
      "Heading should include 'Invoice'",
    );

    // Verify initial state has default items
    const items = charm.result.get(["sanitizedItems"]) as InvoiceItem[];
    assert(Array.isArray(items), "Items should be an array");
    assert(items.length > 0, "Should have default items");

    // Verify tax and discount rates
    const taxRate = charm.result.get(["sanitizedTaxRate"]) as number;
    assertEquals(taxRate, 0.0725, "Default tax rate should be 0.0725");

    const invoiceDiscount = charm.result.get([
      "sanitizedInvoiceDiscountRate",
    ]) as number;
    assertEquals(
      invoiceDiscount,
      0.05,
      "Default invoice discount should be 0.05",
    );
  });

  it("should display invoice items and calculate totals", async () => {
    // Allow time for state to stabilize after initialization
    await new Promise(resolve => setTimeout(resolve, 2000));

    const items = charm.result.get(["sanitizedItems"]) as InvoiceItem[];
    const lineSummaries = charm.result.get(["lineSummaries"]) as LineSummary[];

    console.log(`[TEST] Items: ${JSON.stringify(items)}`);
    console.log(`[TEST] Line summaries: ${JSON.stringify(lineSummaries)}`);

    assert(Array.isArray(items), `Items should be an array, got ${typeof items}`);
    assert(items.length > 0, `Should have items, got ${items?.length}`);
    assert(Array.isArray(lineSummaries), `Line summaries should be an array, got ${typeof lineSummaries}`);
    assertEquals(
      lineSummaries.length,
      items.length,
      `Should have summaries for all items, got ${lineSummaries.length} summaries for ${items.length} items`,
    );

    // Verify each line has expected fields
    for (const line of lineSummaries) {
      console.log(`[TEST] Line: ${JSON.stringify(line)}`);
      assert(typeof line.baseTotal === "number", `Should have baseTotal, got ${typeof line.baseTotal}`);
      assert(
        typeof line.itemDiscountAmount === "number",
        `Should have itemDiscountAmount, got ${typeof line.itemDiscountAmount}`,
      );
      assert(typeof line.lineTotal === "number", `Should have lineTotal, got ${typeof line.lineTotal}`);
    }
  });

  it("should calculate invoice totals correctly", async () => {
    // Allow time for state to stabilize
    await new Promise(resolve => setTimeout(resolve, 1000));

    const totals = charm.result.get(["totals"]) as InvoiceTotals;

    assert(totals !== undefined && totals !== null, `Should have totals object, got ${totals}`);
    assert(typeof totals.subtotal === "number", `Should have subtotal, got ${typeof totals.subtotal}`);
    assert(
      typeof totals.itemDiscountTotal === "number",
      `Should have itemDiscountTotal, got ${typeof totals.itemDiscountTotal}`,
    );
    assert(
      typeof totals.invoiceDiscountAmount === "number",
      `Should have invoiceDiscountAmount, got ${typeof totals.invoiceDiscountAmount}`,
    );
    assert(
      typeof totals.discountedSubtotal === "number",
      `Should have discountedSubtotal, got ${typeof totals.discountedSubtotal}`,
    );
    assert(typeof totals.taxAmount === "number", `Should have taxAmount, got ${typeof totals.taxAmount}`);
    assert(typeof totals.totalDue === "number", `Should have totalDue, got ${typeof totals.totalDue}`);

    // Verify totalDue is calculated from discountedSubtotal + taxAmount
    const expectedTotal = totals.discountedSubtotal + totals.taxAmount;
    const roundedExpected = Math.round(expectedTotal * 100) / 100;
    assertEquals(
      totals.totalDue,
      roundedExpected,
      "Total due should equal discounted subtotal + tax",
    );
  });

  it("should update tax rate via direct operation", async () => {
    console.log("[TEST] Starting tax rate update test");

    // Set tax rate to 10%
    console.log("[TEST] About to call charm.result.set() for taxRate...");
    await charm.result.set(0.1, ["taxRate"]);
    console.log("[TEST] charm.result.set(taxRate) completed, waiting 10s...");

    // Allow extra time for direct state changes to propagate
    await new Promise(resolve => setTimeout(resolve, 10000));

    console.log("[TEST] Reading state after tax rate update...");
    const sanitizedTaxRate = charm.result.get(["sanitizedTaxRate"]) as number;
    console.log(`[TEST] Sanitized tax rate: ${sanitizedTaxRate}`);
    assertEquals(sanitizedTaxRate, 0.1, `Tax rate should be 0.1, got ${sanitizedTaxRate}`);

    const totals = charm.result.get(["totals"]) as InvoiceTotals;
    console.log(`[TEST] Totals object: ${JSON.stringify(totals)}`);
    assert(totals !== null && totals !== undefined, `Should have totals object, got ${totals}`);
    assertEquals(
      totals.taxRate,
      0.1,
      `Tax rate in totals should be updated to 0.1, got ${totals.taxRate}`,
    );

    // Verify tax amount is recalculated
    if (totals.discountedSubtotal !== null && totals.discountedSubtotal !== undefined) {
      const expectedTax = Math.round(totals.discountedSubtotal * 0.1 * 100) / 100;
      console.log(`[TEST] Expected tax: ${expectedTax}, actual: ${totals.taxAmount}`);
      assertEquals(
        totals.taxAmount,
        expectedTax,
        `Tax amount should be recalculated, got ${totals.taxAmount}`,
      );
    }
    console.log("[TEST] Tax rate update test completed successfully");
  });

  it("should update invoice discount via direct operation", async () => {
    // Set invoice discount to 15%
    await charm.result.set(0.15, ["invoiceDiscountRate"]);

    // Allow extra time for direct state changes to propagate
    await new Promise(resolve => setTimeout(resolve, 10000));

    const sanitizedDiscount = charm.result.get([
      "sanitizedInvoiceDiscountRate",
    ]) as number;
    assertEquals(sanitizedDiscount, 0.15, `Invoice discount should be 0.15, got ${sanitizedDiscount}`);

    const totals = charm.result.get(["totals"]) as InvoiceTotals;
    assert(totals !== null && totals !== undefined, `Should have totals object, got ${totals}`);
    assertEquals(
      totals.invoiceDiscountRate,
      0.15,
      `Invoice discount rate should be updated to 0.15, got ${totals.invoiceDiscountRate}`,
    );
  });

  it("should display formatted currency values", async () => {
    const page = shell.page();

    // Look for total due display
    const totalElements = await page.$$("strong", {
      strategy: "pierce",
    });

    // Find an element that displays currency (contains $)
    let foundCurrency = false;
    for (const el of totalElements) {
      const text = await el.evaluate((elem: HTMLElement) => elem.textContent);
      if (text && text.includes("$")) {
        foundCurrency = true;
        // Verify it's properly formatted (has decimal point)
        assert(
          text.match(/\$[\d,]+\.\d{2}/),
          `Currency should be formatted with 2 decimals: ${text}`,
        );
        break;
      }
    }

    assert(foundCurrency, "Should display at least one currency value");
  });

  it("should update items via direct operation", async () => {
    console.log("[TEST] Starting items update test");

    // Add a new item
    const currentItems = charm.result.get(["items"]) as InvoiceItem[];
    console.log(`[TEST] Current items count: ${currentItems.length}`);
    const newItems = [
      ...currentItems,
      {
        id: "consulting",
        description: "Consulting services",
        quantity: 10,
        unitPrice: 150,
        itemDiscountRate: 0,
      },
    ];
    console.log(`[TEST] New items count: ${newItems.length}`);

    console.log("[TEST] About to call charm.result.set() for items...");
    await charm.result.set(newItems, ["items"]);
    console.log("[TEST] charm.result.set(items) completed, waiting 10s...");

    // Allow extra time for direct state changes to propagate through reactive system
    await new Promise(resolve => setTimeout(resolve, 10000));

    console.log("[TEST] Reading state after items update...");
    const sanitizedItems = charm.result.get(["sanitizedItems"]) as InvoiceItem[];
    console.log(`[TEST] Sanitized items count: ${sanitizedItems.length}`);
    assert(sanitizedItems.length === newItems.length,
      `Should have ${newItems.length} items, got ${sanitizedItems.length}`);

    const lastItem = sanitizedItems[sanitizedItems.length - 1];
    console.log(`[TEST] Last item description: ${lastItem.description}`);
    assertEquals(
      lastItem.description,
      "Consulting services",
      "New item should be added",
    );

    // Verify totals are recalculated
    const totals = charm.result.get(["totals"]) as InvoiceTotals;
    console.log(`[TEST] Totals after items update: ${JSON.stringify(totals)}`);
    assert(totals !== null && totals !== undefined, `Should have totals object, got ${totals}`);
    assert(
      totals.subtotal !== null && totals.subtotal > 0,
      `Subtotal should be recalculated after adding item, got ${totals.subtotal}`,
    );
    console.log("[TEST] Items update test completed successfully");
  });
});
