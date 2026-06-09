/**
 * Traverse replay oracle test: replays each captured fixture in
 * test/traverse-replay/fixtures/ and asserts the oracle (result hashes,
 * read set, schema-tracker contents) matches the checked-in golden.
 *
 * A failure here means traversal semantics changed. If unintended, fix the
 * regression. If intended, regenerate goldens (see
 * test/traverse-replay/regen-goldens.ts) and justify the golden diff in the
 * PR.
 */
import { assert } from "@std/assert";
import { diffOracles, listFixturePaths, loadGolden } from "./traverse-replay/goldens.ts";
import { loadFixture, replayFixture } from "./traverse-replay/replay.ts";

Deno.test("traverse replay matches golden oracles", async (t) => {
  const fixtures = listFixturePaths();
  assert(fixtures.length > 0, "no fixtures found");
  for (const { name, path } of fixtures) {
    await t.step(name, () => {
      const golden = loadGolden(name);
      assert(
        golden !== undefined,
        `missing golden for fixture "${name}" - run ` +
          `test/traverse-replay/regen-goldens.ts and review the diff`,
      );
      const fixture = loadFixture(path);
      const { oracle } = replayFixture(fixture, { collectOracle: true });
      const problems = diffOracles(golden, oracle!);
      assert(
        problems.length === 0,
        `oracle mismatch for "${name}" (traversal semantics changed):\n` +
          problems.join("\n"),
      );
    });
  }
});
