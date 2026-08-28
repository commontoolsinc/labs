/**
 * What `extractAstralConfig()` hands a launch, and the one decision in it: a
 * `path` is supplied only for the product the search knows how to find.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { extractAstralConfig } from "../config.ts";

describe("extractAstralConfig()", () => {
  it("carries the settings it is given", () => {
    const config = extractAstralConfig({
      headless: false,
      args: ["--flag"],
    });

    expect(config.headless).toBe(false);
    expect(config.args).toEqual(["--flag"]);
  });

  describe("the browser binary", () => {
    it("supplies one for an unstated product, which astral takes as Chrome", () => {
      // Only meaningful where a browser is actually installed; where none is,
      // no path is the right answer and astral downloads as before.
      const path = extractAstralConfig({}).path;
      if (path !== undefined) expect(Deno.statSync(path).isFile).toBe(true);
    });

    it('supplies one for `product: "chrome"`', () => {
      const path = extractAstralConfig({ product: "chrome" }).path;
      if (path !== undefined) expect(Deno.statSync(path).isFile).toBe(true);
    });

    it('supplies none for `product: "firefox"`', () => {
      // The search finds Chrome and Chromium, so handing its answer to a
      // Firefox launch would name the wrong browser outright. Leaving `path`
      // unset gives the whole question back to astral, which resolves Firefox
      // the way it did before any of this existed.
      expect(extractAstralConfig({ product: "firefox" }).path).toBe(undefined);
    });
  });
});
