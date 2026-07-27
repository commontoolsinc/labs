import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { dashboardVersion } from "./version.ts";

const FIRST_COMMIT = "1".repeat(40);
const SECOND_COMMIT = "a".repeat(40);

Deno.test("dashboard version uses the deployed image commit", () => {
  assertEquals(
    dashboardVersion(
      (name) => name === "DASHBOARD_GIT_COMMIT" ? FIRST_COMMIT : undefined,
      () => {
        throw new Error("Git must not run for a deployed image");
      },
    ),
    FIRST_COMMIT,
  );
});

Deno.test("dashboard version reads the current commit for local development", () => {
  assertEquals(
    dashboardVersion(() => undefined, () => SECOND_COMMIT),
    SECOND_COMMIT,
  );
});

Deno.test("dashboard version rejects missing or abbreviated commits", () => {
  for (const version of ["", "abc123", "g".repeat(40)]) {
    assertThrows(
      () => dashboardVersion(() => version, () => FIRST_COMMIT),
      Error,
      "Dashboard Git commit must be a full 40-character lowercase hash.",
    );
  }
});

Deno.test("local dashboard version matches the checked-out commit", () => {
  const result = new Deno.Command("git", {
    args: ["rev-parse", "--verify", "HEAD^{commit}"],
    cwd: new URL("../../", import.meta.url),
    stdout: "piped",
  }).outputSync();
  assertEquals(result.success, true);
  assertEquals(
    dashboardVersion(() => undefined),
    new TextDecoder().decode(result.stdout).trim(),
  );
});

Deno.test("dashboard image requires the publishing workflow commit", async () => {
  const dockerfile = await Deno.readTextFile(
    new URL("../../Dockerfile.dashboard", import.meta.url),
  );
  assertStringIncludes(dockerfile, "ARG DASHBOARD_GIT_COMMIT");
  assertStringIncludes(
    dockerfile,
    "ENV DASHBOARD_GIT_COMMIT=${DASHBOARD_GIT_COMMIT}",
  );
  assertStringIncludes(
    dockerfile,
    "grep -Eq '^[0-9a-f]{40}$'",
  );

  const readme = await Deno.readTextFile(
    new URL("./README.md", import.meta.url),
  );
  assertStringIncludes(
    readme,
    '--build-arg DASHBOARD_GIT_COMMIT="$SHA"',
  );
});
