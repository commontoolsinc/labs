import { assert, assertEquals } from "@std/assert";
import {
  compareVersions,
  findProblems,
  main,
  parseCheckShRange,
  parseDockerfileDenoVersions,
  parseMisePin,
  versionInRange,
} from "./check-deno-pins.ts";

// A consistent set of file contents, mirroring the real files' shapes. The
// action and check.sh fixtures carry the prose mentions of mise.toml that the
// real files have (a description, a comment), so a check that matched the
// file name alone would pass here for a reason production could not reproduce.
function alignedFiles() {
  return {
    miseToml: '[tools]\ndeno = "2.8.1"\n',
    dockerfile: "FROM denoland/deno:2.8.1 AS builder\n" +
      "RUN deno install --frozen\n" +
      "FROM denoland/deno:2.8.1\n",
    checkSh: "# The exact Deno version is pinned in mise.toml.\n" +
      'DENO_VERSION_MIN="2.8.0"\nDENO_VERSION_MAX="2.9.0"\n' +
      `DENO_VERSION_PINNED="$(sed -n 's/^deno = "\\([^"]*\\)"$/\\1/p' mise.toml | head -1)"\n`,
    denoSetupAction: '    description: "Defaults to the pin in mise.toml."\n' +
      "    # The repository's Deno version is pinned once, in mise.toml.\n" +
      "      run: |\n" +
      `        version="$(sed -n 's/^deno = "\\([^"]*\\)"$/\\1/p' mise.toml | head -1)"\n`,
  };
}

Deno.test("parseMisePin extracts the pinned version", () => {
  assertEquals(parseMisePin('[tools]\ndeno = "2.8.1"\n'), "2.8.1");
});

Deno.test("parseMisePin returns undefined when there is no pin", () => {
  assertEquals(parseMisePin('[tools]\nnode = "22.0.0"\n'), undefined);
});

Deno.test("parseDockerfileDenoVersions finds every FROM line", () => {
  const versions = parseDockerfileDenoVersions(alignedFiles().dockerfile);
  assertEquals(versions, ["2.8.1", "2.8.1"]);
});

Deno.test("parseDockerfileDenoVersions reads past flags and a lowercase FROM", () => {
  assertEquals(
    parseDockerfileDenoVersions(
      "FROM --platform=linux/amd64 denoland/deno:2.5.0 AS builder\n" +
        "from denoland/deno:2.6.0\n",
    ),
    ["2.5.0", "2.6.0"],
  );
});

Deno.test("parseDockerfileDenoVersions drops a digest", () => {
  assertEquals(
    parseDockerfileDenoVersions("FROM denoland/deno:2.8.1@sha256:abc123\n"),
    ["2.8.1"],
  );
});

Deno.test("parseCheckShRange extracts min and max", () => {
  assertEquals(parseCheckShRange(alignedFiles().checkSh), {
    min: "2.8.0",
    max: "2.9.0",
  });
});

Deno.test("parseCheckShRange returns undefined when a bound is missing", () => {
  assertEquals(parseCheckShRange('DENO_VERSION_MIN="2.8.0"\n'), undefined);
});

Deno.test("compareVersions compares components numerically", () => {
  assert(compareVersions("2.10.0", "2.9.0") > 0);
  assert(compareVersions("2.9.0", "2.10.0") < 0);
  assertEquals(compareVersions("2.8.1", "2.8.1"), 0);
});

Deno.test("versionInRange includes the minimum and excludes the maximum", () => {
  assert(versionInRange("2.8.0", "2.8.0", "2.9.0"));
  assert(versionInRange("2.8.1", "2.8.0", "2.9.0"));
  assert(!versionInRange("2.9.0", "2.8.0", "2.9.0"));
  assert(!versionInRange("2.7.9", "2.8.0", "2.9.0"));
});

Deno.test("findProblems accepts aligned files", () => {
  assertEquals(findProblems(alignedFiles()), []);
});

Deno.test("findProblems flags a missing pin", () => {
  const files = { ...alignedFiles(), miseToml: "[tools]\n" };
  assertEquals(findProblems(files).length, 1);
});

Deno.test("findProblems flags a non-exact pin", () => {
  const files = { ...alignedFiles(), miseToml: '[tools]\ndeno = "2.8"\n' };
  assertEquals(findProblems(files).length, 1);
});

Deno.test("findProblems flags a mismatched Dockerfile image", () => {
  const files = {
    ...alignedFiles(),
    dockerfile: "FROM denoland/deno:2.8.0 AS builder\n" +
      "FROM denoland/deno:2.8.1\n",
  };
  const problems = findProblems(files);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("2.8.0"));
});

Deno.test("findProblems flags a Dockerfile without deno images", () => {
  const files = { ...alignedFiles(), dockerfile: "FROM debian:12\n" };
  assertEquals(findProblems(files).length, 1);
});

Deno.test("findProblems flags a range that excludes the pin", () => {
  const files = {
    ...alignedFiles(),
    checkSh: alignedFiles().checkSh
      .replace('DENO_VERSION_MIN="2.8.0"', 'DENO_VERSION_MIN="2.9.0"')
      .replace('DENO_VERSION_MAX="2.9.0"', 'DENO_VERSION_MAX="2.10.0"'),
  };
  const problems = findProblems(files);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("range"));
});

// The name mise.toml stays in the action's description and comments after the
// read is replaced by a literal, so this fixture is what a "just inline the
// version" refactor actually leaves behind.
Deno.test("findProblems flags an action that stops reading mise.toml", () => {
  const files = {
    ...alignedFiles(),
    denoSetupAction: '    description: "Defaults to the pin in mise.toml."\n' +
      "    # The repository's Deno version is pinned once, in mise.toml.\n" +
      "      run: |\n" +
      '        version="2.8.1"\n',
  };
  const problems = findProblems(files);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("does not read"));
});

Deno.test("findProblems flags a check.sh that stops reading mise.toml", () => {
  const files = {
    ...alignedFiles(),
    checkSh: "# The exact Deno version is pinned in mise.toml.\n" +
      'DENO_VERSION_MIN="2.8.0"\nDENO_VERSION_MAX="2.9.0"\n',
  };
  const problems = findProblems(files);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("does not read"));
});

Deno.test("findProblems flags a Dockerfile stage stale behind a flag", () => {
  const files = {
    ...alignedFiles(),
    dockerfile: "FROM --platform=linux/amd64 denoland/deno:2.5.0 AS builder\n" +
      "FROM denoland/deno:2.8.1\n",
  };
  const problems = findProblems(files);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("2.5.0"));
});

Deno.test("findProblems accepts a digest-pinned image on the pin", () => {
  const files = {
    ...alignedFiles(),
    dockerfile: "FROM denoland/deno:2.8.1@sha256:abc123 AS builder\n" +
      "FROM denoland/deno:2.8.1\n",
  };
  assertEquals(findProblems(files), []);
});

Deno.test("findProblems flags a mismatched literal in the action", () => {
  const files = {
    ...alignedFiles(),
    denoSetupAction: alignedFiles().denoSetupAction +
      'default: "2.7.9"\n',
  };
  const problems = findProblems(files);
  assertEquals(problems.length, 1);
  assert(problems[0].includes("2.7.9"));
});

Deno.test("findProblems accepts a literal in the action equal to the pin", () => {
  const files = {
    ...alignedFiles(),
    denoSetupAction: alignedFiles().denoSetupAction +
      'default: "2.8.1"\n',
  };
  assertEquals(findProblems(files), []);
});

// The repository's actual files must be aligned; this is the same check CI
// runs via `deno task check-deno-pins`.
Deno.test("the repository's pins are aligned", async () => {
  assertEquals(await main(), 0);
});
