import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type CachedCiHistoryRefresh,
  type CachedCiRun,
  CI_JOB_CACHE_DAYS,
  CiJobHistoryStore,
} from "./ci-job-cache.ts";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 6, 20);
const REPO = "owner/repo";
const WORKFLOW = "ci.yml";

function cachedRun(
  runId: number,
  runAttempt = 1,
  at = NOW,
  repo = REPO,
  workflow = WORKFLOW,
): CachedCiRun {
  const startedAt = new Date(at).toISOString();
  const completedAt = new Date(at + 60_000).toISOString();
  return {
    repo,
    workflow,
    runId,
    runAttempt,
    runUrl: `https://github.com/${repo}/actions/runs/${runId}`,
    at,
    overallSeconds: 60,
    jobs: [{ name: "test", seconds: 60 }],
    gantt: {
      status: "completed",
      conclusion: "success",
      event: "push",
      headBranch: "main",
      workflowName: "CI",
      startedAt,
      jobs: [{
        name: "test",
        status: "completed",
        conclusion: "success",
        started_at: startedAt,
        completed_at: completedAt,
        steps: [{
          name: "run",
          number: 1,
          conclusion: "success",
          started_at: startedAt,
          completed_at: completedAt,
        }],
      }],
    },
  };
}

Deno.test("CI job cache rejects malformed persisted structures before merging", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const valid = cachedRun(1);
  const invalidStep = structuredClone(valid);
  invalidStep.gantt.jobs[0].steps = [null] as never;
  const invalidJob = structuredClone(valid);
  invalidJob.gantt.jobs = [null] as never;
  const invalidGantt = { ...valid, gantt: null };
  const invalidSha = { ...valid, headSha: "not-a-commit" };
  const cases: { value: unknown; message: string }[] = [
    { value: null, message: "Invalid CI job history cache" },
    {
      value: { version: 2, runs: [] },
      message: "Unsupported CI job history cache format",
    },
    {
      value: { version: 1, runs: [null] },
      message: "Invalid CI job history cache entry",
    },
    {
      value: { version: 1, runs: [invalidGantt] },
      message: "Invalid CI job history cache entry",
    },
    {
      value: { version: 1, runs: [invalidJob] },
      message: "Invalid CI job history cache entry",
    },
    {
      value: { version: 1, runs: [invalidStep] },
      message: "Invalid CI job history cache entry",
    },
    {
      value: { version: 1, runs: [invalidSha] },
      message: "Invalid CI job history cache entry",
    },
    {
      value: { version: 1, runs: [], refreshes: {} },
      message: "Invalid CI job history refresh entry",
    },
    {
      value: { version: 1, runs: [], refreshes: [null] },
      message: "Invalid CI job history refresh entry",
    },
    {
      value: { version: 1, runs: [], invalidations: {} },
      message: "Invalid CI job history refresh invalidation",
    },
    {
      value: { version: 1, runs: [], invalidations: [null] },
      message: "Invalid CI job history refresh invalidation",
    },
    {
      value: {
        version: 1,
        runs: [],
        refreshes: [{
          repo: REPO,
          workflow: WORKFLOW,
          days: 7,
          refreshedAt: NOW,
          successfulRunTimes: [NOW],
          sampledRuns: [{ runId: 999, runAttempt: 1 }],
          failedRunCount: 0,
          failedRunTimes: [],
          stale: false,
        }],
      },
      message: "references a missing run",
    },
  ];

  try {
    for (const [index, testCase] of cases.entries()) {
      const file = `${directory}/${index}.json`;
      await Deno.writeTextFile(file, JSON.stringify(testCase.value));
      const store = new CiJobHistoryStore(file);
      await store.load();
      store.set(cachedRun(100 + index));
      await assertRejects(() => store.save(NOW), Error, testCase.message);
    }

    const file = `${directory}/future-strict.json`;
    const store = new CiJobHistoryStore(file);
    await store.load();
    store.set(cachedRun(200));
    const future = Date.now() + DAY_MS;
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        version: 1,
        runs: [],
        invalidations: [{
          repo: REPO,
          workflow: WORKFLOW,
          days: 7,
          invalidatedAt: future,
        }],
      }),
    );
    await assertRejects(
      () => store.save(NOW),
      Error,
      "Invalid CI job history refresh invalidation",
    );

    const malformedFile = `${directory}/malformed.json`;
    await Deno.writeTextFile(malformedFile, "{not json");
    const malformedStore = new CiJobHistoryStore(malformedFile);
    await malformedStore.load();
    malformedStore.set(cachedRun(201));
    await assertRejects(() => malformedStore.save(NOW), SyntaxError);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job cache records a validated commit on an exact run attempt", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  try {
    const store = new CiJobHistoryStore(`${directory}/history.json`);
    await store.load();
    const run = store.set(cachedRun(250));
    const revision = store.revision;
    assertEquals(store.setHeadSha(REPO, WORKFLOW, 999, 1, "a".repeat(40)), undefined);
    const tagged = store.setHeadSha(
      REPO,
      WORKFLOW,
      run.runId,
      run.runAttempt,
      "A".repeat(40),
    );
    assertEquals(tagged, { ...run, headSha: "a".repeat(40) });
    assertEquals(store.revision, revision + 1);
    assertEquals(
      store.setHeadSha(
        REPO,
        WORKFLOW,
        run.runId,
        run.runAttempt,
        "a".repeat(40),
      ),
      tagged,
    );
    assertEquals(store.revision, revision + 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job cache quarantines future persisted refresh state", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const file = `${directory}/history.json`;
  const run = cachedRun(301);
  const observedNow = Date.now();
  const future = observedNow + DAY_MS;
  try {
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        version: 1,
        runs: [run],
        refreshes: [{
          repo: REPO,
          workflow: WORKFLOW,
          days: 7,
          refreshedAt: future,
          successfulRunTimes: [NOW],
          sampledRuns: [{ runId: run.runId, runAttempt: run.runAttempt }],
          failedRunCount: 0,
          failedRunTimes: [],
          stale: false,
        }],
        invalidations: [{
          repo: REPO,
          workflow: WORKFLOW,
          days: 7,
          invalidatedAt: future,
        }],
      }),
    );

    const store = new CiJobHistoryStore(file);
    await store.load();
    assertEquals(store.refresh(REPO, WORKFLOW, 7), undefined);
    assertEquals(
      store.quarantineFutureRefresh(REPO, WORKFLOW, 7, observedNow),
      true,
    );
    await store.save(observedNow);
    const persisted = JSON.parse(await Deno.readTextFile(file));
    assertEquals(persisted.refreshes, []);
    assertEquals(persisted.invalidations, []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job cache validates refresh changes and isolates source revisions", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const file = `${directory}/history.json`;
  const now = Date.now;
  Date.now = () => NOW;
  try {
    const store = new CiJobHistoryStore(file);
    await store.load();
    const first = store.set(cachedRun(401));
    assertEquals(store.set(first), first);
    const second = store.set(cachedRun(401, 2));
    store.set(cachedRun(402, 1, NOW, "other/repo"));
    store.set(cachedRun(403, 1, NOW, REPO, "other.yml"));
    assertEquals(store.get(REPO, WORKFLOW, 401, 1), first);
    assertEquals(store.latest(REPO, WORKFLOW, 401), second);
    assertEquals(store.list(REPO, WORKFLOW).map((run) => run.runId), [401]);
    assertEquals(store.list(REPO, WORKFLOW, NOW + 1), []);

    store.markRefreshed(
      REPO,
      WORKFLOW,
      7,
      Number.NaN,
      [],
      [],
      0,
      [],
      false,
    );
    assertThrows(
      () => {
        store.markRefreshed(REPO, WORKFLOW, 7, NOW, [], [], -1, [], false);
      },
      Error,
      "invalid failure count",
    );
    assertThrows(
      () => {
        store.markRefreshed(
          REPO,
          WORKFLOW,
          7,
          NOW,
          [],
          [{ runId: 999, runAttempt: 1 }],
          0,
          [],
          false,
        );
      },
      Error,
      "contains an uncached run",
    );

    store.markRefreshed(
      REPO,
      WORKFLOW,
      7,
      NOW,
      [Number.NaN, NOW, NOW - 1],
      [{ runId: 401, runAttempt: 2 }],
      2,
      [Number.NaN, NOW - 2],
      true,
    );
    const refresh = store.refresh(REPO, WORKFLOW, 7)!;
    assertEquals(refresh.successfulRunTimes, [NOW - 1, NOW]);
    assertEquals(refresh.failedRunTimes, [NOW - 2]);
    store.markRefreshed(
      REPO,
      WORKFLOW,
      7,
      NOW - 1,
      [],
      [],
      0,
      [],
      false,
    );
    assertEquals(store.refresh(REPO, WORKFLOW, 7), refresh);
    assertEquals(store.refreshedRuns(REPO, WORKFLOW, 7)?.[0], second);

    const superseded = store.set(cachedRun(404, 1));
    store.markRefreshed(
      REPO,
      WORKFLOW,
      8,
      NOW,
      [NOW],
      [{ runId: superseded.runId, runAttempt: superseded.runAttempt }],
      0,
      [],
      false,
    );
    store.set(cachedRun(404, 2));
    assertEquals(store.freshRefresh(REPO, WORKFLOW, 8), undefined);

    store.restoreRefresh(REPO, WORKFLOW, 7, undefined);
    assertEquals(store.refresh(REPO, WORKFLOW, 7), undefined);
    store.restoreRefresh(REPO, WORKFLOW, 7, refresh);
    assertEquals(store.refresh(REPO, WORKFLOW, 7), refresh);
    store.invalidateRefresh(REPO, WORKFLOW, 7);
    const revision = store.revision;
    store.invalidateRefresh(REPO, WORKFLOW, 7);
    assertEquals(store.revision, revision);
    assertEquals(store.freshRefresh(REPO, WORKFLOW, 7), undefined);

    const futureRefresh: CachedCiHistoryRefresh = {
      ...refresh,
      refreshedAt: NOW + 2 * DAY_MS,
    };
    store.restoreRefresh(REPO, WORKFLOW, 7, futureRefresh);
    Date.now = () => NOW + 2 * DAY_MS;
    store.invalidateRefresh(REPO, WORKFLOW, 7);
    assertEquals(store.quarantineFutureRefresh(REPO, WORKFLOW, 7, NOW), true);
    assertEquals(store.revisionFor(REPO, WORKFLOW) > 0, true);
    await store.save(NOW);
    await store.save(NOW);
  } finally {
    Date.now = now;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job cache drops a refresh whose retained run is pruned", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const file = `${directory}/history.json`;
  try {
    const store = new CiJobHistoryStore(file);
    await store.load();
    const old = store.set(cachedRun(
      501,
      1,
      NOW - (CI_JOB_CACHE_DAYS + 1) * DAY_MS,
    ));
    store.markRefreshed(
      REPO,
      WORKFLOW,
      7,
      NOW - DAY_MS,
      [old.at],
      [{ runId: old.runId, runAttempt: old.runAttempt }],
      0,
      [],
      false,
    );
    const revision = store.revisionFor(REPO, WORKFLOW);
    await store.save(NOW);
    assertEquals(store.refresh(REPO, WORKFLOW, 7), undefined);
    assertEquals(store.revisionFor(REPO, WORKFLOW), revision + 1);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job cache removes a temporary file after rename fails", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const file = `${directory}/history.json`;
  const rename = Deno.rename;
  try {
    const store = new CiJobHistoryStore(file);
    await store.load();
    store.set(cachedRun(601));
    Deno.rename = (() =>
      Promise.reject(new Error("rename failed"))) as typeof Deno.rename;
    await assertRejects(() => store.save(NOW), Error, "rename failed");
    assertEquals(
      [...Deno.readDirSync(directory)].some((entry) =>
        entry.name.endsWith(".tmp")
      ),
      false,
    );
  } finally {
    Deno.rename = rename;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CI job cache preserves a write error when temporary cleanup fails", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ci-job-cache-" });
  const file = `${directory}/history.json`;
  const rename = Deno.rename;
  const remove = Deno.remove;
  try {
    const store = new CiJobHistoryStore(file);
    await store.load();
    store.set(cachedRun(602));
    Deno.rename = (() =>
      Promise.reject(new Error("rename failed"))) as typeof Deno.rename;
    Deno.remove = ((path, options) =>
      String(path).endsWith(".tmp")
        ? Promise.reject(new Error("remove failed"))
        : remove(path, options)) as typeof Deno.remove;
    await assertRejects(
      () =>
        store.save(NOW),
      Error,
      "rename failed",
    );
  } finally {
    Deno.rename = rename;
    Deno.remove = remove;
    await Deno.remove(directory, { recursive: true });
  }
});
