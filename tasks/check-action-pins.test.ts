import { assert, assertEquals } from "@std/assert";
import {
  checkStep,
  extensionsOf,
  parseSteps,
  pinOf,
  type Resolver,
  type Step,
} from "./check-action-pins.ts";

const V6 = "55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
const V6_0_0 = "2c8a9bd7457de244a408f35966fab2fb45fda9c8";
const OTHER = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

// Stands in for GitHub, answering by prefix the way matching-refs does, with
// every tag already followed through to its commit.
const TAGS: Resolver = (_repo, prefix) =>
  Promise.resolve(
    new Map(
      Object.entries({ v6: V6, "v6.0.0": V6_0_0, "v6.1.0": V6 })
        .filter(([name]) => name.startsWith(prefix)),
    ),
  );

function step(action: string, comment: string): Step {
  return { file: "workflows/x.yml", action, comment };
}

Deno.test("a commit the named release points at passes", async () => {
  assertEquals(
    await checkStep(step(`actions/cache@${V6}`, "v6.1.0"), TAGS),
    null,
  );
});

Deno.test("a comment naming a moving alias fails", async () => {
  // `v6` is true today and false after the next release, without anybody
  // touching the file, so the check asks for the release itself and says
  // which one.
  const problem = await checkStep(step(`actions/cache@${V6}`, "v6"), TAGS);
  assert(problem?.includes("a name its publisher moves onto each release"));
  assert(problem?.includes("v6.1.0"));
});

Deno.test("a commit under the wrong release fails", async () => {
  const problem = await checkStep(
    step(`actions/cache@${V6_0_0}`, "v6.1.0"),
    TAGS,
  );
  assert(problem?.includes("v6.1.0 is"));
  assert(problem?.includes("but the step runs"));
});

Deno.test("a sub-action is checked against its repository", async () => {
  assertEquals(
    await checkStep(step(`actions/cache/restore@${V6}`, "v6.1.0"), TAGS),
    null,
  );
});

Deno.test("a commit no release points at fails", async () => {
  const problem = await checkStep(
    step(`actions/cache@${OTHER}`, "v6.1.0"),
    TAGS,
  );
  assert(problem?.includes("but the step runs"));
});

Deno.test("a comment naming an absent release fails", async () => {
  const problem = await checkStep(step(`actions/cache@${V6}`, "v99"), TAGS);
  assert(problem?.includes("has no v99 release"));
});

Deno.test("a step naming a tag rather than a commit fails", async () => {
  const problem = await checkStep(step("actions/cache@v6", "v6.1.0"), TAGS);
  assert(problem?.includes("names no commit"));
});

Deno.test("a pinned step with no comment fails", async () => {
  const problem = await checkStep(step(`actions/cache@${V6}`, ""), TAGS);
  assert(problem?.includes("has no version comment"));
});

Deno.test("a comment that names no version fails", async () => {
  const problem = await checkStep(
    step(`actions/cache@${V6}`, "the good one"),
    TAGS,
  );
  assert(problem?.includes("the good one"));
});

Deno.test("pinOf drops a sub-action path and rejects a tag", () => {
  assertEquals(pinOf(step(`actions/cache/save@${V6}`, "v6.1.0")), {
    repo: "actions/cache",
    sha: V6,
  });
  assertEquals(pinOf(step("actions/cache@v6", "v6.1.0")), null);
  assertEquals(pinOf(step("./.github/actions/deno-setup", "")), null);
});

Deno.test("extensionsOf finds the releases a name covers", () => {
  const tags = new Map([["v4", "a"], ["v4.2.0", "b"], ["v41.0.0", "c"]]);
  // `v41.0.0` does not extend `v4`: the split is at the dot.
  assertEquals(extensionsOf(tags, "v4"), ["v4.2.0"]);
  assertEquals(extensionsOf(tags, "v4.2.0"), []);
});

Deno.test("parseSteps reads the action and the comment", () => {
  const steps = parseSteps(
    [
      `      uses: actions/checkout@${V6} # v7`,
      `      uses: "denoland/setup-deno@${V6}" # v2.0.5`,
      "      uses: ./.github/actions/deno-setup",
      "      uses: actions/checkout@v7",
      `      # uses: actions/checkout@${V6} # v7`,
    ].join("\n"),
    "workflows/x.yml",
  );

  assertEquals(steps.map((s) => s.action), [
    `actions/checkout@${V6}`,
    `denoland/setup-deno@${V6}`,
    // Kept, so that an unpinned step is reported rather than skipped.
    "./.github/actions/deno-setup",
    "actions/checkout@v7",
  ]);
  assertEquals(steps.map((s) => s.comment), ["v7", "v2.0.5", "", ""]);
});
