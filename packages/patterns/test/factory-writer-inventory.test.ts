import { assertEquals } from "@std/assert";
import { fromFileUrl, join, relative } from "@std/path";

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (entry.name === "deprecated" || entry.name === "test") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory) files.push(...await sourceFiles(path));
    else if (entry.isFile && /\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

Deno.test("production sources author inline factories and ordinary list callbacks", async () => {
  const patterns = fromFileUrl(new URL("../", import.meta.url));
  const background = fromFileUrl(
    new URL("../../background-piece-service/", import.meta.url),
  );
  const hits: string[] = [];

  for (const root of [patterns, background]) {
    for (const path of await sourceFiles(root)) {
      const source = (await Deno.readTextFile(path))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      const call =
        /\bpatternTool\s*\(|\.(?:map|filter|flatMap)WithPattern\s*\(/g;
      for (const match of source.matchAll(call)) {
        const line = source.slice(0, match.index).split("\n").length;
        hits.push(`${relative(patterns, path)}:${line}`);
      }
    }
  }

  assertEquals(hits.sort(), []);
});
