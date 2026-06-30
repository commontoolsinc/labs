import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  calculateDaysUntilDue,
  createBillKey,
  demoPrice,
  formatCurrency,
  formatDate,
  formatIdentifier,
  getIdentifierColor,
  parseDateToMs,
} from "./helpers.ts";

describe("bill extractor helpers", () => {
  it("formats bill display values", () => {
    expect(createBillKey("1234", "2026-07-10")).toBe("1234|2026-07-10");
    expect(formatCurrency(42.5)).toBe("$42.50");
    expect(formatCurrency(undefined)).toBe("N/A");
    expect(formatDate("2026-07-10")).toMatch(/Jul/);
    expect(formatIdentifier("1234", "card")).toBe("...1234");
    expect(formatIdentifier("ABCD", "account")).toBe("Acct: ABCD");
  });

  it("uses stable date and identifier helpers", () => {
    const reference = new Date("2026-07-10T12:00:00Z");

    expect(calculateDaysUntilDue("2026-07-12", reference)).toBe(2);
    expect(calculateDaysUntilDue(undefined, reference)).toBe(999);
    expect(parseDateToMs("2026-07-12")).toBe(
      new Date(2026, 6, 12).setHours(0, 0, 0, 0),
    );
    expect(Number.isNaN(parseDateToMs("not-a-date"))).toBe(true);
    expect(getIdentifierColor("1234")).toBe(getIdentifierColor("1234"));
    expect(getIdentifierColor(undefined)).toBe(getIdentifierColor(""));
    expect(demoPrice(123.45, true)).toBe(demoPrice(123.45, true));
    expect(demoPrice(123.45, false)).toBe(123.45);
  });
});
