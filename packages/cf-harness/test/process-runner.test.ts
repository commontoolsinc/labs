import { assertRejects } from "@std/assert";
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
