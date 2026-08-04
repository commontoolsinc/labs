import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  SKIP_VERSION_CHECK_ENV,
  startVersionCheck,
  versionMismatchWarning,
} from "../lib/version-check.ts";
import type { ShaRelation } from "../lib/build-info.ts";

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

  await t.step(
    "undirected mismatch names both commits, the host, and the override",
    () => {
      const warning = versionMismatchWarning("aaa111", "bbb222", API);
      assert(warning !== null);
      assertStringIncludes(warning, "aaa111");
      assertStringIncludes(warning, "bbb222");
      assertStringIncludes(warning, "http://localhost:8000");
      assertStringIncludes(warning, SKIP_VERSION_CHECK_ENV);
      assertStringIncludes(warning, "different versions");
    },
  );

  await t.step("cli-ahead reads as the mild, normal-in-dev case", () => {
    const warning = versionMismatchWarning("aaa111", "bbb222", API, {
      kind: "cli-ahead",
      serverBehindBy: 7,
    });
    assert(warning !== null);
    assertStringIncludes(warning, "newer than the server");
    assertStringIncludes(warning, "7 commit(s) behind");
    assertStringIncludes(warning, "redeploy");
    assert(!warning.includes("OUTDATED"));
  });

  await t.step("cli-ahead tolerates an uncountable distance", () => {
    const warning = versionMismatchWarning("aaa111", "bbb222", API, {
      kind: "cli-ahead",
      serverBehindBy: null,
    });
    assert(warning !== null);
    assertStringIncludes(warning, "is behind");
  });

  await t.step("cli-behind is the loud case", () => {
    const warning = versionMismatchWarning("aaa111", "bbb222", API, {
      kind: "cli-behind",
    });
    assert(warning !== null);
    assertStringIncludes(warning, "OUTDATED");
    assertStringIncludes(warning, "likely fail");
    assertStringIncludes(warning, SKIP_VERSION_CHECK_ENV);
  });

  await t.step("diverged names the divergence", () => {
    const warning = versionMismatchWarning("aaa111", "bbb222", API, {
      kind: "diverged",
    });
    assert(warning !== null);
    assertStringIncludes(warning, "diverged");
  });

  await t.step("reduces the api url to its origin", () => {
    const warning = versionMismatchWarning(
      "aaa111",
      "bbb222",
      "http://localhost:8000/some/path",
    );
    assert(warning !== null);
    assertStringIncludes(warning, "http://localhost:8000");
    assert(!warning.includes("/some/path"));
  });
});

/** Deps whose every effect records itself, so skipping is observable. */
function recordingDeps(
  envValue: string | undefined,
  options: {
    checkoutDir?: string | null;
    relation?: ShaRelation;
  } = {},
) {
  const calls: string[] = [];
  const warnings: string[] = [];
  return {
    calls,
    warnings,
    deps: {
      env: (key: string) =>
        key === SKIP_VERSION_CHECK_ENV ? envValue : undefined,
      resolveCliVersion: () => {
        calls.push("resolveCliVersion");
        return Promise.resolve({
          sha: "aaa111",
          checkoutDir: options.checkoutDir ?? null,
        });
      },
      relate: (_dir: string, _cli: string, _server: string) => {
        calls.push("relate");
        return Promise.resolve<ShaRelation>(
          options.relation ?? { kind: "unknown" },
        );
      },
      warn: (message: string) => {
        calls.push("warn");
        warnings.push(message);
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
      assertEquals(calls, ["resolveCliVersion", "warn"]);
    }
  });

  await t.step("matching commits resolve but do not warn", async () => {
    const { calls, deps } = recordingDeps(undefined);
    await startVersionCheck(deps).finish("aaa111", API);
    assertEquals(calls, ["resolveCliVersion"]);
  });

  await t.step(
    "a checkout orders the mismatch and grades the warning",
    async () => {
      const { calls, warnings, deps } = recordingDeps(undefined, {
        checkoutDir: "/some/checkout/packages/cli/lib",
        relation: { kind: "cli-behind" },
      });
      await startVersionCheck(deps).finish("bbb222", API);
      assertEquals(calls, ["resolveCliVersion", "relate", "warn"]);
      assertStringIncludes(warnings[0]!, "OUTDATED");
    },
  );

  await t.step(
    "no checkout (compiled binary): no ordering attempted, undirected warning",
    async () => {
      const { calls, warnings, deps } = recordingDeps(undefined, {
        checkoutDir: null,
        relation: { kind: "cli-behind" }, // must not be consulted
      });
      await startVersionCheck(deps).finish("bbb222", API);
      assertEquals(calls, ["resolveCliVersion", "warn"]);
      assertStringIncludes(warnings[0]!, "different versions");
    },
  );

  await t.step("a rejecting resolver is swallowed, not thrown", async () => {
    const { calls, deps } = recordingDeps(undefined);
    deps.resolveCliVersion = () => Promise.reject(new Error("git exploded"));
    await startVersionCheck(deps).finish("bbb222", API);
    assertEquals(calls, []);
  });

  await t.step(
    "a rejecting relate degrades to the undirected warning",
    async () => {
      const { calls, warnings, deps } = recordingDeps(undefined, {
        checkoutDir: "/some/checkout/packages/cli/lib",
      });
      deps.relate = () => Promise.reject(new Error("git exploded"));
      await startVersionCheck(deps).finish("bbb222", API);
      assertEquals(calls, ["resolveCliVersion", "warn"]);
      assertStringIncludes(warnings[0]!, "different versions");
    },
  );
});
