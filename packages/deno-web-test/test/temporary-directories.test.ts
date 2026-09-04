/**
 * What a harness run leaves in the directory it makes its temporary files in.
 *
 * The run is given a `TMPDIR` of this test's own, and does not have it to
 * itself: Chrome writes its own scratch files into the directory `TMPDIR`
 * names and leaves some of them behind, files and directories alike, and its
 * crash handler, zygote, and GPU processes are re-parented when the browser
 * process goes, so more can land there after the run has ended and a run that
 * has ended cannot be waited for. What the run makes for itself carries the
 * prefix `Manifest.create()` gives it, and the assertion reads that.
 * `manifest.test.ts` is what pins the prefix onto the directory, so that a run
 * making no such directory would fail there rather than pass silently here.
 */

import { describe, it } from "@std/testing/bdd";

import { removeDirectory } from "@commonfabric/utils/remove-directory";

import { RUN_DIRECTORY_PREFIX } from "../manifest.ts";
import { runDenoWebTest } from "./utils.ts";

describe("a harness run", () => {
  it("leaves no directory of its own in the temporary directory", async () => {
    const temporaryDirectory = await Deno.makeTempDir({
      prefix: "deno-web-test-tmpdir-",
    });
    const run = await runDenoWebTest("success-project", {
      TMPDIR: temporaryDirectory,
    });
    const left = [...Deno.readDirSync(temporaryDirectory)];

    await removeDirectory(temporaryDirectory);

    run.assert(run.success, "the run passed");
    run.assert(
      !left.some((entry) => entry.name.startsWith(RUN_DIRECTORY_PREFIX)),
      `${temporaryDirectory} still holds ${
        left.map((entry) =>
          `${entry.name} (${entry.isDirectory ? "directory" : "file"})`
        ).join(", ")
      }`,
    );
  });
});
