import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { conflictMarkerAt, main, scan } from "./check-conflict-markers.ts";

// Built rather than written out, for the reason given in the checker: a quoted
// run in an indented expression is harmless, but a multi-line template literal
// would put one at column 0 and trip the check this file defines.
const OPEN = "<".repeat(7);
const ANCESTOR = "|".repeat(7);
const CLOSE = ">".repeat(7);
const SEPARATOR = "=".repeat(7);

/** Makes a git repo with one tracked file, and returns its root. */
async function fixtureRepo(contents: string): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "check-conflict-markers-" });
  const run = async (...args: string[]) => {
    const { success, stderr } = await new Deno.Command("git", {
      args,
      cwd: root,
      stdout: "null",
      stderr: "piped",
    }).output();
    assert(
      success,
      `git ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`,
    );
  };
  await run("init", "-q");
  await Deno.writeTextFile(join(root, "subject.md"), contents);
  await run("add", "subject.md");
  return root;
}

/** Runs `body` with console output captured. */
async function captureConsole(
  body: () => Promise<void>,
): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    await body();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

Deno.test("conflictMarkerAt: flags each marker git writes", () => {
  assertEquals(conflictMarkerAt(`${OPEN} HEAD`), OPEN);
  assertEquals(conflictMarkerAt(`${CLOSE} some/branch`), CLOSE);
  assertEquals(
    conflictMarkerAt(`${ANCESTOR} merged common ancestors`),
    ANCESTOR,
  );
  // Git writes a label, but a bare marker is still one.
  assertEquals(conflictMarkerAt(OPEN), OPEN);
});

Deno.test("conflictMarkerAt: leaves a setext heading underline alone", () => {
  // Seven equals signs underline a Markdown heading. Flagging those would make
  // the check something people route around, so the separator is not a marker
  // here -- a real conflict always brings an opener and a closer too.
  assertEquals(conflictMarkerAt(SEPARATOR), undefined);
  assertEquals(conflictMarkerAt("=".repeat(40)), undefined);
});

Deno.test("conflictMarkerAt: ignores a marker not at column 0", () => {
  assertEquals(conflictMarkerAt("<".repeat(4)), undefined);
  // A longer run is a rule or an ASCII box, not a marker.
  assertEquals(conflictMarkerAt(`${OPEN}<`), undefined);
  // Git never indents a marker, nor buries one mid-line.
  assertEquals(conflictMarkerAt(`  ${OPEN} HEAD`), undefined);
  assertEquals(conflictMarkerAt(`text ${OPEN} HEAD`), undefined);
  assertEquals(conflictMarkerAt(""), undefined);
});

Deno.test("scan: reports a marker with its file and line", async () => {
  const root = await fixtureRepo(
    ["intact", `${OPEN} HEAD`, "ours", SEPARATOR, "theirs", `${CLOSE} other`]
      .join("\n"),
  );
  try {
    const violations = await scan(root);
    assertEquals(violations.map((v) => v.line), [2, 6]);
    assertEquals(violations.map((v) => v.marker), [OPEN, CLOSE]);
    assertEquals(violations[0].file, "subject.md");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scan: passes a file that merely mentions the shapes", async () => {
  const root = await fixtureRepo(
    ["A heading", SEPARATOR, "", "and a rule:", "-".repeat(40), ""].join("\n"),
  );
  try {
    assertEquals(await scan(root), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main: fails and names the file", async () => {
  const root = await fixtureRepo(`${OPEN} HEAD`);
  try {
    let code = 0;
    const { err } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 1);
    assert(err.includes("subject.md:1"), err);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main: succeeds on a clean tree", async () => {
  const root = await fixtureRepo("nothing to see");
  try {
    let code = 1;
    const { out } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 0);
    assert(out.includes("No unresolved merge-conflict markers"), out);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
