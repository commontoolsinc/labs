import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  SKIP_VERSION_CHECK_ENV,
  startVersionCheck,
  versionMismatchWarning,
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

/** Deps whose every effect records itself, so skipping is observable. */
function recordingDeps(envValue: string | undefined) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      env: (key: string) =>
        key === SKIP_VERSION_CHECK_ENV ? envValue : undefined,
      resolveCliSha: () => {
        calls.push("resolveCliSha");
        return Promise.resolve("aaa111");
      },
      warn: (_message: string) => {
        calls.push("warn");
      },
    },
  };
}

Deno.test("startVersionCheck", async (t) => {
  await t.step(
    "skip env set: resolves nothing and warns nothing, even on mismatch",
    async () => {
      const { calls, deps } = recordingDeps("1");
      await startVersionCheck(deps).finish("bbb222", API);
      assertEquals(calls, []);
    },
  );

  await t.step(
    "any non-empty value skips, including '0' and 'false'",
    async () => {
      for (const value of ["0", "false"]) {
        const { calls, deps } = recordingDeps(value);
        await startVersionCheck(deps).finish("bbb222", API);
        assertEquals(calls, []);
      }
    },
  );

  await t.step("empty/unset does not skip: resolves and warns", async () => {
    for (const value of [undefined, ""]) {
      const { calls, deps } = recordingDeps(value);
      await startVersionCheck(deps).finish("bbb222", API);
      assertEquals(calls, ["resolveCliSha", "warn"]);
    }
  });

  await t.step("matching commits resolve but do not warn", async () => {
    const { calls, deps } = recordingDeps(undefined);
    await startVersionCheck(deps).finish("aaa111", API);
    assertEquals(calls, ["resolveCliSha"]);
  });

  await t.step("a rejecting resolver is swallowed, not thrown", async () => {
    const { calls, deps } = recordingDeps(undefined);
    deps.resolveCliSha = () => Promise.reject(new Error("git exploded"));
    await startVersionCheck(deps).finish("bbb222", API);
    assertEquals(calls, []);
  });
});
