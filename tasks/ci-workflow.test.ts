import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import { getBinary } from "@astral/astral";
import { phaseOf } from "./ci-step-phases.ts";
import { EXPECTED_COVERAGE_ARTIFACT_NAMES } from "./coverage-check.ts";
import { PATTERN_INTEGRATION_SHARD_COUNT } from "./select-pattern-integration-files.ts";

function jobBlock(workflow: string, jobId: string): string {
  const jobsStart = workflow.indexOf("jobs:\n");
  assert(jobsStart >= 0, "workflow jobs section not found");

  const header = `  ${jobId}:\n`;
  const start = workflow.indexOf(header, jobsStart);
  assert(start >= 0, `${jobId} job not found`);

  const bodyStart = start + header.length;
  const nextJobOffset = workflow.slice(bodyStart).search(
    /^ {2}[A-Za-z_][A-Za-z0-9_-]*:\n/m,
  );
  const end = nextJobOffset < 0 ? workflow.length : bodyStart + nextJobOffset;
  return workflow.slice(start, end);
}

function jobIds(workflow: string): string[] {
  const jobsStart = workflow.indexOf("jobs:\n");
  assert(jobsStart >= 0, "workflow jobs section not found");
  return [
    ...workflow.slice(jobsStart).matchAll(
      /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\n/gm,
    ),
  ].map((match) => match[1]);
}

function expandedJobCount(job: string): number {
  const includeRows = [...job.matchAll(/^ {10}- [A-Za-z_][A-Za-z0-9_-]*:/gm)];
  if (includeRows.length > 0) return includeRows.length;

  const dimensions = [
    ...job.matchAll(/^ {8}[A-Za-z_][A-Za-z0-9_-]*: \[([^\]]+)\]$/gm),
  ];
  return dimensions.reduce(
    (count, dimension) => count * dimension[1].split(",").length,
    1,
  );
}

function stepBlock(job: string, stepName: string): string {
  const header = `      - name: ${stepName}\n`;
  const start = job.indexOf(header);
  assert(start >= 0, `${stepName} step not found`);

  const bodyStart = start + header.length;
  const nextStepOffset = job.slice(bodyStart).search(/^ {6}- name: /m);
  const end = nextStepOffset < 0 ? job.length : bodyStart + nextStepOffset;
  return job.slice(start, end);
}

function stepBlocks(job: string): { name: string; body: string }[] {
  return job.split(/^ {6}- name: /m).slice(1).map((step) => {
    const nameEnd = step.indexOf("\n");
    return { name: step.slice(0, nameEnd), body: step.slice(nameEnd + 1) };
  });
}

// The minutes each YAML anchor in the workflow stands for, by anchor name.
function anchoredMinutes(contents: string): Map<string, number> {
  return new Map(
    [...contents.matchAll(/^ +[A-Za-z_]+: &([a-z][a-z0-9-]*) (\d+)$/gm)].map((
      match,
    ) => [match[1], Number(match[2])]),
  );
}

// A `timeout-minutes` value is an alias to one of those anchors, so that the
// minutes themselves are written once. A value that is anything else — a number
// written in place, or an expression, whose arithmetic GitHub does not document
// anyway — has no minutes to give back and fails the check that asked.
function boundMinutes(
  anchors: Map<string, number>,
  value: string,
): number | null {
  const alias = value.match(/^\*([a-z][a-z0-9-]*)$/);
  return alias ? anchors.get(alias[1]) ?? null : null;
}

function neededJobIds(job: string): string[] {
  const marker = "\n    needs:\n";
  const needsStart = job.indexOf(marker);
  assert(needsStart >= 0, "job needs list not found");

  const needsBody = job.slice(needsStart + marker.length);
  const nextProperty = needsBody.search(/^ {4}[A-Za-z_][A-Za-z0-9_-]*:/m);
  const needs = nextProperty < 0 ? needsBody : needsBody.slice(0, nextProperty);
  return [...needs.matchAll(/^ {6}- ([A-Za-z_][A-Za-z0-9_-]*)$/gm)].map(
    (match) => match[1],
  );
}

const workflowDirectory = new URL("../.github/workflows/", import.meta.url);

async function workflow(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, workflowDirectory));
}

async function workflowNames(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(workflowDirectory)) {
    if (entry.isFile && /\.ya?ml$/.test(entry.name)) names.push(entry.name);
  }
  return names.sort();
}

// Every YAML file under .github, so the composite actions are read alongside
// the workflows that use them.
async function* githubYamlPaths(
  directory: URL = new URL("../.github/", import.meta.url),
): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(directory)) {
    const path = new URL(
      `${entry.name}${entry.isDirectory ? "/" : ""}`,
      directory,
    );
    if (entry.isDirectory) yield* githubYamlPaths(path);
    else if (/\.ya?ml$/.test(entry.name)) yield path;
  }
}

function stepNames(contents: string): string[] {
  return [...contents.matchAll(/^ *- name: (.+)$/gm)].map((match) => match[1]);
}

// Drops YAML comments. A `#` after whitespace ends a plain scalar, so what is
// left on a line is the value the workflow actually carries. Applied before
// looking for commands, so that a comment naming a command is not read as one
// and a comment after a command is not read as part of it.
function withoutComments(contents: string): string {
  return contents.replaceAll(/(^|\s)#.*$/gm, "$1");
}

function deployInvocations(contents: string): string[] {
  return [...contents.matchAll(/^ +script: (\/opt\/cf\/deploy\.sh.*)$/gm)].map(
    (match) => match[1],
  );
}

// Splits a command the way a shell would count its words, except that a
// `${{ ... }}` workflow expression holds spaces and still stands for one word.
// The expression is matched to its first `}}` so that one containing a brace,
// as `${{ format('{0}', github.sha) }}` does, still comes out as one word.
function commandWords(command: string): string[] {
  return [...command.matchAll(/\$\{\{.*?\}\}|\S+/g)].map((match) => match[0]);
}

function workflowTriggers(contents: string): string {
  const triggerEnd = contents.indexOf("\npermissions:");
  if (triggerEnd >= 0) return contents.slice(0, triggerEnd);

  const concurrencyStart = contents.indexOf("\nconcurrency:");
  assert(concurrencyStart >= 0, "workflow trigger section not found");
  return contents.slice(0, concurrencyStart);
}

// Every other check in this file reads the workflow files as TEXT (regex over
// job and step blocks), so none of them can notice that a file has stopped
// being valid YAML — and a workflow that does not parse produces ZERO jobs on
// every push while every text-level check here stays green. That happened: an
// unquoted `default: ` inside two step names turned deno.yml into a nested
// mapping the runner refused, and CI silently ran nothing for a whole stack of
// pushes. This is the one check that would have caught it.
Deno.test("every workflow and composite action is valid YAML", async () => {
  const broken: string[] = [];
  for await (const path of githubYamlPaths()) {
    const contents = await Deno.readTextFile(path);
    try {
      parseYaml(contents);
    } catch (error) {
      broken.push(
        `${path.pathname.split("/.github/")[1]}: ${
          String(error).split("\n")[0]
        }`,
      );
    }
  }
  assertEquals(
    broken,
    [],
    "these files under .github do not parse as YAML — the runner will " +
      "schedule NO jobs from them, and every text-level check in this file " +
      "stays green while it does",
  );
});

Deno.test("CI browser tests use the runner's installed Chrome", async () => {
  const contents = await workflow("deno.yml");
  const configuredPath = contents.match(
    /^ {2}ASTRAL_BIN_PATH: (\S+)$/m,
  )?.[1];
  const cache = await Deno.makeTempDir();
  const savedPath = Deno.env.get("ASTRAL_BIN_PATH");
  const savedCi = Deno.env.get("CI");
  const savedFetch = globalThis.fetch;

  try {
    assertEquals(configuredPath, "/usr/bin/google-chrome");
    Deno.env.set("CI", "1");
    Deno.env.delete("ASTRAL_BIN_PATH");
    if (configuredPath) Deno.env.set("ASTRAL_BIN_PATH", Deno.execPath());
    globalThis.fetch = (input) => {
      const url = String(input);
      if (url.endsWith("known-good-versions-with-downloads.json")) {
        return Promise.resolve(Response.json({
          versions: [{
            version: "125.0.6400.0",
            downloads: {
              chrome: [
                "linux64",
                "mac-arm64",
                "mac-x64",
                "win64",
              ].map((platform) => ({
                platform,
                url: "https://example.invalid/truncated.zip",
              })),
            },
          }],
        }));
      }
      const truncatedArchive = new Uint8Array(22);
      truncatedArchive.set([0x50, 0x4b, 0x03, 0x04]);
      return Promise.resolve(new Response(truncatedArchive));
    };

    assertEquals(
      await getBinary("chrome", { cache }),
      Deno.execPath(),
    );
  } finally {
    globalThis.fetch = savedFetch;
    if (savedPath === undefined) Deno.env.delete("ASTRAL_BIN_PATH");
    else Deno.env.set("ASTRAL_BIN_PATH", savedPath);
    if (savedCi === undefined) Deno.env.delete("CI");
    else Deno.env.set("CI", savedCi);
    await Deno.remove(cache, { recursive: true });
  }
});

Deno.test("Check preserves a native crash from Deno lint", async () => {
  const contents = await workflow("deno.yml");
  const check = jobBlock(contents, "check");
  const lint = stepBlock(check, "🧹 Lint codebase");
  const describe = stepBlock(check, "📋 Describe Deno lint core dump");
  const upload = stepBlock(check, "📤 Upload Deno lint core dump");

  assertStringIncludes(lint, "ulimit -c unlimited");
  assertStringIncludes(
    lint,
    'sudo sysctl -w kernel.core_pattern="$GITHUB_WORKSPACE/deno-core.%p"',
  );
  assertStringIncludes(
    lint,
    "deno task run-recorded lint repo deno-lint -- deno lint",
  );
  assertStringIncludes(describe, "if: ${{ failure() }}");
  assertStringIncludes(describe, 'file "$core"');
  assertStringIncludes(upload, "if: ${{ failure() }}");
  assertStringIncludes(upload, "uses: actions/upload-artifact@v7");
  assertStringIncludes(
    upload,
    "name: deno-lint-core-a${{ github.run_attempt }}",
  );
  assertStringIncludes(upload, "path: deno-core.*");
  assertStringIncludes(upload, "if-no-files-found: ignore");
  assert(
    check.indexOf("🧹 Lint codebase") <
        check.indexOf("📋 Describe Deno lint core dump") &&
      check.indexOf("📋 Describe Deno lint core dump") <
        check.indexOf("📤 Upload Deno lint core dump") &&
      check.indexOf("📤 Upload Deno lint core dump") <
        check.indexOf("🔎 Type check codebase"),
    "the lint crash report must run immediately after the lint step",
  );
});

Deno.test("Status waits for every pull request validation job", async () => {
  const contents = await workflow("deno.yml");
  const gate = jobBlock(contents, "status");
  const pushOnlyJobs = new Set([
    "attest-binaries",
    "deploy-rapids",
    "deploy-shell-staging",
  ]);
  const expected = jobIds(contents).filter((jobId) =>
    jobId !== "status" && !pushOnlyJobs.has(jobId)
  ).sort();

  assertEquals(neededJobIds(gate).sort(), expected);
  assertStringIncludes(contents, "name: CI\n");
  assertStringIncludes(gate, 'name: "Status"');
  assertStringIncludes(
    gate,
    "if: ${{ always() && github.event_name == 'pull_request' }}",
  );
  assertStringIncludes(gate, "JOB_RESULTS: ${{ toJSON(needs) }}");
  assertStringIncludes(gate, 'select(.value.result != "success")');
  assertStringIncludes(gate, "permissions: {}");

  // A path filter would leave the required check pending on a pull request
  // that touches none of the listed paths.
  const triggers = workflowTriggers(contents);
  assertStringIncludes(triggers, "  pull_request:\n");
  assertEquals(triggers.includes("\n    paths:"), false);
});

Deno.test("the first CI wave leaves runner capacity for another run", async () => {
  const contents = await workflow("deno.yml");
  const githubParallelRunnerLimit = 60;
  const firstWaveJobs = jobIds(contents)
    .map((jobId) => jobBlock(contents, jobId))
    .filter((job) => !/^ {4}needs:/m.test(job));
  const firstWaveRunnerCount = firstWaveJobs.reduce(
    (count, job) => count + expandedJobCount(job),
    0,
  );

  assert(
    firstWaveRunnerCount < githubParallelRunnerLimit / 2,
    `the dependency-free wave expands to ${firstWaveRunnerCount} jobs; ` +
      `two overlapping runs must fit within GitHub's ` +
      `${githubParallelRunnerLimit}-runner limit`,
  );
});

Deno.test("every step we name carries a phase marker", async () => {
  // A step whose name starts with no marker in `PHASE_MARKERS` is charted as
  // "other", which is how a job's setup time goes missing from the timings
  // people read when deciding what to make faster. The classifier reads the
  // marker rather than the wording, so the check is the classifier itself.
  const unmarked: string[] = [];
  let steps = 0;
  for await (const path of githubYamlPaths()) {
    for (const name of stepNames(await Deno.readTextFile(path))) {
      steps++;
      if (phaseOf(name) !== "other") continue;
      unmarked.push(`${path.pathname.split("/.github/")[1]}: ${name}`);
    }
  }

  assert(steps > 100, `only ${steps} steps found; the search read nothing`);
  assertEquals(
    unmarked,
    [],
    "these steps start with no marker from docs/development/CI_PERFORMANCE.md",
  );
});

Deno.test("every work step is bounded before its job is", async () => {
  // GitHub ends a job that runs past the job's own `timeout-minutes` by
  // cancelling it, so the job's conclusion is `cancelled` — the same conclusion
  // a run stopped by hand or superseded by a newer push carries, and one that
  // reads as nobody's fault. A step that runs past the step's own bound fails
  // instead, and its job fails with it. Each work step therefore carries a
  // bound of its own, below the bound on the job by the headroom the setup and
  // upload steps around it normally need. Both bounds are aliases to an anchor,
  // so each is a name here rather than a number, and the minutes behind the
  // names are written once.
  const headroom = 10;
  const contents = await workflow("deno.yml");
  const anchors = anchoredMinutes(contents);
  // The deploy jobs hand the work to a script that lives elsewhere — one on the
  // bastion, one in Cloud Storage — and how long that takes is not this
  // workflow's to say. They carry no bound, so none is asked of them here.
  const unboundedJobs = new Set(["deploy-rapids", "deploy-shell-staging"]);

  for (const jobId of jobIds(contents)) {
    if (unboundedJobs.has(jobId)) continue;
    const job = jobBlock(contents, jobId);
    const jobValue = job.match(/^ {4}timeout-minutes: (.+)$/m);
    assert(jobValue, `${jobId}: job has no timeout-minutes`);
    const jobBound = boundMinutes(anchors, jobValue[1]);
    assert(
      jobBound,
      `${jobId}: timeout-minutes ${jobValue[1]} is not an anchored bound`,
    );

    const work = stepBlocks(job).filter((step) =>
      phaseOf(step.name) === "work"
    );
    // Every job here does work of its own, so an empty list means the steps
    // went unread rather than that this job had none to bound.
    assert(work.length > 0, `${jobId}: no work step found`);

    for (const step of work) {
      const stepValue = step.body.match(/^ {8}timeout-minutes: (.+)$/m);
      assert(stepValue, `${jobId}: "${step.name}" has no timeout-minutes`);
      const stepBound = boundMinutes(anchors, stepValue[1]);
      assert(
        stepBound,
        `${jobId}: "${step.name}" timeout-minutes ${stepValue[1]} is not an ` +
          `anchored bound`,
      );
      assert(
        jobBound - stepBound >= headroom,
        `${jobId}: "${step.name}" is bounded at ${stepBound} minutes within a ` +
          `job bounded at ${jobBound}, leaving under ${headroom} minutes ` +
          `between that step bound and the outer job bound`,
      );
    }
  }
});

Deno.test("Coverage Comment follows the CI workflow by name", async () => {
  const deno = await workflow("deno.yml");
  const comment = await workflow("coverage-comment.yml");
  const name = deno.match(/^name: (.+)$/m);
  assert(name, "workflow name not found");

  assertStringIncludes(comment, `    workflows: ["${name[1]}"]\n`);
});

Deno.test("coverage requirements follow sharded test matrices", async () => {
  const contents = await workflow("deno.yml");
  const jobs = [
    ["test", "coverage-profile-workspace-", "shard"],
    ["runner-test", "coverage-profile-runner-", "shard"],
    [
      "generated-patterns-integration-test",
      "coverage-profile-generated-patterns-",
      "shard",
    ],
    [
      "pattern-integration-test",
      "coverage-profile-pattern-integration-",
      "shard",
    ],
    ["pattern-unit-test", "coverage-profile-pattern-unit-", "chunk"],
  ] as const;

  for (const [jobId, artifactPrefix, dimension] of jobs) {
    const job = jobBlock(contents, jobId);
    const shardMatch = job.match(
      new RegExp(`^ {8}${dimension}: \\[([0-9, ]+)\\]$`, "m"),
    );
    const totalMatch = job.match(/^ {8}total: \[(\d+)\]$/m);
    assert(shardMatch, `${jobId} ${dimension} matrix not found`);
    assert(totalMatch, `${jobId} total matrix not found`);

    const shards = shardMatch[1].split(",").map((value) =>
      Number(value.trim())
    );
    const total = Number(totalMatch[1]);
    if (jobId === "pattern-integration-test") {
      assertEquals(
        total,
        PATTERN_INTEGRATION_SHARD_COUNT,
        "pattern integration matrix must use its measured weight profile",
      );
    }
    assertEquals(
      shards,
      Array.from({ length: total }, (_, index) => index + 1),
      `${jobId} must list every ${dimension} exactly once`,
    );
    assertStringIncludes(
      job,
      `name: ${artifactPrefix}\${{ matrix.${dimension} }}`,
    );
    assertEquals(
      EXPECTED_COVERAGE_ARTIFACT_NAMES.filter((name) =>
        name.startsWith(artifactPrefix)
      ),
      shards.map((shard) => `${artifactPrefix}${shard}`),
      `${jobId} coverage requirements must match its matrix`,
    );
  }
});

Deno.test("sharded pattern caches follow their shard topology", async () => {
  const contents = await workflow("deno.yml");
  for (
    const [jobId, selector, dimension] of [
      [
        "generated-patterns-integration-test",
        "'tasks/select-generated-pattern-files.ts'",
        "shard",
      ],
      [
        "pattern-integration-test",
        "'tasks/select-pattern-integration-files.ts'",
        "shard",
      ],
      ["pattern-unit-test", "'tasks/integration.ts'", "chunk"],
    ] as const
  ) {
    const job = jobBlock(contents, jobId);
    const topology = `-\${{ matrix.total }}-\${{ matrix.${dimension} }}-`;
    assertEquals(job.split(topology).length - 1, 2);
    const key = job.match(/^ {10}key: (.+)$/m);
    assert(key, `${jobId} cache key not found`);
    assertStringIncludes(key[1], selector);
    const restoreKeys = job.match(/restore-keys: \|\n((?: {12}.+\n)+)/);
    assert(restoreKeys, `${jobId} restore prefixes not found`);
    assertEquals(restoreKeys[1].trim().split("\n").length, 1);
  }
});

Deno.test("Dashboard publishes only from main, never from a pull request", async () => {
  const deno = await workflow("deno.yml");
  const dashboard = await workflow("dashboard-image.yml");

  assertEquals(deno.includes("dashboard-image.yml"), false);
  assertEquals(jobIds(deno).includes("dashboard"), false);

  assertStringIncludes(dashboard, "name: Dashboard\n");
  const triggers = workflowTriggers(dashboard);
  assertStringIncludes(triggers, "  workflow_dispatch: {}");
  assertStringIncludes(
    triggers,
    "  push:\n    branches: [main]\n    paths:\n",
  );
  assertEquals(triggers.includes("  pull_request:"), false);
  assertEquals(triggers.includes("  workflow_call:"), false);
  assertStringIncludes(
    dashboard,
    "\npermissions:\n  contents: read\n\nconcurrency:\n",
  );
  assertStringIncludes(dashboard, "group: dashboard-${{ github.ref }}");
  assertEquals(jobIds(dashboard).sort(), ["publish", "tests"]);

  // A manual run can name any ref, so the tests job refuses anything but main
  // before the publish job it gates gets a credential. The guard has to fail
  // the run, not just report: a guard that only warns lets a dispatch from any
  // branch move the `latest` tag.
  const tests = jobBlock(dashboard, "tests");
  assertEquals(tests.includes("id-token: write"), false);
  const guard = stepBlock(tests, "🔎 Verify the run is on main");
  assertStringIncludes(guard, "if: ${{ github.ref != 'refs/heads/main' }}");
  assertStringIncludes(guard, "\n          exit 1\n");

  const publish = jobBlock(dashboard, "publish");
  assertStringIncludes(publish, "needs: [tests]");
  assertEquals(publish.includes("\n    if:"), false);
  assertStringIncludes(
    publish,
    "permissions:\n      contents: read\n      id-token: write",
  );

  // Both tags go up in the one push: the immutable commit tag the infra
  // overlay pins, and the `latest` the deployment follows.
  const build = stepBlock(publish, "🏗️ Build and push dashboard image");
  assertStringIncludes(build, "\n          push: true\n");
  assertStringIncludes(
    build,
    "\n          build-args: |\n" +
      "            DASHBOARD_GIT_COMMIT=${{ github.sha }}\n",
  );
  assertStringIncludes(
    build,
    "\n          tags: |\n" +
      "            ${{ env.IMAGE }}:${{ github.sha }}\n" +
      "            ${{ env.IMAGE }}:latest\n",
  );
});

Deno.test("Deploy steps call the bastion wrapper the way it accepts", async () => {
  // The bastion's /opt/cf/deploy.sh takes an environment name and a
  // 40-character commit SHA, and nothing else. Hand it a third argument, an
  // environment it does not know, or a revision that is not a full SHA, and it
  // prints its usage and exits 1, failing the deploy job. That script belongs
  // to the infra repository, so nothing else here sees it and the call sites
  // are checked instead. docs/development/deploying.md covers the seam.
  const environments = ["estuary", "rapids"];
  // The revision has to expand to a full SHA, which is a property of what the
  // expression reads rather than of the expression itself. `github.ref_name`
  // would look just as much like a revision here and fail on the bastion, so
  // the expressions whose value is a full SHA are named.
  const revisions = ["${{ github.sha }}", "${{ steps.resolve.outputs.sha }}"];

  const callers: string[] = [];
  for (const name of await workflowNames()) {
    const contents = withoutComments(await workflow(name));
    const mentions = [...contents.matchAll(/\/opt\/cf\/deploy\.sh/g)].length;
    if (mentions === 0) continue;
    callers.push(name);

    // Invocations are found by their one-line `script:` value. Counting the
    // mentions of the script separately catches a call site written some other
    // way, which would otherwise go unchecked.
    const invocations = deployInvocations(contents);
    assertEquals(
      invocations.length,
      mentions,
      `${name}: every deploy.sh call belongs on a single script: line`,
    );

    for (const invocation of invocations) {
      const args = commandWords(invocation).slice(1);
      assertEquals(args.length, 2, `${name}: wrong arity in \`${invocation}\``);
      assert(
        args[0].startsWith("${{") || environments.includes(args[0]),
        `${name}: unknown environment in \`${invocation}\``,
      );
      assert(
        revisions.includes(args[1]),
        `${name}: \`${args[1]}\` is not known to be a full SHA, in ` +
          `\`${invocation}\``,
      );
    }
  }

  // Every workflow that calls the script is checked, so a new one is covered
  // without being listed. The two that call it today are named to catch the
  // case where the search comes back empty and the loop above does nothing.
  for (const name of ["deno.yml", "deploy-production.yml"]) {
    assert(callers.includes(name), `${name}: no deploy.sh call found`);
  }
});

Deno.test("every test-records artifact name is store-safe and unique", async () => {
  // The relay derives each store object's name from the artifact's name
  // through objectNameSlug, which collapses characters unsafe in object
  // names. Two artifacts in one run whose names differ only by collapsed
  // characters would produce one object name, and the second would be
  // mistaken for an idempotent re-ship and silently lost. Holding every
  // literal to the already-safe alphabet makes the slug the identity on
  // these names, so distinct names stay distinct in the store. Uniqueness
  // matters per workflow: object names carry the run id, so two different
  // workflows can reuse a name.
  let shipSteps = 0;
  for (const name of await workflowNames()) {
    const contents = withoutComments(await workflow(name));
    const artifacts: string[] = [];
    const chunks = contents.split("uses: ./.github/actions/test-records-ship");
    for (const chunk of chunks.slice(1)) {
      shipSteps++;
      const artifact = chunk.match(/^\s*artifact: (.+)$/m);
      assert(artifact, `${name}: a ship step with no artifact input`);
      artifacts.push(artifact[1].trim());
    }
    for (const artifact of artifacts) {
      const literal = artifact.replaceAll(/\$\{\{[^}]*\}\}/g, "");
      assert(
        /^[A-Za-z0-9._-]*$/.test(literal),
        `${name}: artifact name \`${artifact}\` has characters the store ` +
          "slug would collapse",
      );
    }
    assertEquals(
      new Set(artifacts).size,
      artifacts.length,
      `${name}: duplicate test-records artifact names`,
    );
  }
  // The count pins the search itself: zero found steps would mean the
  // extraction broke, not that the repository stopped shipping records.
  assert(shipSteps >= 14, `only ${shipSteps} ship steps found`);
});

Deno.test("every deno.yml job that writes a JUnit file spools and ships test records (the ON lanes' observability gap: 25 pattern-ON flakes had to be censused from raw Actions logs because the two server-execution ON jobs set no CF_TEST_RECORDS_DIR and had no ship step — records the dashboard never saw)", async () => {
  const contents = withoutComments(await workflow("deno.yml"));
  const missing: string[] = [];
  let junitJobs = 0;
  for (const jobId of jobIds(contents)) {
    const job = jobBlock(contents, jobId);
    if (!job.includes("--junit-path=")) continue;
    junitJobs++;
    if (!job.includes("uses: ./.github/actions/test-records-ship")) {
      missing.push(
        `${jobId}: writes a JUnit file but has no test-records-ship step`,
      );
    }
    if (!job.includes("CF_TEST_RECORDS_DIR:")) {
      missing.push(
        `${jobId}: runs tests without CF_TEST_RECORDS_DIR — the spool ` +
          "half of the records is never written",
      );
    }
  }
  assertEquals(missing, []);
  // Pin the search itself: zero junit jobs would mean the extraction
  // broke, not that the repository stopped writing JUnit files.
  assert(junitJobs >= 7, `only ${junitJobs} JUnit-writing jobs found`);
});
