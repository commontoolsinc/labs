import { assert } from "@std/assert";
import { decode } from "@commontools/utils/encoding";
import { runDenoWebTest } from "./utils.ts";

const dirname = import.meta.dirname as string;

Deno.test("smoke test", async function () {
  const { success, stdout, stderr } = await runDenoWebTest("success-project");
  const stdoutText = decode(stdout);
  const stderrText = decode(stderr);

  // While the test package is pulled out of the workspace
  // during testing, ensure we use the same version in `success-project`
  // as the outer workspace so that we don't get terminal spam
  // from downloading new versions, breaking stdout/stderr
  // parsers in the tests

  assert(success, "test successful");
  assert(/add-sync ... ok/.test(stdoutText), "test output ok");
  assert(/add-async ... ok/.test(stdoutText), "test output ok");
  assert(/ok | 2 passed | 0 failed/.test(stdoutText), "test output ok");
  assert(/deno run/.test(stderrText), "stderr has deno task run");
  assert(
    stderrText.split(/\r?\n/).length === 2,
    "stderr has no other messages",
  );
  assert(stderrText.split(/\r?\n/)[1] === "", "stderr has no other messages");
});
