import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTRender } from "./ct-render.ts";

describe("CTRender", () => {
  it("should be defined", () => {
    expect(CTRender).toBeDefined();
  });

  it("should have customElement definition", () => {
    expect(CTRender.name).toBe("CTRender");
  });

  it("should create element instance", () => {
    const element = new CTRender();
    expect(element).toBeInstanceOf(CTRender);
  });

  it("should have cell property", () => {
    const element = new CTRender();
    expect(element.cell).toBeUndefined();
  });
});
