import { assertEquals, assertRejects } from "@std/assert";
import {
  DenoProcessRunner,
  ProcessTimeoutError,
} from "../src/sandbox/process-runner.ts";

Deno.test("DenoProcessRunner surfaces killed timeout exits as ProcessTimeoutError", async () => {
  const runner = new DenoProcessRunner();

  await assertRejects(
    () =>
      runner.run({
        command: "/bin/sh",
        args: ["-lc", "sleep 5"],
        timeoutMs: 100,
      }),
    ProcessTimeoutError,
    "process timed out after 100ms",
  );
});

Deno.test({
  name: "DenoProcessRunner clears inherited env when requested",
  permissions: { env: true, run: true },
  async fn() {
    const runner = new DenoProcessRunner();
    const key = "SECRET_SHOULD_NOT_LEAK";
    const previous = Deno.env.get(key);
    try {
      Deno.env.set(key, "super-secret");
      const result = await runner.run({
        command: "/usr/bin/env",
        args: [],
        clearEnv: true,
        env: { PATH: "/usr/bin:/bin", SAFE_VALUE: "ok" },
      });

      assertEquals(result.exitCode, 0);
      assertEquals(result.stdout.includes("SAFE_VALUE=ok"), true);
      assertEquals(result.stdout.includes(key), false);
      assertEquals(result.stdout.includes("super-secret"), false);
    } finally {
      if (previous === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, previous);
      }
    }
  },
});
