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
  // The shell suite's list is empty (patterns and runner carry the
  // Phase-7 entries).
  const { out, err, io } = captureIo();
  assertEquals(await main(["shell"], io), 0);
  assertEquals(out, []);
  assertMatch(err[0], /shell: no skips — full suite runs/);
});

Deno.test("main: the patterns list = topics-navigation (re-tensed by the OW33 triage 2026-08-22 — the recorded fail-fast myName red did not reproduce at the true ON topology; a residual 2/10 flake holds the skip) + the FIRST ON-LANE CI GATE set (2026-08-21, skip-and-land): TWO file entries (the sqlite identity pair) and ONE step entry (default-app's reload step, under OW45) — the gate step lifts and four file lifts landed across the optimize pass (cellset-lww's own-write race with OW47's close; convergence-storm's storm step with OW52's close — its red was the harness settle racing the serving drain, not a loss; default-app's FILE skip with OW51's close — the splitDefinitions crash fixed, its create-note step runs ON, only its reload step stays under OW45; cfc-group-chat-demo with OW59's close, the OW34-family train: per-run trust snapshots — the file greens under the true ON topology 4/4, every run's store auditing zero service-DID authorship labels; home-profile-reload-durability with the explicit warm request, RULED 2026-08-21 — the serving-side provisioning path's staged setup now activates and derives in a parked, sessionless space, 6/6 fresh-store ON gate; profile-embed with OW47's RE-close — the name-draft own-write loss: the CFC verifier-read basis, arm (b) RULED 2026-08-21, 10/10 green ON at the fix head) — every FILE gate entry names its mechanism, the gate report, and its owed OW row; lunch-poll-vote (W3.1's lift) and cfc-group-chat-demo-two-browsers (fan-out B) still RUN — printed loudly, never silent", async () => {
  const { out, err, io } = captureIo();
  assertEquals(await main(["patterns"], io), 0);
  // File-level entries only in the --ignore flag (step entries never drop
  // their file), in list order.
  assertEquals(out, [
    "--ignore=integration/topics-navigation.test.ts," +
    "integration/sqlite-db-owner-multi-runtime.test.ts," +
    "integration/sqlite-read-clearance-multi-runtime.test.ts",
  ]);
  const report = err[0];
  assertMatch(
    report,
    /patterns: SKIP integration\/topics-navigation\.test\.ts \(until phase-7\)/,
  );
  for (
    const file of [
      "sqlite-db-owner-multi-runtime",
      "sqlite-read-clearance-multi-runtime",
    ]
  ) {
    assertMatch(
      report,
      new RegExp(
        `patterns: SKIP integration/${file}\\.test\\.ts \\(until phase-7\\)`,
      ),
    );
  }
  // default-app's FILE skip was LIFTED (OW51 CLOSED, 2026-08-21): the
  // splitDefinitions crash is fixed and the file runs ON. Only the reload
  // step remains, guarded under OW45 — it appears as a SKIP-STEP, never a
  // file-level SKIP (so default-app is absent from the --ignore list above
  // and present as a step here).
  assertMatch(
    report,
    /patterns: SKIP-STEP integration\/default-app\.test\.ts :: should persist and reload every rapidly created notebook note \(until phase-7; the rest of the file runs\)/,
  );
  // The convergence-storm storm-step entry was LIFTED (OW52 CLOSED,
  // 2026-08-21: the 23/40 red was the harness's served-topology settle
  // racing the serving drain — no loss at any seam; the settle now waits
  // for event-consequence quiescence and the step is green ON 5/5). The
  // file's in-file guard remains and resolves to NO entry, so the step
  // RUNS on the ON arm — pinned here so a re-skip is a deliberate edit.
  assert(
    !report.includes("integration/convergence-storm.test.ts"),
    "convergence-storm must carry NO skip entry (OW52 closed; the storm step runs ON)",
  );
  // The cellset-lww own-write-race step is LIFTED (verification-coverage.md
  // OW47 closed, the optimize pass): no entry, so the step RUNS on the ON
  // arm — the lift's CI evidence.
  assertEquals(
    SERVER_EXECUTION_ON_SKIPS.patterns.some((skip) =>
      skip.file === "integration/cellset-lww.test.ts"
    ),
    false,
  );
  // home-profile-reload-durability is LIFTED (the explicit warm request,
  // serving-loop.md §1's third activation trigger, RULED 2026-08-21: the
  // serving-side provisioning path's staged setup activates and derives
  // in a parked, sessionless space — the §2b report §4's setup-after-park
  // ordering race closed; 6/6 fresh-store ON gate runs, both steps
  // green): no entry, so the file RUNS on the ON arm — pinned here so a
  // re-skip is a deliberate edit.
  assert(
    !report.includes("integration/home-profile-reload-durability.test.ts"),
    "home-profile-reload-durability must carry NO skip entry (the warm " +
      "request landed; the file runs ON)",
  );
  // profile-embed is LIFTED (verification-coverage.md OW47's re-close,
  // RULED 2026-08-21: the name-draft own-write loss — the CFC
  // verifier-read basis, the file's LAST blocker after RULING 5/OW49
  // and the §2b derivation-carriage close): no entry, so the file RUNS
  // on the ON arm — the lift's CI evidence, pinned so a re-skip is a
  // deliberate edit.
  assertEquals(
    SERVER_EXECUTION_ON_SKIPS.patterns.some((skip) =>
      skip.file === "integration/profile-embed.test.ts"
    ),
    false,
  );
  // cfc-group-chat-demo is LIFTED (verification-coverage.md OW59 closed,
  // the OW34-family train, 2026-08-21): a served run's CFC trust snapshot
  // carries the acting principal, so the authorship labels name the acting
  // user and the file greens under the true ON topology (4/4 — three
  // fresh-store lift runs plus a quiet-machine solo run; zero
  // authored-by/represents-principal atoms naming the service DID in
  // every run's store audit). No entry — the file RUNS on the ON arm; a
  // re-skip is a deliberate edit here.
  assertEquals(
    SERVER_EXECUTION_ON_SKIPS.patterns.some((skip) =>
      skip.file === "integration/cfc-group-chat-demo.test.ts"
    ),
    false,
  );
  // The two-browser gates RUN in the ON arm: cfc-group-chat-two-browsers
  // (fan-out stage B) and lunch-poll-vote (W3.1's S1 + the 6/6 lift).
  assertEquals(
    SERVER_EXECUTION_ON_SKIPS.patterns.some((skip) =>
      skip.file === "integration/cfc-group-chat-demo-two-browsers.test.ts"
    ),
    false,
  );
  assertEquals(
    SERVER_EXECUTION_ON_SKIPS.patterns.some((skip) =>
      skip.file === "integration/lunch-poll-vote.test.ts"
    ),
    false,
  );
  // …and so does cfc-group-chat-demo-multi-runtime: its CI red was the
  // harness's mixed posture, fixed IN the harness, never skip-listed.
  assertEquals(
    SERVER_EXECUTION_ON_SKIPS.patterns.some((skip) =>
      skip.file === "integration/cfc-group-chat-demo-multi-runtime.test.ts"
    ),
    false,
  );
  // topics-navigation keeps the loud-skip contract: its reason names
  // the red's mechanism and the flip's condition. Re-tensed by the OW33
  // triage (2026-08-22): the recorded fail-fast myName validation red did
  // not reproduce at the true ON topology; the reason now carries the
  // residual 2/10 flake's mechanism (the echo-run drop at the
  // stream-action validation guard + the unbarriered topicAt capture),
  // the triage-report evidence path, and the 10/10 lift condition.
  const topics = SERVER_EXECUTION_ON_SKIPS.patterns.find((skip) =>
    skip.file === "integration/topics-navigation.test.ts"
  );
  if (topics === undefined) throw new Error("missing topics-navigation entry");
  assertEquals(topics.phase, "phase-7");
  assertMatch(topics.reason, /OW33 triage \(2026-08-22/);
  assertMatch(topics.reason, /did NOT reproduce/);
  assertMatch(topics.reason, /stream action argument is undefined/);
  assertMatch(topics.reason, /ow33-triage-report\.md/);
  assertMatch(topics.reason, /greens 10\/10/);
  assertMatch(topics.reason, /flip PR needs this list EMPTY/);
  const gateEntries = SERVER_EXECUTION_ON_SKIPS.patterns.filter((skip) =>
    skip.file !== "integration/topics-navigation.test.ts"
  );
  assertEquals(gateEntries.length, 3);
  // Every ORIGINAL first-ON-CI-gate FILE entry (the two that have not
  // lifted): phase-7, the gate report path, an owed register row (OW31 or a
  // freshly minted OW45–OW53), the honest no-demand-hole classification, and
  // the flip's EMPTY-list condition.
  const fileGateEntries = gateEntries.filter((skip) => skip.step === undefined);
  assertEquals(fileGateEntries.length, 2);
  for (const entry of fileGateEntries) {
    assertEquals(entry.phase, "phase-7");
    assertMatch(entry.reason, /First ON-lane CI gate \(2026-08-21/);
    assertMatch(entry.reason, /first-on-ci-gate\.md/);
    assertMatch(entry.reason, /OW(31|4[5-9]|5[0-3])/);
    assertMatch(entry.reason, /(NOT|NEITHER) a demand hole/i);
    assertMatch(entry.reason, /flip PR needs this list EMPTY/);
  }
  // ONE step entry remains: default-app's reload step, the OW45 residual the
  // OW51 fix unmasked (cellset-lww's OW47 and convergence-storm's OW52 step
  // lifts landed earlier the same day). It carries the same phase, the
  // no-demand-hole classification, the EMPTY-list condition, and its owed
  // row (OW45) + build-report evidence — but points at the OW51 build report,
  // not the first-ON-CI-gate report, because it is a POST-lift residual, not
  // an original gate red.
  const steps = gateEntries.filter((skip) => skip.step !== undefined);
  assertEquals(steps.map((skip) => skip.file), [
    "integration/default-app.test.ts",
  ]);
  const reloadStep = steps[0];
  assertEquals(reloadStep.phase, "phase-7");
  assertEquals(
    reloadStep.step,
    "should persist and reload every rapidly created notebook note",
  );
  assertMatch(reloadStep.reason, /OW45/);
  assertMatch(reloadStep.reason, /OW51 fix/);
  assertMatch(reloadStep.reason, /ow51-build-report\.md/);
  assertMatch(reloadStep.reason, /(NOT|NEITHER) a demand hole/i);
  assertMatch(reloadStep.reason, /flip PR needs this list EMPTY/);
  // BOUND: the guard lookup default-app.test.ts calls resolves exactly this
  // entry (the validator additionally checks the file names the step and
  // calls the guard).
  assertEquals(
    serverExecutionOnStepSkip(
      "patterns",
      reloadStep.file,
      reloadStep.step!,
    ),
    reloadStep,
  );
  // Lifted files pass through the shard filter untouched (and a step
  // entry, were one re-listed, would never drop its file).
  const { files, skipped } = serverExecutionOnFilterFiles("patterns", [
    "./integration/cellset-lww.test.ts",
    "./integration/convergence-storm.test.ts",
  ]);
  assertEquals(files, [
    "./integration/cellset-lww.test.ts",
    "./integration/convergence-storm.test.ts",
  ]);
  assertEquals(skipped, []);
  assertEquals(SERVER_EXECUTION_ON_SKIPS.patterns.length, 4);
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

Deno.test("main: the runner list holds exactly the pattern-and-data-persistence entry — ROOT-CAUSED by the OW33 triage (2026-08-22): the speculation overlay's arrival-gate witness hole, a ~40% flake, awaiting the arrival-witness fork ruling — printed loudly, never silent", async () => {
  const { out, err, io } = captureIo();
  assertEquals(await main(["runner"], io), 0);
  assertEquals(out, [
    "--ignore=integration/pattern-and-data-persistence.test.ts",
  ]);
  assertMatch(
    err[0],
    /runner: SKIP integration\/pattern-and-data-persistence\.test\.ts \(until phase-7\)/,
  );
  const [entry] = SERVER_EXECUTION_ON_SKIPS.runner;
  assertEquals(SERVER_EXECUTION_ON_SKIPS.runner.length, 1);
  assertEquals(entry.phase, "phase-7");
  assertMatch(entry.reason, /OW33 triage \(2026-08-22/);
  assertMatch(entry.reason, /ARRIVAL GATE/);
  assertMatch(entry.reason, /ow33-arrival-witness-fork\.md/);
  assertMatch(entry.reason, /ow33-triage-report\.md/);
  assertMatch(entry.reason, /greens 10\/10/);
  assertMatch(entry.reason, /flip PR needs this list EMPTY/);
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
