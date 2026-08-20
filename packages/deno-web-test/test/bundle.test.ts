import { assert } from "@std/assert";
import { decode } from "@commonfabric/utils/encoding";
import { runDenoWebTest } from "./utils.ts";

Deno.test("a `bundle` entry is bundled onto the server root", async function () {
  const { success, stdout } = await runDenoWebTest("bundle-project");
  const stdoutText = decode(stdout);

  assert(success, stdoutText);
  assert(
    /a bundled module loads into a realm the page creates \.\.\. ok/.test(
      stdoutText,
    ),
    stdoutText,
  );
  assert(
    /a bundled module loads into a sandboxed iframe \.\.\. ok/.test(stdoutText),
    stdoutText,
  );
});
