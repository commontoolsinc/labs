import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CTRender } from "./ct-render.ts";

class FakeCell {
  runtime = {
    recipeManager: { loadRecipe: async () => {} },
    runSynced: async () => {},
  };
  space = "fake-space";
  #path: string[];
  constructor(path: string[] = []) {
    this.#path = path;
  }
  async sync() {}
  equals(other: unknown) {
    return other === this;
  }
  getAsNormalizedFullLink() {
    return {
      id: "of:fake",
      space: this.space,
      type: "application/json",
      path: this.#path,
    };
  }
  getSourceCell() {
    return {
      get: () => ({ $TYPE: "fake-recipe" }),
    };
  }
}

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

  it("loads recipe even when cell path is non-empty", async () => {
    const element = new CTRender();
    (element as any)._renderContainer = {};
    const cell = new FakeCell(["charms", "0"]) as any;

    const loadCalls: string[] = [];
    (element as any)._loadAndRenderRecipe = async (recipeId: string) => {
      loadCalls.push(recipeId);
    };

    const renderCalls: unknown[] = [];
    (element as any)._renderUiFromCell = async (c: unknown) => {
      renderCalls.push(c);
    };

    (element as any).cell = cell;
    await (element as any)._renderCell();

    expect(loadCalls).toEqual(["fake-recipe"]);
    expect(renderCalls.length).toBe(0);
  });
});
