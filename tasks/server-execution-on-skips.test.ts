import { assertEquals, assertMatch } from "@std/assert";
import {
  isServerExecutionSuite,
  SERVER_EXECUTION_ON_SKIPS,
  serverExecutionOnIgnoreArg,
  serverExecutionOnSkipReport,
  validateServerExecutionOnSkips,
} from "./server-execution-on-skips.ts";

Deno.test("every skip entry names an existing file (no stale lists)", async () => {
  const problems = await validateServerExecutionOnSkips(
    new URL("../", import.meta.url),
  );
  assertEquals(problems, []);
});

Deno.test("an empty list yields no --ignore flag and says the full suite runs", () => {
  for (const suite of ["patterns", "runner", "runtime-client", "shell"]) {
    if (!isServerExecutionSuite(suite)) throw new Error("unreachable");
    if (SERVER_EXECUTION_ON_SKIPS[suite].length > 0) continue;
    assertEquals(serverExecutionOnIgnoreArg(suite), "");
    assertMatch(
      serverExecutionOnSkipReport(suite),
      /no skips — full suite runs/,
    );
  }
});

Deno.test("a populated list produces one --ignore flag and a per-entry report", () => {
  const saved = SERVER_EXECUTION_ON_SKIPS.runner;
  SERVER_EXECUTION_ON_SKIPS.runner = [
    {
      file: "integration/example-a.test.ts",
      phase: "phase-3",
      reason: "exercises events-down handler semantics",
    },
    {
      file: "integration/example-b.test.ts",
      phase: "phase-5",
      reason: "cross-space serving",
    },
  ];
  try {
    assertEquals(
      serverExecutionOnIgnoreArg("runner"),
      "--ignore=integration/example-a.test.ts,integration/example-b.test.ts",
    );
    const report = serverExecutionOnSkipReport("runner");
    assertMatch(
      report,
      /SKIP integration\/example-a\.test\.ts \(until phase-3\)/,
    );
    assertMatch(
      report,
      /SKIP integration\/example-b\.test\.ts \(until phase-5\)/,
    );
  } finally {
    SERVER_EXECUTION_ON_SKIPS.runner = saved;
  }
});
