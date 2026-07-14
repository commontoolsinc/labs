import { assertEquals } from "@std/assert";
import * as path from "@std/path";
import {
  collectCoverageProfileFiles,
  removeUnusableCoverageProfiles,
} from "./write-coverage-lcov.ts";

function coverageProfileFor(url: string): string {
  return JSON.stringify({
    scriptId: "1",
    url,
    functions: [
      {
        functionName: "",
        ranges: [
          { startOffset: 0, endOffset: 1, count: 1 },
        ],
        isBlockCoverage: true,
      },
    ],
  });
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await Deno.stat(file);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("collectCoverageProfileFiles finds nested profile files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "write-coverage-lcov-" });
  try {
    const rootProfile = path.join(dir, "root.json");
    const nestedProfile = path.join(dir, "nested", "profile.json");
    const ignoredFile = path.join(dir, "nested", "profile.txt");

    await Deno.mkdir(path.dirname(nestedProfile), { recursive: true });
    await Deno.writeTextFile(rootProfile, "{}");
    await Deno.writeTextFile(nestedProfile, "{}");
    await Deno.writeTextFile(ignoredFile, "{}");

    assertEquals(
      (await collectCoverageProfileFiles(dir)).sort(),
      [nestedProfile, rootProfile].sort(),
    );
    assertEquals(
      await collectCoverageProfileFiles(path.join(dir, "absent")),
      [],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("removeUnusableCoverageProfiles removes empty and invalid profile files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "write-coverage-lcov-" });
  try {
    const validProfile = path.join(dir, "valid.json");
    const emptyProfile = path.join(dir, "empty.json");
    const malformedProfile = path.join(dir, "malformed.json");
    const invalidProfile = path.join(dir, "invalid.json");
    const nestedValidProfile = path.join(dir, "nested", "valid.json");

    await Deno.mkdir(path.dirname(nestedValidProfile), { recursive: true });
    await Deno.writeTextFile(
      validProfile,
      coverageProfileFor(`file://${validProfile}`),
    );
    await Deno.writeTextFile(emptyProfile, "");
    await Deno.writeTextFile(malformedProfile, '{"coverage":');
    await Deno.writeTextFile(invalidProfile, "{}");
    await Deno.writeTextFile(
      nestedValidProfile,
      coverageProfileFor(`file://${nestedValidProfile}`),
    );

    const removed = await removeUnusableCoverageProfiles([
      validProfile,
      emptyProfile,
      malformedProfile,
      invalidProfile,
      nestedValidProfile,
    ]);

    assertEquals(removed, { empty: 1, invalid: 2 });
    assertEquals(await pathExists(validProfile), true);
    assertEquals(await pathExists(emptyProfile), false);
    assertEquals(await pathExists(malformedProfile), false);
    assertEquals(await pathExists(invalidProfile), false);
    assertEquals(await pathExists(nestedValidProfile), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
