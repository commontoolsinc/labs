// Ctx tests: makeCtx() builds the memoized data sources every tile reads. The
// GitHub API is stubbed with a canned runs response, so these pin the paging,
// the age cutoff, the cap, and the caching without a network.
import { assert, assertEquals } from "@std/assert";
import { makeCtx } from "./ctx.ts";
import { CI_RUNS_MAX, CI_RUNS_MAX_AGE_DAYS, CI_WORKFLOW, LOOM_CI_WORKFLOW, LOOM_REPO, REPO } from "./config.ts";
import type { Ctx, Run } from "./types.ts";

function run(over: Partial<Run> = {}): Run {
  return {
    id: 1,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    event: "push",
    head_sha: "sha",
    display_title: "t",
    run_started_at: new Date(Date.now() - 3_600_000).toISOString(),
    updated_at: new Date().toISOString(),
    html_url: "",
    head_commit: { message: "t (#1)" },
    ...over,
  };
}

const runs = (n: number, from = 1) => Array.from({ length: n }, (_, i) => run({ id: from + i }));

const pageOf = (url: string) => Number(new URL(url).searchParams.get("page"));

// Run `body` against a stubbed GitHub API. `reply` answers each request with the
// workflow_runs for that url; `urls` collects every url asked for, so a test can
// count the fetches. The real fetch and GH_TOKEN are restored afterwards, since
// other test files share this process.
async function withGithub(
  reply: (url: string) => Run[],
  body: (ctx: Ctx, urls: string[]) => Promise<void>,
): Promise<void> {
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  const realToken = Deno.env.get("GH_TOKEN");
  Deno.env.set("GH_TOKEN", "test-token");
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify({ workflow_runs: reply(url) }), { headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch;
  try {
    await body(makeCtx(), urls);
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) Deno.env.delete("GH_TOKEN");
    else Deno.env.set("GH_TOKEN", realToken);
  }
}

Deno.test("runs(): labs main-branch runs of the CI workflow, each tagged with its repo", async () => {
  await withGithub((url) => (pageOf(url) === 1 ? runs(2) : []), async (ctx, urls) => {
    const out = await ctx.runs();
    assertEquals(urls[0], `https://api.github.com/repos/${REPO}/actions/workflows/${CI_WORKFLOW}/runs?branch=main&per_page=100&page=1`);
    assertEquals(out.map((r) => r.id), [1, 2]);
    // A combined stream needs to know which repo a row came from; nothing in the
    // API response carries it, so the fetcher tags each run.
    assertEquals(out.map((r) => r.repo), [REPO, REPO]);
  });
});

Deno.test("runs(): a second read within the TTL is served from the cache, not refetched", async () => {
  await withGithub((url) => (pageOf(url) === 1 ? runs(2) : []), async (ctx, urls) => {
    const first = await ctx.runs();
    const second = await ctx.runs();
    // Two pages walked once — the second read added no requests.
    assertEquals(urls.length, 2);
    assertEquals(second, first);
    // runsFor with the same repo and workflow is the same source, so it shares it.
    assertEquals(await ctx.runsFor(REPO, CI_WORKFLOW), first);
    assertEquals(urls.length, 2);
  });
});

Deno.test("runsFor: each repo and workflow is cached separately", async () => {
  await withGithub((url) => {
    if (pageOf(url) !== 1) return [];
    return url.includes(LOOM_REPO) ? [run({ id: 77 })] : [run({ id: 11 })];
  }, async (ctx, urls) => {
    const labs = await ctx.runsFor(REPO, CI_WORKFLOW);
    const loom = await ctx.runsFor(LOOM_REPO, LOOM_CI_WORKFLOW);
    // A second repo must not be handed the first repo's cached runs.
    assertEquals(labs.map((r) => r.id), [11]);
    assertEquals(loom.map((r) => r.id), [77]);
    assertEquals(loom[0].repo, LOOM_REPO);
    assert(urls.some((u) => u.includes(`repos/${LOOM_REPO}/actions/workflows/${LOOM_CI_WORKFLOW}/runs`)), urls.join(" "));
    // Four requests: two pages each. Loom re-read is then cached under its own key.
    assertEquals(urls.length, 4);
    await ctx.runsFor(LOOM_REPO, LOOM_CI_WORKFLOW);
    assertEquals(urls.length, 4);
  });
});

Deno.test("runs(): pages accumulate in order until a page comes back empty", async () => {
  await withGithub((url) => (pageOf(url) === 1 ? runs(100) : runs(3, 101)), async (ctx, urls) => {
    const out = await ctx.runs();
    assertEquals(out.length, 103);
    assertEquals(out[100].id, 101); // page 2 follows page 1, newest-first order kept
    assertEquals(urls.map(pageOf), [1, 2]);
  });
});

Deno.test("runs(): an empty first page stops the walk rather than asking for the next", async () => {
  await withGithub(() => [], async (ctx, urls) => {
    assertEquals(await ctx.runs(), []);
    assertEquals(urls.length, 1);
  });
});

Deno.test("runs(): the stream is capped at CI_RUNS_MAX, mid-page if need be", async () => {
  // The stub over-serves: one page holds more than the cap.
  await withGithub((url) => (pageOf(url) === 1 ? runs(CI_RUNS_MAX + 50) : []), async (ctx, urls) => {
    const out = await ctx.runs();
    assertEquals(out.length, CI_RUNS_MAX);
    assertEquals(out[out.length - 1].id, CI_RUNS_MAX); // truncated at the cap, not at the page end
    assertEquals(urls.length, 1); // and no further page is asked for
  });
});

Deno.test("runs(): a run past the age cutoff ends the stream", async () => {
  const day = 86_400_000;
  const at = (id: number, daysAgo: number) =>
    run({ id, run_started_at: new Date(Date.now() - daysAgo * day).toISOString() });
  await withGithub((url) =>
    pageOf(url) === 1
      ? [at(1, 1), at(2, CI_RUNS_MAX_AGE_DAYS + 1), at(3, CI_RUNS_MAX_AGE_DAYS + 2)]
      : [], async (ctx, urls) => {
    const out = await ctx.runs();
    // Runs arrive newest-first, so the first one past the cutoff and everything
    // behind it are dropped.
    assertEquals(out.map((r) => r.id), [1]);
    assertEquals(urls.length, 1);
  });
});

Deno.test("runs(): a run with an unreadable start time is kept, not read as ancient", async () => {
  await withGithub((url) =>
    pageOf(url) === 1 ? [run({ id: 1, run_started_at: "" }), run({ id: 2 })] : [], async (ctx) => {
    assertEquals((await ctx.runs()).map((r) => r.id), [1, 2]);
  });
});

Deno.test("runs(): a response without workflow_runs reads as no runs", async () => {
  const realFetch = globalThis.fetch;
  const realToken = Deno.env.get("GH_TOKEN");
  Deno.env.set("GH_TOKEN", "test-token");
  globalThis.fetch = (() => Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" } }))) as typeof fetch;
  try {
    assertEquals(await makeCtx().runs(), []);
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) Deno.env.delete("GH_TOKEN");
    else Deno.env.set("GH_TOKEN", realToken);
  }
});

Deno.test("env(): reads the process environment, undefined when unset", () => {
  const key = "DASHBOARD_CTX_TEST_KEY";
  const ctx = makeCtx();
  Deno.env.set(key, "set-by-the-test");
  try {
    assertEquals(ctx.env(key), "set-by-the-test");
  } finally {
    Deno.env.delete(key);
  }
  assertEquals(ctx.env(key), undefined);
});
