import { assert } from "@std/assert";
import { decode } from "@commontools/utils/encoding";
import { runDenoWebTest } from "./utils.ts";

const dirname = import.meta.dirname as string;

Deno.test("config is applied", async function () {
  const { success, stdout, stderr } = await runDenoWebTest(
    "project-with-config",
  );
  const stdoutText = decode(stdout);
  const stderrText = decode(stderr);

  assert(success, "test successfully ran, applying chrome flags");
  assert(/LOG FROM TEST/.test(stdoutText), "console output propagated");

  assert(/deno run/.test(stderrText), "stderr has deno task run");
  assert(stderrText.split("\n").length === 2, "stderr has no other messages");
  assert(stderrText.split("\n")[1] === "", "stderr has no other messages");
});
