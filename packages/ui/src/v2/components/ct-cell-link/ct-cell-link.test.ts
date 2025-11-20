import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTCellLink } from "./ct-cell-link.ts";

describe("CTCellLink", () => {
  it("should be defined", () => {
    expect(CTCellLink).toBeDefined();
  });

  it("should have customElement definition", () => {
    const definition = customElements.get("ct-cell-link");
    expect(definition).toBeDefined();
    expect(definition).toBe(CTCellLink);
  });

  it("should create element instance", () => {
    const element = new CTCellLink();
    expect(element).toBeInstanceOf(CTCellLink);
  });

  it("should have default properties", () => {
    const element = new CTCellLink();
    expect(element.link).toBeUndefined();
    expect(element.cell).toBeUndefined();
    expect(element.runtime).toBeUndefined();
    expect(element.space).toBeUndefined();
  });
});
