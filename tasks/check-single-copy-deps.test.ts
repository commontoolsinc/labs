import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl } from "@std/path";
import {
  copiesOf,
  findProblems,
  main,
  packageNameOf,
  SINGLE_COPY_PACKAGES,
} from "./check-single-copy-deps.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

// npm entry keys as deno.lock writes them: `name@version`, optionally with a
// `_peer@version` suffix, and the name itself may be scoped.
function singleCopyLock(): { npm: Record<string, unknown> } {
  return {
    npm: {
      "ai@7.0.30_zod@3.25.76": {},
      "@ai-sdk/provider-utils@5.0.10_zod@3.25.76": {},
      "@arizeai/openinference-semantic-conventions@2.5.0": {},
      // Two copies of a package that tolerates them; must not be reported.
      "gaxios@6.7.1": {},
      "gaxios@7.2.0": {},
    },
  };
}

Deno.test("packageNameOf splits the name from the version and peer suffix", () => {
  assertEquals(packageNameOf("ai@7.0.30_zod@3.25.76"), "ai");
  assertEquals(
    packageNameOf("@ai-sdk/provider-utils@5.0.10_zod@3.25.76"),
    "@ai-sdk/provider-utils",
  );
  assertEquals(
    packageNameOf("@arizeai/openinference-semantic-conventions@2.5.0"),
    "@arizeai/openinference-semantic-conventions",
  );
  assertEquals(packageNameOf("gaxios@6.7.1"), "gaxios");
});

Deno.test("copiesOf groups every entry under its package name", () => {
  const copies = copiesOf(singleCopyLock());
  assertEquals(copies.get("ai"), ["ai@7.0.30_zod@3.25.76"]);
  assertEquals(copies.get("gaxios"), ["gaxios@6.7.1", "gaxios@7.2.0"]);
});

Deno.test("findProblems reports nothing when each package resolves once", () => {
  assertEquals(findProblems(singleCopyLock()), []);
});

// The shape of the bug this check exists for: rolling the arizeai packages
// alone leaves the AI SDK resolved twice, once for toolshed and once for
// @ai-sdk/otel.
Deno.test("findProblems reports a package resolved twice", () => {
  const lock = singleCopyLock();
  lock.npm["ai@5.0.27_zod@3.25.76"] = {};

  const problems = findProblems(lock);
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "ai: resolved 2 times, must be 1");
  assertStringIncludes(problems[0], "ai@5.0.27_zod@3.25.76");
  assertStringIncludes(problems[0], "ai@7.0.30_zod@3.25.76");
});

// A package that disappears from the lockfile would otherwise pass silently,
// which would make this check quietly stop covering it.
Deno.test("findProblems reports a package missing from the lockfile", () => {
  const problems = findProblems({ npm: {} }, { ai: "the AI SDK" });
  assertEquals(problems.length, 1);
  assertStringIncludes(problems[0], "not in deno.lock at all");
});

Deno.test("findProblems does not report packages outside the list", () => {
  assertEquals(findProblems(singleCopyLock(), {}), []);
});

Deno.test("the repository's own lockfile passes", async () => {
  assertEquals(await main(REPO_ROOT), 0);
});

Deno.test("every guarded package names what breaks when it is duplicated", () => {
  for (const [name, reason] of Object.entries(SINGLE_COPY_PACKAGES)) {
    assertEquals(typeof reason, "string", `${name} has no reason`);
    assertEquals(reason.length > 0, true, `${name} has an empty reason`);
  }
});
