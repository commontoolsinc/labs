import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import config from "../../console/felt.config.ts";

describe("felt.config", () => {
  const consoleRoot = fromFileUrl(new URL("../../console", import.meta.url));

  /** Every script a served page asks the browser to load. */
  const scriptsNamedBy = (page: string): readonly string[] => {
    const markup = Deno.readTextFileSync(join(consoleRoot, "public", page));
    return [...markup.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) =>
      match[1]
    );
  };

  it("emits a bundle for every script the console's pages name", () => {
    // A page whose script has no entry is served, loads nothing, and shows an
    // empty body with no error anywhere — so what the markup asks for and what
    // the build emits are pinned against each other rather than kept in
    // agreement by hand.
    const emitted = config.entries.map((entry) => `/${entry.out}.js`);

    for (const page of ["index.html", "live.html"]) {
      for (const script of scriptsNamedBy(page)) {
        expect(emitted).toContain(script);
      }
    }
  });

  it("builds each entry from a source file that is there", () => {
    for (const entry of config.entries) {
      expect(Deno.statSync(join(consoleRoot, entry.in)).isFile).toBe(true);
    }
  });

  it("serves the built pages from the directory the server reads", () => {
    // `ConsoleServer.#asset` resolves against `dist/`, and the page files come
    // from `publicDir`; a build writing anywhere else serves nothing.
    expect(config.outDir).toBe("dist");
    expect(config.publicDir).toBe("public");
  });
});
