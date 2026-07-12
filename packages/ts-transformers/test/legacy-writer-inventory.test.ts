import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory) files.push(...await filesUnder(path));
    else if (entry.isFile) files.push(path);
  }
  return files.sort();
}

Deno.test("deprecated patternTool has only an explicitly named routing kind", async () => {
  const src = fromFileUrl(new URL("../src", import.meta.url));
  const hits: string[] = [];
  for (const path of await filesUnder(src)) {
    if (!path.endsWith(".ts")) continue;
    const text = await Deno.readTextFile(path);
    for (const token of ["patternTool", "legacy-pattern-tool"]) {
      if (text.includes(token)) {
        hits.push(`${path.slice(src.length + 1)}:${token}`);
      }
    }
  }

  assertEquals(hits, [
    "ast/call-kind.ts:legacy-pattern-tool",
    "core/commonfabric-runtime-registry.ts:patternTool",
    "core/commonfabric-runtime-registry.ts:legacy-pattern-tool",
    "transformers/expression-site-policy.ts:legacy-pattern-tool",
    "transformers/reactive-variable-for.ts:legacy-pattern-tool",
  ]);
});

Deno.test("only explicitly named legacy fixtures emit extraParams", async () => {
  const fixtures = fromFileUrl(
    new URL("./fixtures/closures", import.meta.url),
  );
  const legacyFiles = (await filesUnder(fixtures))
    .filter((path) => path.split("/").at(-1)?.startsWith("patternTool-"))
    .map((path) => path.split("/").at(-1));
  assertEquals(legacyFiles, [
    "patternTool-basic-capture.expected.jsx",
    "patternTool-basic-capture.input.tsx",
    "patternTool-no-captures.expected.jsx",
    "patternTool-no-captures.input.tsx",
  ]);

  const expectedWithExtraParams: string[] = [];
  for (const path of await filesUnder(fixtures)) {
    if (!path.includes(".expected.")) continue;
    if ((await Deno.readTextFile(path)).includes("extraParams")) {
      expectedWithExtraParams.push(path.split("/").at(-1)!);
    }
  }
  assertEquals(expectedWithExtraParams, [
    "patternTool-basic-capture.expected.jsx",
    "patternTool-no-captures.expected.jsx",
  ]);
});
