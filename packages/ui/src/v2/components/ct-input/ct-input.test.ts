import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { CTInput, INPUT_PATTERNS } from "./ct-input.ts";

// NOTE: Full DOM interaction tests (input events, Cell two-way binding,
// timing strategy integration, validation UI) require Lit's rendering
// pipeline and shadow DOM, which aren't available in Deno's headless
// test runner. The tests below cover property defaults, validation
// patterns, Cell property acceptance, and basic configuration.
// For full integration tests, use a browser-based test harness.

describe("CTInput", () => {
  it("should be defined", () => {
    expect(CTInput).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("ct-input")).toBe(CTInput);
  });

  it("should create element instance", () => {
    const element = new CTInput();
    expect(element).toBeInstanceOf(CTInput);
  });

  it("should have correct default properties", () => {
    const el = new CTInput();
    expect(el.type).toBe("text");
    expect(el.placeholder).toBe("");
    expect(el.value).toBe("");
    expect(el.disabled).toBe(false);
    expect(el.readonly).toBe(false);
    expect(el.error).toBe(false);
    expect(el.name).toBe("");
    expect(el.required).toBe(false);
    expect(el.timingStrategy).toBe("debounce");
    expect(el.timingDelay).toBe(300);
    expect(el.showValidation).toBe(false);
  });

  it("should accept a CellHandle as value property", () => {
    const el = new CTInput();
    const cell = createMockCellHandle("hello");
    el.value = cell;
    expect(el.value).toBe(cell);
  });

  it("should accept a plain string as value property", () => {
    const el = new CTInput();
    el.value = "world";
    expect(el.value).toBe("world");
  });

  it("should accept all input types", () => {
    const el = new CTInput();
    const types = [
      "text",
      "password",
      "email",
      "number",
      "tel",
      "url",
      "search",
      "date",
      "time",
      "datetime-local",
      "color",
      "file",
      "range",
      "hidden",
    ] as const;

    for (const type of types) {
      el.type = type;
      expect(el.type).toBe(type);
    }
  });

  it("should accept timing strategy options", () => {
    const el = new CTInput();
    el.timingStrategy = "immediate";
    expect(el.timingStrategy).toBe("immediate");

    el.timingStrategy = "blur";
    expect(el.timingStrategy).toBe("blur");

    el.timingDelay = 500;
    expect(el.timingDelay).toBe(500);
  });
});

describe("CTInput — INPUT_PATTERNS", () => {
  it("should have email pattern", () => {
    const re = new RegExp(`^${INPUT_PATTERNS.email}$`);
    expect(re.test("user@example.com")).toBe(true);
    expect(re.test("invalid")).toBe(false);
  });

  it("should have URL pattern", () => {
    const re = new RegExp(`^${INPUT_PATTERNS.url}$`);
    expect(re.test("https://example.com")).toBe(true);
    expect(re.test("ftp://nope")).toBe(false);
  });

  it("should have US phone pattern", () => {
    const re = new RegExp(`^${INPUT_PATTERNS["tel-us"]}$`);
    expect(re.test("555-123-4567")).toBe(true);
    expect(re.test("1-555-123-4567")).toBe(true);
  });

  it("should have US ZIP code pattern", () => {
    const re = new RegExp(`^${INPUT_PATTERNS["zip-us"]}$`);
    expect(re.test("12345")).toBe(true);
    expect(re.test("12345-6789")).toBe(true);
    expect(re.test("1234")).toBe(false);
  });

  it("should have alphanumeric pattern", () => {
    const re = new RegExp(`^${INPUT_PATTERNS.alphanumeric}$`);
    expect(re.test("abc123")).toBe(true);
    expect(re.test("abc 123")).toBe(false);
  });
});
