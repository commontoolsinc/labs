import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parse as parseYaml } from "@std/yaml";
import { getBinary } from "@astral/astral";
import { commandWords, withoutComments } from "./ci-workflow.ts";
import { phaseOf } from "./ci-step-phases.ts";

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

function deployInvocations(contents: string): string[] {
  return [...contents.matchAll(/^ +script: (\/opt\/cf\/deploy\.sh.*)$/gm)].map(
    (match) => match[1],
  );
}

function workflowTriggers(contents: string): string {
  const triggerEnd = contents.indexOf("\npermissions:");
  if (triggerEnd >= 0) return contents.slice(0, triggerEnd);

  const concurrencyStart = contents.indexOf("\nconcurrency:");
  assert(concurrencyStart >= 0, "workflow trigger section not found");
  return contents.slice(0, concurrencyStart);
}

Deno.test("every workflow and composite action is valid YAML", async () => {
  // Every other check in this file reads the workflow files as TEXT (regex over
  // job and step blocks), so none of them can notice that a file has stopped
  // being valid YAML — and a workflow that does not parse produces ZERO jobs on
  // every push while every text-level check here stays green. Parsing is what
  // catches that, and an unquoted `default: ` inside a step name is enough to
  // turn a workflow into a nested mapping the runner refuses.

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

Deno.test("a lane keeps what it needs to explain a failure", async () => {
  // `deno lint` has crashed natively here before, and a stack from the dump
  // is what says where. A suite that could not reach the server it asked for
  // leaves the reason in that server's log. Neither survives a lane that
  // cleans up after itself, so the lane keeps its working directory when it
  // fails and the job uploads that directory beside the dump.
  const contents = await workflow("deno.yml");
  for (const jobId of ["pr-tests", "full-tests"]) {
    const job = jobBlock(contents, jobId);
    const enable = stepBlock(job, "🔧 Enable native crash dumps");
    assertStringIncludes(enable, "ulimit -c unlimited");
    assertStringIncludes(
      enable,
      'sudo sysctl -w kernel.core_pattern="$GITHUB_WORKSPACE/deno-core.%p"',
    );

    const upload = stepBlock(job, "📋 Upload what a failing lane left behind");
    assertStringIncludes(upload, "if: ${{ failure() }}");
    assertStringIncludes(upload, "uses: actions/upload-artifact@");
    assertStringIncludes(upload, "path: |\n            deno-core.*\n");
    assertStringIncludes(upload, "${{ runner.temp }}/ci-lane-*");
    assertStringIncludes(upload, "if-no-files-found: ignore");

    assert(
      job.indexOf("🔧 Enable native crash dumps") <
        job.indexOf("🧪 Run the lane"),
      `${jobId}: the crash pattern must be set before the lane runs`,
    );
  }
});

Deno.test("Status fails a pull request that ran no tests", async () => {
  const contents = await workflow("deno.yml");
  const gate = jobBlock(contents, "status");

  // Exactly the two paths, because exactly one of them runs: the five
  // selected lanes, or the full run the `ci: full` label asks for.
  assertEquals(neededJobIds(gate).sort(), ["full-tests", "pr-tests"]);
  assertStringIncludes(contents, "name: CI\n");
  assertStringIncludes(gate, 'name: "Status"');
  assertStringIncludes(
    gate,
    "if: ${{ always() && github.event_name == 'pull_request' }}",
  );
  assertStringIncludes(gate, "JOB_RESULTS: ${{ toJSON(needs) }}");

  // Two clauses. The first lets the path that did not run be skipped. The
  // second is what stops a pull request on which both were skipped —
  // mislabelled, or excluded by an `if:` somebody got wrong — reporting
  // green over no tests at all, which is the one failure of this design
  // that would otherwise be silent.
  assertStringIncludes(
    gate,
    'select(.value.result != "success" and .value.result != "skipped")',
  );
  assertStringIncludes(
    gate,
    'select(.key == "pr-tests" or .key == "full-tests")',
  );
  assertStringIncludes(gate, 'if [[ "$ran" -eq 0 ]]; then');

  // The gate is scored here because this is the only job that sees every
  // lane's coverage, and it works out which sets it covers for itself.
  assertStringIncludes(
    stepBlock(gate, "📊 Run the coverage gate"),
    "tasks/coverage-gate.ts",
  );

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

Deno.test("Pull Request Comments follows the CI workflow by name", async () => {
  const deno = await workflow("deno.yml");
  const comment = await workflow("pull-request-comments.yml");
  const name = deno.match(/^name: (.+)$/m);
  assert(name, "workflow name not found");

  assertStringIncludes(comment, `    workflows: ["${name[1]}"]\n`);
});

// A workflow_run payload describes the run it names, not the run that
// triggered it, so only a first-level follower of the test workflow can
// read a run's own event, branch and head. A follower of a follower gets
// the default branch and its tip whatever the triggering run was.
Deno.test("the comment job selects runs by the triggering run's own facts", async () => {
  const comment = await workflow("pull-request-comments.yml");
  assertStringIncludes(
    comment,
    "github.event.workflow_run.event == 'push' &&",
  );
  assertStringIncludes(
    comment,
    "github.event.workflow_run.head_branch == 'main' &&",
  );
});

// The run report reads the tree of the commit it reports on, so that the
// topology it packs is the pull request's tree as it landed and the diff
// it reads is the change itself. That commit is on the default branch,
// which is what makes it safe to run in a job holding a write token; a
// pull request head in the same job would be running fork-authored code
// with permission to comment as the repository.
Deno.test("the run report checks out the commit it reports on", async () => {
  const comment = await workflow("pull-request-comments.yml");
  assertStringIncludes(
    comment,
    "ref: ${{ github.event.workflow_run.head_sha }}",
  );
  assertStringIncludes(comment, "fetch-depth: 2");
});

Deno.test("every lane uploads its coverage, and the joiners read it", async () => {
  // A measured set's units are ordinary mandatory items, so the packer
  // spreads them over as many lanes as it likes. What joins them again is
  // the artifact each lane uploads, which is why every lane has to upload
  // one and the jobs that add them up have to name a pattern covering all
  // of them.
  const contents = await workflow("deno.yml");
  const artifacts = new Map([
    ["pr-tests", "coverage-pr-lane-${{ matrix.lane }}"],
    ["full-tests", "coverage-full-lane-${{ matrix.lane }}"],
  ]);
  for (const [jobId, artifact] of artifacts) {
    const upload = stepBlock(
      jobBlock(contents, jobId),
      "📤 Upload the lane's coverage reports",
    );
    assertStringIncludes(upload, `name: ${artifact}`);
    assertStringIncludes(upload, "if: always()");
    assertStringIncludes(upload, "path: coverage/lcov");
  }

  // Every job that adds the reports up: the gate on a pull request, the
  // figures the default branch publishes, and the release report.
  const joiners = new Map([
    ["status", "coverage-*-lane-*"],
    ["coverage-report", "coverage-full-lane-*"],
    ["attest-binaries", "coverage-full-lane-*"],
  ]);
  for (const [jobId, pattern] of joiners) {
    assertStringIncludes(
      jobBlock(contents, jobId),
      `pattern: ${pattern}`,
      `${jobId} must download the lanes' coverage`,
    );
  }
});

Deno.test("a lane's cache is one exact key over one directory", async () => {
  // One step covering one directory is what keeps the workflow independent
  // of which capabilities a lane turns out to open. The key is exact, with
  // no restore-key prefix: a capability that finds a binary under that
  // directory uses it without asking what it was built from, so a prefix
  // would hand it one built from other sources.
  const contents = await workflow("deno.yml");
  for (const jobId of ["pr-tests", "full-tests"]) {
    const step = stepBlock(
      jobBlock(contents, jobId),
      "♻️ Restore what the lane keeps between runs",
    );
    assertStringIncludes(step, "uses: actions/cache@");
    assert(
      !step.includes("restore-keys"),
      `${jobId}: the lane cache must not restore from a prefix`,
    );
  }
  // The inputs are written once and aliased, so the two lanes cannot drift
  // into caching against different sources.
  assertStringIncludes(contents, "        with: &lane-cache\n");
  assertStringIncludes(contents, "        with: *lane-cache\n");
  assertStringIncludes(contents, "          path: .ci-cache\n");
  assertStringIncludes(contents, "lane-${{ matrix.lane }}-${{ hashFiles(");
  assertStringIncludes(contents, "'tasks/build-binaries.ts'");
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

Deno.test("the Dashboard workflow records no tests", async () => {
  const dashboard = withoutComments(await workflow("dashboard-image.yml"));
  const relay = withoutComments(await workflow("test-records-relay.yml"));

  // CI runs `packages/dashboard`'s test task on the same commit and records
  // what it runs. Recording the same task again here would file each of those
  // tests twice against one commit, so this workflow takes no part in test
  // records at either end: it spools nothing, and the relay does not follow
  // it. Reinstating either half alone produces a run whose records are
  // gathered and never shipped.
  assertEquals(dashboard.includes("CF_TEST_RECORDS_DIR"), false);
  assertEquals(dashboard.includes("run-recorded"), false);
  assertEquals(dashboard.includes("test-records-ship"), false);
  assertStringIncludes(workflowTriggers(relay), '    workflows: ["CI"]\n');
});

Deno.test("the Coverage Report job records no tests", async () => {
  const job = jobBlock(
    withoutComments(await workflow("deno.yml")),
    "coverage-report",
  );

  // It reads the coverage artifacts of every lane in this run, so no lane
  // can be asked to run it, and the criterion in `docs/specs/test-records.md`
  // under "Recording" puts it outside test records: no spool directory, no
  // wrapper, no ship step.
  assert(!job.includes("CF_TEST_RECORDS_DIR"), "the job spools test records");
  assert(
    !job.includes("run-recorded"),
    "the job wraps its command in run-recorded",
  );
  assert(!job.includes("test-records-ship"), "the job ships test records");
  // It runs, and it fails nothing: a landed change that leaves one more
  // line uncovered must not turn the default branch red.
  assertStringIncludes(job, "tasks/coverage-report.ts");
  assertStringIncludes(
    stepBlock(job, "📊 Publish what the run measured"),
    "continue-on-error: true",
  );
});

Deno.test("the CFC Property Suite workflow records no tests", async () => {
  const suite = withoutComments(await workflow("cfc-properties.yml"));
  const relay = withoutComments(await workflow("test-records-relay.yml"));

  // Both of the job's steps fall outside what a record is for, and for the
  // two different reasons `docs/specs/test-records.md` gives under
  // "Recording". The suite step runs `deno test` directly, with no
  // `--junit-path` to ingest and no registration preload, so nothing under
  // it records; a wrapper passes recording through to what it runs, so one
  // here would file a line summarizing the invocation and nothing else.
  // Those tests are units of `workspace-unit` and record when CI runs
  // them. The audit step reads the corpus the step before it wrote, so no
  // lane can be asked to run it. The workflow therefore takes no part in
  // test records at either end: it spools nothing, and the relay does not
  // follow it. Spooling again without the relay produces a run whose
  // records are gathered and never shipped, and the relay assertion is
  // what keeps its follow list honest about which workflows record.
  assert(
    !suite.includes("CF_TEST_RECORDS_DIR"),
    "the workflow spools test records",
  );
  assert(
    !suite.includes("run-recorded"),
    "the workflow wraps a command in run-recorded",
  );
  assert(
    !suite.includes("test-records-ship"),
    "the workflow ships test records",
  );
  const name = suite.match(/^name: (.+)$/m);
  assert(name, "the workflow has no name");
  assertEquals(
    workflowTriggers(relay).includes(name[1]),
    false,
    `the relay follows ${name[1]}, whose records nothing gathers`,
  );

  // Both checks themselves still run.
  const job = jobBlock(suite, "cfc-properties");
  assertStringIncludes(job, "run: deno test -A test/cfc-properties/\n");
  assertStringIncludes(job, "deno task cfc-audit ");
});

Deno.test("One commit publishes one set of release artifacts", async () => {
  // A release artifact is named after the commit it was built from, and the
  // deploy hands the bastion a commit rather than a build. So a commit has one
  // tarball and one checksum for that tarball, and they stay as they were
  // published. Two builds of one commit do not produce the same tarball: the
  // binaries are compiled again, and `tar` records modification times. Publish
  // a second build over a first and a reader can come away holding one build's
  // tarball beside the other build's checksum, which is what the deploy's
  // `sha256sum -c` reports as a failure. docs/development/deploying.md covers
  // the invariant.

  const contents = await workflow("deno.yml");

  // Main can receive the same head commit twice, which starts two runs of that
  // commit. Grouping a push by the commit makes the second run wait for the
  // first, so the two builds never publish at once. Grouping it by anything
  // that differs between runs of one commit, `github.run_id` among them, puts
  // them in separate groups and lets them overlap.
  assertStringIncludes(
    contents,
    "\nconcurrency:\n" +
      "  group: ${{ github.workflow }}-" +
      "${{ github.event.pull_request.number || github.sha }}\n" +
      "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n",
  );

  // Waiting alone leaves the second run free to publish over the first once the
  // first has finished, so the publish itself is what holds the bytes still: a
  // commit that already has both objects keeps them. The pair is published
  // together, in the one branch, because publishing just one of them is how a
  // commit ends up with two builds' halves.
  const upload = stepBlock(
    jobBlock(contents, "attest-binaries"),
    "📤 Upload artifacts to Google Cloud Storage",
  );
  const guard =
    'if gsutil -q stat "$BUCKET/$TARBALL" && gsutil -q stat "$BUCKET/$CHECKSUM"; then';
  const guardStart = upload.indexOf(guard);
  assert(
    guardStart >= 0,
    "the published pair is not looked for before it is published",
  );
  const branchStart = upload.indexOf("\n          else\n", guardStart);
  const branchEnd = upload.indexOf("\n          fi\n", branchStart);
  assert(
    branchStart >= 0 && branchEnd > branchStart,
    "publishing branch not found",
  );
  const branch = upload.slice(branchStart, branchEnd);

  for (const object of ["$TARBALL", "$CHECKSUM"]) {
    const copy = `gsutil cp "release/${object}" "$BUCKET/"`;
    assertStringIncludes(branch, copy);
    assertEquals(
      upload.split(copy).length - 1,
      1,
      `${copy} runs somewhere other than the branch that publishes the pair`,
    );
  }
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

Deno.test("a configured presence URL reaches every shell bundle CI builds", async () => {
  // Both shells CI builds take their co-presence endpoint from a repository
  // variable, and an unset variable is a supported state that builds a working
  // shell. Every check the wiring performs therefore sits inside an
  // `if [ -n "$PRESENCE_URL" ]` that a repository without the variable never
  // enters, so those checks cannot report on the wiring itself: remove the
  // wiring and the same runs stay green. The properties a configured value
  // depends on are checked here instead, against the workflow text, where
  // repository configuration does not get to decide whether the check runs.

  const deno = await workflow("deno.yml");

  // Each job that builds a shell, and the directory its build leaves the
  // bundle in. Both are named so the shell embedded in the toolshed binary and
  // the one published to the bucket are held to a single shape.
  const bundles = new Map([
    ["build-toolshed", "packages/toolshed/shell-frontend/scripts"],
    ["deploy-shell-staging", "dist/scripts"],
  ]);

  // Membership is checked both ways. A job that starts carrying a presence URL
  // without being named above would go unchecked, and a job that stops
  // carrying one is a shell that quietly lost co-presence.
  const carriers = jobIds(deno).filter((id) =>
    jobBlock(deno, id).includes('PRESENCE_URL=$PRESENCE_URL" >> "$GITHUB_ENV"')
  );
  assertEquals(carriers.sort(), [...bundles.keys()].sort());

  for (const [id, bundle] of bundles) {
    const steps = stepBlocks(jobBlock(deno, id));

    const exporter = steps.findIndex((step) =>
      step.body.includes('PRESENCE_URL=$PRESENCE_URL" >> "$GITHUB_ENV"')
    );
    assert(exporter >= 0, `${id}: no step exports PRESENCE_URL`);

    // Read from `vars`, never `secrets`: the value ships inside a bundle any
    // reader can open, so hiding it would cost review and buy nothing.
    assertStringIncludes(steps[exporter].body, "PRESENCE_URL: ${{ vars.");

    // What the bundle carries is `URL.href`, which is not always the spelling
    // the variable holds — a host written without a path gains a trailing
    // slash. Exporting the normalized form is what makes the check below an
    // equality on the value that shipped rather than a prefix match.
    assertStringIncludes(
      steps[exporter].body,
      "packages/shell/src/lib/presence-url.ts",
    );
    assertStringIncludes(steps[exporter].body, "?.href");

    // A configured endpoint that did not reach the bundle is a deployment
    // whose co-presence is off with nothing downstream to notice, so the build
    // is not allowed to pass until the URL is found in what it produced.
    const verifier = steps.findIndex((step) =>
      step.body.includes(`grep -rqF -e "$PRESENCE_URL" ${bundle}`)
    );
    assert(
      verifier >= 0,
      `${id}: nothing greps ${bundle} for the presence URL`,
    );
    assertStringIncludes(
      steps[verifier].body,
      'does not reference $PRESENCE_URL."\n            exit 1\n',
    );

    // GITHUB_ENV reaches the steps after the one that writes it, and not that
    // step itself. An exporter placed after the build it configures would
    // export a value no later step reads, and the guarded check above would
    // then skip on an empty variable instead of failing.
    assert(
      exporter < verifier,
      `${id}: PRESENCE_URL is exported after the build that has to read it`,
    );
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
  assert(shipSteps >= 2, `only ${shipSteps} ship steps found`);
});

Deno.test("the lanes ship records and the workflow knows no suite", async () => {
  // The ship step carries neither a variant nor a JUnit specification,
  // which is the last piece of per-suite knowledge to leave this workflow.
  // A lane may hold default and non-default batches at once, so a job-wide
  // variant could not represent it; the lane runner gathers each batch's
  // records as it finishes and applies that suite's own variant there.
  const contents = withoutComments(await workflow("deno.yml"));
  for (const jobId of ["pr-tests", "full-tests"]) {
    const job = jobBlock(contents, jobId);
    assertStringIncludes(
      job,
      "CF_TEST_RECORDS_DIR:",
      `${jobId}: runs tests without a spool directory`,
    );
    const ship = stepBlock(job, "📤 Ship test records");
    assertStringIncludes(ship, "if: always()");
    assert(!ship.includes("variant:"), `${jobId}: ships a job-wide variant`);
    assert(!ship.includes("junit:"), `${jobId}: names a JUnit output`);
    assert(!ship.includes("shard:"), `${jobId}: names a shard`);
  }
  assert(
    !contents.includes("--junit-path="),
    "deno.yml names a JUnit output; the suite that writes one says where",
  );
});

Deno.test("test-records-ship forwards its optional variant input", async () => {
  const action = await Deno.readTextFile(
    new URL(
      "../.github/actions/test-records-ship/action.yml",
      import.meta.url,
    ),
  );
  assertStringIncludes(action, "  variant:\n");
  assertStringIncludes(action, "SHIP_VARIANT: ${{ inputs.variant }}");
  assertStringIncludes(
    action,
    'RESOLVED_VARIANT="${SHIP_VARIANT:-${CF_TEST_RECORDS_VARIANT:-}}"',
  );
  assertStringIncludes(action, 'args+=(--variant "$RESOLVED_VARIANT")');
});

Deno.test("deno.yml names no test surface", async () => {
  // Adding a test, a kind of test, or a configuration of existing tests is
  // a change to a module under `tasks/test-topology/` and never a change to
  // this workflow. What proves it is that the workflow names none of them:
  // no suite, no shard count, no server-execution arm, no skip list. The
  // topology's own tests hold each of those to what it must be.
  const contents = withoutComments(await workflow("deno.yml"));
  for (
    const named of [
      "EXPERIMENTAL_SERVER_EXECUTION",
      "server-execution-ci-command.ts",
      "server-execution-on-skips.ts",
      "select-pattern-integration-files.ts",
      "select-generated-pattern-files.ts",
      "select-runner-test-files.ts",
      "run-sharded-test-files.ts",
      "TEST_SHARD",
      "TEST_DISABLED_PACKAGES",
      "deno task test",
      "deno task integration",
      "deno task cfcheck",
    ]
  ) {
    assert(
      !contents.includes(named),
      `deno.yml names ${named}, which belongs to the topology`,
    );
  }

  // The two scripts it does run, and nothing else decides what a lane does.
  assertStringIncludes(contents, "tasks/ci-lane.ts");
  assertStringIncludes(contents, "tasks/coverage-gate.ts");
});
