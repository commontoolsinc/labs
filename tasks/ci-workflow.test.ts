import { assert, assertEquals, assertStringIncludes } from "@std/assert";

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

async function workflow(name: string): Promise<string> {
  return await Deno.readTextFile(
    new URL(`../.github/workflows/${name}`, import.meta.url),
  );
}

function workflowTriggers(contents: string): string {
  const triggerEnd = contents.indexOf("\npermissions:");
  if (triggerEnd >= 0) return contents.slice(0, triggerEnd);

  const concurrencyStart = contents.indexOf("\nconcurrency:");
  assert(concurrencyStart >= 0, "workflow trigger section not found");
  return contents.slice(0, concurrencyStart);
}

Deno.test("PR CI waits for every pull request validation job", async () => {
  const contents = await workflow("deno.yml");
  const gate = jobBlock(contents, "pr-ci");
  const pushOnlyJobs = new Set([
    "attest-binaries",
    "deploy-toolshed",
    "deploy-rapids",
    "deploy-shell-staging",
  ]);
  const expected = jobIds(contents).filter((jobId) =>
    jobId !== "pr-ci" && !pushOnlyJobs.has(jobId)
  ).sort();

  assertEquals(neededJobIds(gate).sort(), expected);
  assertStringIncludes(gate, 'name: "PR CI"');
  assertStringIncludes(
    gate,
    "if: ${{ always() && github.event_name == 'pull_request' }}",
  );
  assertStringIncludes(gate, "JOB_RESULTS: ${{ toJSON(needs) }}");
  assertStringIncludes(gate, 'select(.value.result != "success")');
  assertStringIncludes(gate, "permissions: {}");
});

Deno.test("PR CI calls reusable dashboard validation", async () => {
  const deno = await workflow("deno.yml");
  const dashboard = await workflow("dashboard-image.yml");
  const caller = jobBlock(deno, "dashboard");

  assertStringIncludes(caller, 'name: "Dashboard"');
  assertStringIncludes(
    caller,
    "if: ${{ github.event_name == 'pull_request' }}",
  );
  assertStringIncludes(
    caller,
    "uses: ./.github/workflows/dashboard-image.yml",
  );
  assertStringIncludes(
    caller,
    "permissions:\n      contents: read\n      id-token: write",
  );
  assertStringIncludes(
    dashboard,
    "\npermissions:\n  contents: read\n\nconcurrency:\n",
  );
  assertEquals(
    neededJobIds(jobBlock(deno, "pr-ci")).includes("dashboard"),
    true,
  );

  const denoTriggers = workflowTriggers(deno);
  assertStringIncludes(denoTriggers, "  pull_request:\n");
  assertEquals(denoTriggers.includes("\n    paths:"), false);

  const dashboardTriggers = workflowTriggers(dashboard);
  assertStringIncludes(dashboardTriggers, "  workflow_call:\n");
  assertStringIncludes(
    dashboardTriggers,
    "  push:\n    branches: [main]\n    paths:\n",
  );
  assertEquals(dashboardTriggers.includes("  pull_request:\n"), false);
  assertStringIncludes(
    dashboard,
    "group: dashboard-image-${{ github.event.pull_request.number || github.ref }}",
  );
});

Deno.test("Dashboard CI verifies every reusable workflow job", async () => {
  const contents = await workflow("dashboard-image.yml");
  assertEquals(jobIds(contents).includes("dashboard_scope"), false);

  const gate = jobBlock(contents, "dashboard_ci");
  const expected = jobIds(contents).filter((jobId) => jobId !== "dashboard_ci")
    .sort();
  assertEquals(neededJobIds(gate).sort(), expected);
  for (const jobId of expected) {
    assertStringIncludes(gate, `needs.${jobId}.result`);
  }
  assertStringIncludes(gate, "name: Dashboard CI");
  assertStringIncludes(gate, "if: ${{ always() }}");
  assertStringIncludes(
    gate,
    "needs.publish_authorization.outputs.allowed",
  );
  assertStringIncludes(gate, 'TEST_RESULT" == "success"');
  assertStringIncludes(gate, 'BUILD_RESULT" == "success"');
  assertStringIncludes(gate, 'AUTHORIZATION_RESULT" == "success"');
  assertStringIncludes(gate, 'PUBLISH_ALLOWED" == "true"');
  assertStringIncludes(gate, 'PUBLISH_ALLOWED" == "false"');
  assertStringIncludes(gate, "permissions: {}");
});

Deno.test("called dashboard validation always runs", async () => {
  const contents = await workflow("dashboard-image.yml");

  for (const jobId of ["dashboard_tests", "dashboard_build"]) {
    const validation = jobBlock(contents, jobId);
    assertEquals(validation.includes("\n    needs:"), false);
    assertEquals(validation.includes("\n    if:"), false);
  }

  const authorization = jobBlock(contents, "publish_authorization");
  assertStringIncludes(
    authorization,
    "needs: [dashboard_tests, dashboard_build]",
  );
  assertStringIncludes(authorization, "if: ${{ !cancelled() }}");
  assertStringIncludes(authorization, "ACTOR_ID: ${{ github.actor_id }}");
  assertStringIncludes(
    authorization,
    'if [[ ",${PUBLISHER_ACTOR_IDS}," == *",${ACTOR_ID},"* ]]; then',
  );
  assertStringIncludes(
    authorization,
    'if [[ "$BUILD_RESULT" == "success" ]]; then',
  );
  assertStringIncludes(
    authorization,
    'elif [[ "$GITHUB_EVENT_NAME" == "pull_request" && "$member" == "true" ]]; then',
  );
  assertStringIncludes(
    authorization,
    'if [[ "$TEST_RESULT" == "success" || ("$PUSH_BRANCH" == "true" && "$RUN_ATTEMPT" -gt 1) ]]; then',
  );

  const publish = jobBlock(contents, "publish");
  assertStringIncludes(
    publish,
    "needs: [dashboard_tests, dashboard_build, publish_authorization]",
  );
  assertStringIncludes(
    publish,
    "!cancelled() && needs.publish_authorization.outputs.allowed == 'true'",
  );
  assertStringIncludes(
    publish,
    "permissions:\n      contents: read\n      id-token: write",
  );

  for (
    const jobId of [
      "dashboard_tests",
      "dashboard_build",
      "publish_authorization",
      "dashboard_ci",
    ]
  ) {
    assertEquals(jobBlock(contents, jobId).includes("id-token: write"), false);
  }
});
