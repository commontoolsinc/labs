import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { CTTextarea } from "./ct-textarea.ts";

// NOTE: Full DOM interaction tests (input events, Cell two-way binding,
// auto-resize, timing strategy integration) require Lit's rendering
// pipeline and shadow DOM. Tests below cover property defaults, Cell
// property acceptance, and basic configuration.

describe("CTTextarea", () => {
  it("should be defined", () => {
    expect(CTTextarea).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(customElements.get("ct-textarea")).toBe(CTTextarea);
  });

  it("should create element instance", () => {
    const element = new CTTextarea();
    expect(element).toBeInstanceOf(CTTextarea);
  });

  it("should have correct default properties", () => {
    const el = new CTTextarea();
    expect(el.placeholder).toBe("");
    expect(el.value).toBe("");
    expect(el.disabled).toBe(false);
    expect(el.readonly).toBe(false);
    expect(el.error).toBe(false);
    expect(el.rows).toBe(4);
    expect(el.name).toBe("");
    expect(el.required).toBe(false);
    expect(el.autoResize).toBe(false);
    expect(el.timingStrategy).toBe("debounce");
    expect(el.timingDelay).toBe(300);
  });

  it("should accept a CellHandle as value property", () => {
    const el = new CTTextarea();
    const cell = createMockCellHandle("multi\nline\ntext");
    el.value = cell;
    expect(el.value).toBe(cell);
  });

  it("should accept a plain string as value property", () => {
    const el = new CTTextarea();
    el.value = "hello world";
    expect(el.value).toBe("hello world");
  });

  it("should accept timing strategy options", () => {
    const el = new CTTextarea();
    el.timingStrategy = "immediate";
    expect(el.timingStrategy).toBe("immediate");

    el.timingStrategy = "blur";
    expect(el.timingStrategy).toBe("blur");

    el.timingDelay = 500;
    expect(el.timingDelay).toBe(500);
  });

  it("should accept auto-resize option", () => {
    const el = new CTTextarea();
    el.autoResize = true;
    expect(el.autoResize).toBe(true);
  });

  it("should accept rows and cols", () => {
    const el = new CTTextarea();
    el.rows = 10;
    el.cols = 40;
    expect(el.rows).toBe(10);
    expect(el.cols).toBe(40);
  });
});
