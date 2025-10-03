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
    const items = charm.result.get(["sanitizedItems"]) as InvoiceItem[];
    const lineSummaries = charm.result.get(["lineSummaries"]) as LineSummary[];

    assert(Array.isArray(lineSummaries), "Line summaries should be an array");
    assertEquals(
      lineSummaries.length,
      items.length,
      "Should have summaries for all items",
    );

    // Verify each line has expected fields
    for (const line of lineSummaries) {
      assert(typeof line.baseTotal === "number", "Should have baseTotal");
      assert(
        typeof line.itemDiscountAmount === "number",
        "Should have itemDiscountAmount",
      );
      assert(typeof line.lineTotal === "number", "Should have lineTotal");
    }
  });

  it("should calculate invoice totals correctly", async () => {
    const totals = charm.result.get(["totals"]) as InvoiceTotals;

    assert(typeof totals.subtotal === "number", "Should have subtotal");
    assert(
      typeof totals.itemDiscountTotal === "number",
      "Should have itemDiscountTotal",
    );
    assert(
      typeof totals.invoiceDiscountAmount === "number",
      "Should have invoiceDiscountAmount",
    );
    assert(
      typeof totals.discountedSubtotal === "number",
      "Should have discountedSubtotal",
    );
    assert(typeof totals.taxAmount === "number", "Should have taxAmount");
    assert(typeof totals.totalDue === "number", "Should have totalDue");

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
    // Set tax rate to 10%
    await charm.result.set(0.1, ["taxRate"]);

    await waitFor(async () => {
      const sanitizedTaxRate = charm.result.get(["sanitizedTaxRate"]) as number;
      return sanitizedTaxRate === 0.1;
    });

    const totals = charm.result.get(["totals"]) as InvoiceTotals;
    assertEquals(
      totals.taxRate,
      0.1,
      "Tax rate in totals should be updated to 0.1",
    );

    // Verify tax amount is recalculated
    const expectedTax = Math.round(totals.discountedSubtotal * 0.1 * 100) / 100;
    assertEquals(
      totals.taxAmount,
      expectedTax,
      "Tax amount should be recalculated",
    );
  });

  it("should update invoice discount via direct operation", async () => {
    // Set invoice discount to 15%
    await charm.result.set(0.15, ["invoiceDiscountRate"]);

    await waitFor(async () => {
      const sanitizedDiscount = charm.result.get([
        "sanitizedInvoiceDiscountRate",
      ]) as number;
      return sanitizedDiscount === 0.15;
    });

    const totals = charm.result.get(["totals"]) as InvoiceTotals;
    assertEquals(
      totals.invoiceDiscountRate,
      0.15,
      "Invoice discount rate should be updated to 0.15",
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
    // Add a new item
    const currentItems = charm.result.get(["items"]) as InvoiceItem[];
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

    await charm.result.set(newItems, ["items"]);

    await waitFor(async () => {
      const sanitizedItems = charm.result.get(["sanitizedItems"]) as InvoiceItem[];
      return sanitizedItems.length === newItems.length;
    });

    const sanitizedItems = charm.result.get(["sanitizedItems"]) as InvoiceItem[];
    const lastItem = sanitizedItems[sanitizedItems.length - 1];
    assertEquals(
      lastItem.description,
      "Consulting services",
      "New item should be added",
    );

    // Verify totals are recalculated
    const totals = charm.result.get(["totals"]) as InvoiceTotals;
    assert(
      totals.subtotal > 0,
      "Subtotal should be recalculated after adding item",
    );
  });
});
