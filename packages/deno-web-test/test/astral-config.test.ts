/**
 * What `extractAstralConfig()` hands a launch, and the one decision in it: a
 * `path` is supplied only for the product the search knows how to find.
 *
 * Every case here pins `ASTRAL_BIN_PATH` to a file that certainly exists, so
 * that what the search would have found on the machine running the tests never
 * enters into it. An assertion conditional on the answer would pass on a
 * machine with no browser, which is to say it would pass for the regression.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { extractAstralConfig } from "../config.ts";

/** A path that exists, whatever machine this runs on: this file. */
const EXISTING_FILE = new URL(import.meta.url).pathname;

/** Runs the body with `ASTRAL_BIN_PATH` set as given, then puts it back. */
function withBinaryOverride(value: string | undefined, body: () => void) {
  const previous = Deno.env.get("ASTRAL_BIN_PATH");
  if (value === undefined) {
    Deno.env.delete("ASTRAL_BIN_PATH");
  } else {
    Deno.env.set("ASTRAL_BIN_PATH", value);
  }
  try {
    body();
  } finally {
    if (previous === undefined) {
      Deno.env.delete("ASTRAL_BIN_PATH");
    } else {
      Deno.env.set("ASTRAL_BIN_PATH", previous);
    }
  }
}

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
      withBinaryOverride(EXISTING_FILE, () => {
        expect(extractAstralConfig({}).path).toBe(EXISTING_FILE);
      });
    });

    it('supplies one for `product: "chrome"`', () => {
      withBinaryOverride(EXISTING_FILE, () => {
        expect(extractAstralConfig({ product: "chrome" }).path)
          .toBe(EXISTING_FILE);
      });
    });

    it('supplies none for `product: "firefox"`', () => {
      // The search finds Chrome and Chromium, so handing its answer to a
      // Firefox launch would name the wrong browser outright. Leaving `path`
      // unset gives the whole question back to astral, which resolves Firefox
      // the way it did before any of this existed -- including reading
      // `ASTRAL_BIN_PATH` itself, which is why one being set here must still
      // produce no `path`.
      withBinaryOverride(EXISTING_FILE, () => {
        expect(extractAstralConfig({ product: "firefox" }).path)
          .toBe(undefined);
      });
    });
  });
});
