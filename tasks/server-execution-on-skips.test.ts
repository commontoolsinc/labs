import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  isServerExecutionSuite,
  main,
  SERVER_EXECUTION_ON_SKIPS,
  serverExecutionOnFilterFiles,
  serverExecutionOnIgnoreArg,
  type ServerExecutionOnSkip,
  serverExecutionOnSkipReport,
  serverExecutionOnStepSkip,
  validateServerExecutionOnSkips,
} from "./server-execution-on-skips.ts";

const repoRoot = new URL("../", import.meta.url);

// A capture-everything io for driving `main` in-process.
const captureIo = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      log: (line: string) => out.push(line),
      error: (line: string) => err.push(line),
    },
  };
};

Deno.test("every skip entry names an existing file (no stale lists)", async () => {
  const problems = await validateServerExecutionOnSkips(repoRoot);
  assertEquals(problems, []);
});

Deno.test("an empty list yields no --ignore flag and says the full suite runs", () => {
  for (const suite of ["patterns", "runner", "runtime-client", "shell"]) {
    if (!isServerExecutionSuite(suite)) throw new Error("unreachable");
    if (SERVER_EXECUTION_ON_SKIPS[suite].length > 0) continue;
    assertEquals(serverExecutionOnIgnoreArg(suite), "");
    assertMatch(
      serverExecutionOnSkipReport(suite),
      /no skips — full suite runs/,
    );
  }
});

Deno.test("a populated list produces one --ignore flag and a per-entry report", () => {
  const saved = SERVER_EXECUTION_ON_SKIPS.runner;
  SERVER_EXECUTION_ON_SKIPS.runner = [
    {
      file: "integration/example-a.test.ts",
      phase: "phase-3",
      reason: "exercises events-down handler semantics",
    },
    {
      file: "integration/example-b.test.ts",
      phase: "phase-5",
      reason: "cross-space serving",
    },
  ];
  try {
    assertEquals(
      serverExecutionOnIgnoreArg("runner"),
      "--ignore=integration/example-a.test.ts,integration/example-b.test.ts",
    );
    const report = serverExecutionOnSkipReport("runner");
    assertMatch(
      report,
      /SKIP integration\/example-a\.test\.ts \(until phase-3\)/,
    );
    assertMatch(
      report,
      /SKIP integration\/example-b\.test\.ts \(until phase-5\)/,
    );
  } finally {
    SERVER_EXECUTION_ON_SKIPS.runner = saved;
  }
});

Deno.test("validation flags missing files and duplicates, and passes real files", async () => {
  const lists: Record<string, ServerExecutionOnSkip[]> = {
    patterns: [
      // A file that really exists, resolved against the real repo root.
      {
        file: "integration/counter.test.ts",
        phase: "phase-2",
        reason: "placeholder",
      },
    ],
    runner: [
      {
        file: "integration/does-not-exist.test.ts",
        phase: "phase-3",
        reason: "placeholder",
      },
      {
        file: "integration/does-not-exist.test.ts",
        phase: "phase-3",
        reason: "placeholder",
      },
    ],
    "runtime-client": [],
    shell: [],
  };
  const problems = await validateServerExecutionOnSkips(
    repoRoot,
    lists as typeof SERVER_EXECUTION_ON_SKIPS,
  );
  assertEquals(problems, [
    "runner: skip entry names a missing file: integration/does-not-exist.test.ts",
    "runner: duplicate skip entry for integration/does-not-exist.test.ts",
    "runner: skip entry names a missing file: integration/does-not-exist.test.ts",
  ]);
});

Deno.test("main: unknown suite reports the vocabulary and exits 1", async () => {
  const { out, err, io } = captureIo();
  assertEquals(await main(["bogus"], io), 1);
  assertEquals(out, []);
  assertMatch(err[0], /Unknown suite "bogus"/);
  assertMatch(err[0], /patterns, runner, runtime-client, shell/);
});

Deno.test("main: no arguments behaves like an unknown suite", async () => {
  const { err, io } = captureIo();
  assertEquals(await main([], io), 1);
  assertMatch(err[0], /Unknown suite ""/);
});

Deno.test("main: empty lists print the report on stderr and nothing on stdout", async () => {
  // The shell suite's list is empty (patterns carries the single default-app
  // STEP entry and nothing else; runner and runtime-client are empty since
  // their lifts, and no suite carries a FILE entry any more).
  const { out, err, io } = captureIo();
  assertEquals(await main(["shell"], io), 0);
  assertEquals(out, []);
  assertMatch(err[0], /shell: no skips — full suite runs/);
});

Deno.test("main: the patterns list carries ONE entry — the default-app STEP — since the lunch-poll-vote FILE entry's lift (2026-08-27), so NO suite has a file-level skip and the flip bar is one step away", async () => {
  const { out, err, io } = captureIo();
  assertEquals(await main(["patterns"], io), 0);
  // A STEP entry never drops its file, and no FILE entry remains anywhere:
  // stdout carries no --ignore flag at all.
  assertEquals(out, []);
  // …the report still carries the one remaining skip loudly…
  assertMatch(
    err[0],
    /patterns: SKIP-STEP integration\/default-app\.test\.ts :: should persist and reload every rapidly created notebook note \(until phase-7; the rest of the file runs\)/,
  );
  // …and the list holds EXACTLY that one entry — an addition or a silent
  // lift both redden this pin.
  assertEquals(SERVER_EXECUTION_ON_SKIPS.patterns.length, 1);
  assertEquals(
    SERVER_EXECUTION_ON_SKIPS.patterns[0].file,
    "integration/default-app.test.ts",
  );
  assertEquals(
    SERVER_EXECUTION_ON_SKIPS.patterns[0].step,
    "should persist and reload every rapidly created notebook note",
  );
  // The lunch-poll-vote entry is GONE (LIFTED 2026-08-27 on its own
  // owner-directed re-baseline: 8/8 at the current lane posture — ensure ON,
  // toolshed self-sourced — with the member's store discriminator negative
  // in every run; verification-coverage.md OW45). Nothing may drop that file
  // any more, so the ON shards run it.
  assertEquals(
    serverExecutionOnFilterFiles("patterns", [
      "./integration/lunch-poll-vote.test.ts",
    ]),
    { files: ["./integration/lunch-poll-vote.test.ts"], skipped: [] },
  );
  // The topic-board pivot-baseline entry is GONE too (#6304 fixed, lifted by
  // #6316): the guard lookup for that step resolves nothing, so the case runs
  // in the ON lane — it is that issue's acceptance test.
  assertEquals(
    serverExecutionOnStepSkip(
      "patterns",
      "integration/topic-board-child-contract.test.ts",
      "builds one pivot row per topic, claiming no edges before any mention",
    ),
    undefined,
  );
  // The guard resolves the current direct-CI charge and pins its decisive
  // discriminators so a stale launcher-era reason cannot return silently.
  const entry = serverExecutionOnStepSkip(
    "patterns",
    "integration/default-app.test.ts",
    "should persist and reload every rapidly created notebook note",
  );
  assert(entry !== undefined, "the rapid-note step's guard entry must resolve");
  assertEquals(entry.phase, "phase-7");
  assertMatch(entry.reason, /66a969ca0/);
  assertMatch(entry.reason, /33008274232/);
  assertMatch(entry.reason, /5m22s/);
  assertMatch(entry.reason, /300000ms/);
  assertMatch(entry.reason, /eventInvocationCount=7/);
  assertMatch(entry.reason, /notebookActionCount=0/);
  assertMatch(entry.reason, /84 stored UI note chips/);
  assertMatch(entry.reason, /zero pattern-swap-setup-error/);
  assertMatch(entry.reason, /distinct from the split-source/);
  assertMatch(entry.reason, /10\/10 quiet-and-loaded/);
  // With no FILE entry in the list, the shard filter passes EVERY candidate
  // through and drops nothing — re-add a FILE entry and this assertion reds.
  const { files, skipped } = serverExecutionOnFilterFiles("patterns", [
    "./integration/default-app.test.ts",
    "./integration/cellset-lww.test.ts",
    "./integration/convergence-storm.test.ts",
    "./integration/lunch-poll-vote.test.ts",
    "./integration/topics-navigation.test.ts",
  ]);
  assertEquals(files, [
    "./integration/default-app.test.ts",
    "./integration/cellset-lww.test.ts",
    "./integration/convergence-storm.test.ts",
    "./integration/lunch-poll-vote.test.ts",
    "./integration/topics-navigation.test.ts",
  ]);
  assertEquals(skipped, []);
  assertEquals(SERVER_EXECUTION_ON_SKIPS.shell.length, 0);
});
Deno.test("main: the runtime-client list is EMPTY — the OW33 triage (2026-08-22) lifted both STEP entries (CT-1606 PerUser header render; single-navigateTo dispatch) on 12/12 green at the true ON topology — so the full suite runs, and the in-file guard resolves to no entry", async () => {
  const { out, err, io } = captureIo();
  assertEquals(await main(["runtime-client"], io), 0);
  // No entries: no --ignore flag on stdout…
  assertEquals(out, []);
  // …the filter shape keeps the file…
  const { files, skipped } = serverExecutionOnFilterFiles("runtime-client", [
    "./integration/client.test.ts",
  ]);
  assertEquals(files, ["./integration/client.test.ts"]);
  assertEquals(skipped, []);
  // …and the report says so loudly.
  assertMatch(
    err[0],
    /runtime-client: no skips — full suite runs\./,
  );
  assertEquals(SERVER_EXECUTION_ON_SKIPS["runtime-client"].length, 0);
  // The lifted steps' guard lookups resolve to NOTHING, so the steps RUN
  // on the ON arm — pinned so a re-skip is a deliberate entry, never a
  // leftover. The `onArmStepSkip` guard calls stay in client.test.ts (the
  // binding mechanism for any future entry) and are inert without one.
  for (
    const step of [
      "renders PerUser-derived computed JSX inside cf-screen header slot (CT-1606)",
      "dispatches one navigateTo when a rendered handler changes local state",
    ]
  ) {
    assertEquals(
      serverExecutionOnStepSkip(
        "runtime-client",
        "integration/client.test.ts",
        step,
      ),
      undefined,
    );
  }
});

Deno.test("validation binds a step entry: the file must name the step and call the guard", async () => {
  const lists: Record<string, ServerExecutionOnSkip[]> = {
    patterns: [],
    runner: [
      // A real file that neither names this step nor calls the guard.
      {
        file: "integration/basic-persistence.test.ts",
        step: "a step basic-persistence.test.ts does not contain",
        phase: "phase-7",
        reason: "placeholder",
      },
    ],
    "runtime-client": [
      // Duplicate step entries are flagged like duplicate files.
      {
        file: "integration/client.test.ts",
        step:
          "renders PerUser-derived computed JSX inside cf-screen header slot (CT-1606)",
        phase: "phase-7",
        reason: "placeholder",
      },
      {
        file: "integration/client.test.ts",
        step:
          "renders PerUser-derived computed JSX inside cf-screen header slot (CT-1606)",
        phase: "phase-7",
        reason: "placeholder",
      },
    ],
    shell: [],
  };
  const problems = await validateServerExecutionOnSkips(
    repoRoot,
    lists as typeof SERVER_EXECUTION_ON_SKIPS,
  );
  assertEquals(problems, [
    'runner: step skip entry names a step integration/basic-persistence.test.ts does not contain: "a step basic-persistence.test.ts does not contain"',
    "runner: integration/basic-persistence.test.ts carries a step skip entry but never calls serverExecutionOnStepSkip — the entry would be decoration",
    "runtime-client: duplicate skip entry for integration/client.test.ts :: renders PerUser-derived computed JSX inside cf-screen header slot (CT-1606)",
  ]);
});

Deno.test("main: the runner list is EMPTY — pattern-and-data-persistence LIFTED by the arrival-witness predicate (RULED 2026-08-22, candidate (B): a cover at the floor witnesses only when derived-class) on 10/10 green at the true ON topology — and since the lunch-poll-vote lift (2026-08-27) NO suite carries a FILE-level skip at all", async () => {
  const { out, err, io } = captureIo();
  assertEquals(await main(["runner"], io), 0);
  // No entries: no --ignore flag on stdout…
  assertEquals(out, []);
  // …the filter shape keeps the file…
  const { files, skipped } = serverExecutionOnFilterFiles("runner", [
    "./integration/pattern-and-data-persistence.test.ts",
  ]);
  assertEquals(files, ["./integration/pattern-and-data-persistence.test.ts"]);
  assertEquals(skipped, []);
  // …and the report says so loudly.
  assertMatch(err[0], /runner: no skips — full suite runs\./);
  assertEquals(SERVER_EXECUTION_ON_SKIPS.runner.length, 0);
  // A FILE-level skip is a deliberate entry, never a leftover. The
  // arrival-witness lift cleared runner's last one; patterns' lunch-poll-vote
  // re-skip (2026-08-24) was the only one minted since, and it LIFTED
  // 2026-08-27 on its own owner-directed re-baseline (8/8 at the current lane
  // posture). Every list is now file-entry-free, so the NEXT file-level entry
  // anywhere reddens this pin. The flip PR's list-EMPTY bar is down to ONE
  // remaining entry — default-app's reload STEP, still red at 7/10.
  for (const suite of ["patterns", "runner", "runtime-client", "shell"]) {
    if (!isServerExecutionSuite(suite)) throw new Error("unreachable");
    assertEquals(
      SERVER_EXECUTION_ON_SKIPS[suite]
        .filter((skip) => skip.step === undefined)
        .map((skip) => skip.file),
      [],
      `${suite}: no FILE-level skip remains in any suite`,
    );
  }
});

Deno.test("main: populated lists emit the --ignore flag on stdout", async () => {
  const saved = SERVER_EXECUTION_ON_SKIPS.patterns;
  SERVER_EXECUTION_ON_SKIPS.patterns = [
    {
      file: "integration/counter.test.ts",
      phase: "phase-2",
      reason: "placeholder for the flag-shape test",
    },
  ];
  try {
    const { out, err, io } = captureIo();
    assertEquals(await main(["patterns"], io), 0);
    assertEquals(out, ["--ignore=integration/counter.test.ts"]);
    assertMatch(
      err[0],
      /SKIP integration\/counter\.test\.ts \(until phase-2\)/,
    );
  } finally {
    SERVER_EXECUTION_ON_SKIPS.patterns = saved;
  }
});

Deno.test("main: a stale entry fails validation before any report", async () => {
  const saved = SERVER_EXECUTION_ON_SKIPS.shell;
  SERVER_EXECUTION_ON_SKIPS.shell = [
    {
      file: "integration/vanished.test.ts",
      phase: "phase-4",
      reason: "placeholder",
    },
  ];
  try {
    const { out, err, io } = captureIo();
    assertEquals(await main(["shell"], io), 1);
    assertEquals(out, []);
    assertMatch(
      err[0],
      /shell: skip entry names a missing file: integration\/vanished\.test\.ts/,
    );
  } finally {
    SERVER_EXECUTION_ON_SKIPS.shell = saved;
  }
});

Deno.test("--filter: the explicit-file shape drops the suite's skips from a candidate list (normalizing a leading ./), keeps order, and reports only what it dropped from THIS list", () => {
  const saved = SERVER_EXECUTION_ON_SKIPS.patterns;
  SERVER_EXECUTION_ON_SKIPS.patterns = [
    {
      file: "integration/b.test.ts",
      phase: "phase-7",
      reason: "placeholder",
    },
    {
      file: "integration/zzz-elsewhere.test.ts",
      phase: "phase-7",
      reason: "in another shard",
    },
  ];
  try {
    const { files, skipped } = serverExecutionOnFilterFiles("patterns", [
      "./integration/a.test.ts",
      "./integration/b.test.ts",
      "integration/c.test.ts",
    ]);
    assertEquals(files, ["./integration/a.test.ts", "integration/c.test.ts"]);
    assertEquals(skipped.map((skip) => skip.file), ["integration/b.test.ts"]);
  } finally {
    SERVER_EXECUTION_ON_SKIPS.patterns = saved;
  }
});

Deno.test("main --filter: prints the surviving files on stdout, the report + DROPPED lines on stderr; rejects other extra arguments", async () => {
  const saved = SERVER_EXECUTION_ON_SKIPS.patterns;
  SERVER_EXECUTION_ON_SKIPS.patterns = [
    {
      file: "integration/counter.test.ts",
      phase: "phase-7",
      reason: "placeholder for the filter-shape test",
    },
  ];
  try {
    const { out, err, io } = captureIo();
    assertEquals(
      await main([
        "patterns",
        "--filter",
        "./integration/counter.test.ts",
        "./integration/other.test.ts",
      ], io),
      0,
    );
    assertEquals(out, ["./integration/other.test.ts"]);
    assertMatch(
      err[0],
      /SKIP integration\/counter\.test\.ts \(until phase-7\)/,
    );
    assertMatch(
      err[1],
      /DROPPED integration\/counter\.test\.ts from this file list/,
    );
    // Nothing of the list is skip-listed: say so, run everything.
    const none = captureIo();
    assertEquals(
      await main(
        ["patterns", "--filter", "./integration/other.test.ts"],
        none.io,
      ),
      0,
    );
    assertEquals(none.out, ["./integration/other.test.ts"]);
    assertMatch(none.err[1], /no listed skip is in this file list/);
    // An unknown extra argument is refused, never silently treated as a file.
    const bad = captureIo();
    assertEquals(await main(["patterns", "--bogus"], bad.io), 1);
    assertMatch(bad.err.at(-1) ?? "", /Unexpected arguments/);
  } finally {
    SERVER_EXECUTION_ON_SKIPS.patterns = saved;
  }
});

// The mechanism's BINDING, pinned by spawning deno on both shapes (Phase 7
// fixer, 2026-08-16): `deno test --ignore=<file>` filters only the modules
// deno DISCOVERS — a glob it expands itself — and silently ignores nothing
// when the same file arrives as an explicit argument (a shell-expanded glob;
// the pattern shards' file list). Until this pin, every ON-arm skip since
// Phase 4 rode a shell-expanded glob and never took effect. If deno's
// semantics ever change, these two tests say which shape moved.
async function collectedTestFiles(args: string[], cwd: string) {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["test", "--no-lock", "--no-check", ...args],
    cwd,
    // Plain output: the "running N tests from <file>" lines are matched
    // below and must not carry color escapes.
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const text = new TextDecoder().decode(output.stdout) +
    new TextDecoder().decode(output.stderr);
  const files = [...text.matchAll(/running \d+ tests? from (\S+)/g)]
    .map((match) => match[1]).sort();
  return { files, success: output.success, text };
}

Deno.test("deno test --ignore BINDS to a QUOTED glob deno expands (the package integration tasks' shape) and NOT to explicit file arguments (why the pattern shards filter the list instead)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sx-on-skips-ignore-" });
  try {
    await Deno.mkdir(`${dir}/integration`);
    await Deno.writeTextFile(`${dir}/deno.json`, "{}\n");
    for (const name of ["a", "b"]) {
      await Deno.writeTextFile(
        `${dir}/integration/${name}.test.ts`,
        `Deno.test("${name}", () => {});\n`,
      );
    }
    // Quoted glob (deno expands): the ignore drops b.
    const quoted = await collectedTestFiles(
      ["--ignore=integration/b.test.ts", "./integration/*.test.ts"],
      dir,
    );
    assert(quoted.success, quoted.text);
    assertEquals(quoted.files, ["./integration/a.test.ts"]);
    // Explicit files (what a shell-expanded glob or a shard list hands
    // deno): the SAME ignore flag drops nothing — the shape the pattern
    // shards therefore avoid.
    const explicit = await collectedTestFiles(
      [
        "--ignore=integration/b.test.ts",
        "./integration/a.test.ts",
        "./integration/b.test.ts",
      ],
      dir,
    );
    assert(explicit.success, explicit.text);
    assertEquals(explicit.files, [
      "./integration/a.test.ts",
      "./integration/b.test.ts",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the package integration tasks that carry the ON skip list hand deno a QUOTED glob (so --ignore binds); patterns keeps the shell glob because its test config excludes integration/ and the pattern shards filter explicitly", async () => {
  const root = new URL("../", import.meta.url);
  for (const suite of ["runner", "runtime-client", "shell"]) {
    const config = await Deno.readTextFile(
      new URL(`packages/${suite}/deno.jsonc`, root),
    );
    const task = config.match(/"integration": "([^"\\]|\\.)*"/)?.[0] ?? "";
    assertMatch(
      task,
      /\$INTEGRATION_TEST_FLAGS \\"\.\/integration\/\*\.test\.ts\\"/,
      `${suite}: the integration task must quote its glob: ${task}`,
    );
  }
});
