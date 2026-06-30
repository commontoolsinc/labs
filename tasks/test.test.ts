import { assertEquals } from "@std/assert";
import { parseDisabledPackageList, readWorkspaceMembers } from "./test.ts";

Deno.test("parseDisabledPackageList parses comma and whitespace separated names", () => {
  assertEquals(parseDisabledPackageList("runner, ui\nshell\tcli"), [
    "runner",
    "ui",
    "shell",
    "cli",
  ]);
});

Deno.test("parseDisabledPackageList ignores empty entries", () => {
  assertEquals(parseDisabledPackageList(" runner, ,ui "), ["runner", "ui"]);
  assertEquals(parseDisabledPackageList(undefined), []);
});

Deno.test("readWorkspaceMembers reads the workspace list from a JSONC manifest", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ws-members-" });
  try {
    const configPath = `${dir}/deno.jsonc`;
    // Comments must not break parsing — that is the whole point of the JSONC
    // parser here.
    await Deno.writeTextFile(
      configPath,
      `{
  // workspace packages
  "workspace": ["./packages/a", "./packages/b"]
}
`,
    );
    assertEquals(await readWorkspaceMembers(configPath), [
      "./packages/a",
      "./packages/b",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
