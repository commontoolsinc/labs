/**
 * What a harness run leaves in the directory it makes its temporary files in.
 *
 * The run is given a `TMPDIR` of this test's own, so that what it makes there
 * stands alone. Chrome's crash handler, zygote, and GPU processes are
 * re-parented when the browser process goes, and they write into whatever
 * directory `TMPDIR` names, so entries of Chrome's can appear here once the
 * run has ended. The directories are the run's own, and those are what the
 * assertion reads.
 */

import { describe, it } from "@std/testing/bdd";

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

    // Renaming the directory before walking it takes it out from under
    // anything writing to the path the run was given, so that nothing can
    // appear inside it while the walk is under way.
    const removing = `${temporaryDirectory}.removing`;
    await Deno.rename(temporaryDirectory, removing);
    await Deno.remove(removing, { recursive: true });

    run.assert(run.success, "the run passed");
    run.assert(
      !left.some((entry) => entry.isDirectory),
      `${temporaryDirectory} still holds ${
        left.map((entry) =>
          `${entry.name} (${entry.isDirectory ? "directory" : "file"})`
        ).join(", ")
      }`,
    );
  });
});
