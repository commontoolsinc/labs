import { assertEquals } from "@std/assert";
import * as path from "@std/path";
import { removeUnusableCoverageProfiles } from "./write-coverage-lcov.ts";

async function exists(file: string): Promise<boolean> {
  try {
    await Deno.stat(file);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("removeUnusableCoverageProfiles removes empty and invalid profile files", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "coverage-profile-test-" });
  try {
    const validProfile = path.join(rootDir, "valid.json");
    const emptyProfile = path.join(rootDir, "empty.json");
    const invalidProfile = path.join(rootDir, "invalid.json");

    await Deno.writeTextFile(validProfile, JSON.stringify([]));
    await Deno.writeTextFile(emptyProfile, "");
    await Deno.writeTextFile(invalidProfile, "[");

    assertEquals(
      await removeUnusableCoverageProfiles([
        validProfile,
        emptyProfile,
        invalidProfile,
      ]),
      { empty: 1, invalid: 1 },
    );
    assertEquals(await exists(validProfile), true);
    assertEquals(await exists(emptyProfile), false);
    assertEquals(await exists(invalidProfile), false);
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});
