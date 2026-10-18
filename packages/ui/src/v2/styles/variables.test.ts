import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { variablesCSS } from "./variables.ts";

describe("variablesCSS", () => {
  it("derives nothing from the theme", () => {
    // Every base-styled component declares variablesCSS on its host, so a
    // variable in it derived from `--cf-theme-*` is fixed to the theme around
    // that component, and no tint beneath reaches it. Such a variable is
    // declared by the components that read it (see `surfaceRecipesCSS`).
    const declarations = variablesCSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations).not.toContain("var(--cf-theme-");
    expect(declarations).toContain("--cf-spacing-4:");
  });
});
