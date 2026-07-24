import { parse as parseJsonc } from "@std/jsonc";

function sourceCoveragePath(name: string): string {
  return new URL(name, import.meta.url).pathname;
}

/**
 * Builds the child's import map, written to a temp file and returned as a path.
 *
 * The child runs changed pattern modules as plain code under Deno's V8 coverage,
 * with the pattern runtime (transformer + sandbox) out of the picture. The
 * `commonfabric` reactive surface is swapped for `commonfabric-stub.test.ts`
 * (those primitives need the real runtime), but the pure `data-model` helpers
 * stay real, so the child also produces coverage for the `data-model`/
 * `content-hash`/`leb128` code the pattern runtime exercises.
 *
 * A flat `--import-map` replaces the workspace's `imports`/`scopes`, so the real
 * graph's dependencies must be present in it. Rather than hand-maintain (and
 * keep in sync with root) a checked-in map, this derives it: it inherits the
 * root `deno.jsonc` `imports` verbatim — so npm versions have a single source of
 * truth and cannot drift — adds a trailing-slash form per npm/jsr entry so
 * package subpaths (e.g. `@noble/hashes/sha2.js`) resolve under the flat map,
 * then layers on the `commonfabric` overrides and the per-package `@/` scopes
 * the foundation packages use internally. Relative root targets are absolutized
 * so the map works from its temp location. A foundation package that later
 * enters the graph with its own `@/` alias fails loudly here until added.
 */
async function writeChildImportMap(): Promise<string> {
  const here = new URL("./", import.meta.url);
  const rootUrl = new URL("../../../../deno.jsonc", import.meta.url);
  const root = parseJsonc(await Deno.readTextFile(rootUrl)) as {
    imports: Record<string, string>;
  };

  const imports: Record<string, string> = {};
  for (const [key, target] of Object.entries(root.imports)) {
    if (/^\.\.?\//.test(target)) {
      imports[key] = new URL(target, rootUrl).href;
    } else {
      imports[key] = target;
      if (target.startsWith("npm:")) {
        imports[`${key}/`] = `npm:/${target.slice(4)}/`;
      }
      if (target.startsWith("jsr:")) {
        imports[`${key}/`] = `jsr:/${target.slice(4)}/`;
      }
    }
  }
  imports["commonfabric"] = new URL("commonfabric-stub.test.ts", here).href;
  imports["@commonfabric/html/jsx-runtime"] =
    new URL("jsx-runtime-stub.test.ts", here).href;

  const scopeFor = (pkgSrc: string) => new URL(pkgSrc, here).href;
  const scopes: Record<string, Record<string, string>> = {};
  for (
    const src of [
      "../../../data-model/src/",
      "../../../content-hash/src/",
      "../../../leb128/src/",
    ]
  ) {
    const url = scopeFor(src);
    scopes[url] = { "@/": url };
  }

  const path = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(path, JSON.stringify({ imports, scopes }, null, 2));
  return path;
}

Deno.test("pattern source coverage harness exercises changed pattern modules", async () => {
  const importMapPath = await writeChildImportMap();
  try {
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "-A",
        "--no-check",
        "--config",
        sourceCoveragePath("../../deno.jsonc"),
        "--import-map",
        importMapPath,
        sourceCoveragePath("fixtures/pattern-source-coverage-child.js"),
      ],
      env: { SOURCE_COVERAGE_CHILD: "1" },
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    if (result.success) return;

    const decoder = new TextDecoder();
    throw new Error(
      [
        "pattern source coverage child test failed",
        decoder.decode(result.stdout),
        decoder.decode(result.stderr),
      ].join("\n"),
    );
  } finally {
    await Deno.remove(importMapPath);
  }
});
