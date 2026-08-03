import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  fetchServerGitSha,
  SKIP_VERSION_CHECK_ENV,
  versionMismatchWarning,
  warnOnVersionMismatch,
} from "../lib/version-check.ts";

const API = "http://localhost:8000";

Deno.test("versionMismatchWarning", async (t) => {
  await t.step("null when either side is unknown", () => {
    assertEquals(versionMismatchWarning(null, "abc", API), null);
    assertEquals(versionMismatchWarning("abc", null, API), null);
    assertEquals(versionMismatchWarning(null, null, API), null);
  });

  await t.step("null when both sides match", () => {
    assertEquals(versionMismatchWarning("abc123", "abc123", API), null);
  });

  await t.step("names both commits, the host, and the override", () => {
    const warning = versionMismatchWarning("aaa111", "bbb222", API);
    assert(warning !== null);
    assertStringIncludes(warning, "aaa111");
    assertStringIncludes(warning, "bbb222");
    assertStringIncludes(warning, "http://localhost:8000");
    assertStringIncludes(warning, SKIP_VERSION_CHECK_ENV);
  });

  await t.step("reduces the api url to its origin", () => {
    const warning = versionMismatchWarning(
      "aaa111",
      "bbb222",
      "http://localhost:8000/some/path",
    );
    assert(warning !== null);
    assertStringIncludes(warning, "(http://localhost:8000)");
  });
});

Deno.test("fetchServerGitSha returns null instead of throwing when the fetch fails", async () => {
  // The test task grants no net permission, so the fetch fails immediately;
  // the helper must swallow that (connectivity is the health check's job).
  assertEquals(await fetchServerGitSha("http://localhost:9"), null);
});

Deno.test("warnOnVersionMismatch is skipped entirely by the env override", async () => {
  // With the override set, the check resolves without touching git or the
  // network — observable here because neither failure mode surfaces.
  await warnOnVersionMismatch("http://localhost:9", {
    env: (key) => key === SKIP_VERSION_CHECK_ENV ? "1" : undefined,
  });
});
