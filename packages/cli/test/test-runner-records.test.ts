/**
 * Who the pattern runner records for.
 *
 * `runTests` is both the body of `cf test` and a library the tests in this
 * package drive over fixture files. A record names a test of this repository,
 * so only the first of those two callers asks for one; a fixture run by a test
 * is that test's data.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join, resolve } from "@std/path";
import { recordsSpooledBy } from "@commonfabric/test-support/records";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/data-files");
const FIXTURE = join(FIXTURES, "single.test.tsx");
const DATA_FILE = join(FIXTURES, "data", "cities.json");

describe("pattern test recording", () => {
  it("spools nothing for a caller that did not ask for records", async () => {
    const spooled = await recordsSpooledBy(() =>
      runTests(FIXTURE, { root: FIXTURES, dataFilePaths: [DATA_FILE] })
    );
    expect(spooled).toEqual([]);
  });

  it("spools one record per file for a caller that asked", async () => {
    const spooled = await recordsSpooledBy(() =>
      runTests(FIXTURE, {
        root: FIXTURES,
        dataFilePaths: [DATA_FILE],
        recordResults: true,
      })
    );
    expect(spooled).toHaveLength(1);
    expect(spooled[0].test.k).toBe("pattern");
    expect(spooled[0].test.s).toBe("patterns");
    expect(spooled[0].test.n).toBe(
      "packages/cli/test/fixtures/data-files/single.test.tsx",
    );
    expect(spooled[0].outcome).toBe("pass");
  });
});
