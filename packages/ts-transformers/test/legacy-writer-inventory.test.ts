import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join, relative } from "@std/path";

async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (
      entry.isDirectory &&
      !["test", "tests", "fixtures", "vendor"].includes(entry.name)
    ) {
      files.push(...await filesUnder(path));
    } else if (entry.isFile && path.endsWith(".ts")) files.push(path);
  }
  return files.sort();
}

Deno.test("removed legacy factory APIs and writers stay absent", async () => {
  const packageRoot = dirname(dirname(fromFileUrl(import.meta.url)));
  const repoRoot = dirname(dirname(packageRoot));
  const roots = [join(repoRoot, "packages")];
  const forbidden = [
    "patternTool",
    "PatternToolResult",
    "PatternToolFunction",
    "extraParams",
  ];
  const hits: string[] = [];

  for (const root of roots) {
    for (const path of await filesUnder(root)) {
      if (path.endsWith(".test.ts") || path.endsWith("_test.ts")) continue;
      const source = await Deno.readTextFile(path);
      for (const token of forbidden) {
        if (source.includes(token)) {
          hits.push(`${relative(repoRoot, path)}:${token}`);
        }
      }
    }
  }

  assertEquals(hits, []);
});
