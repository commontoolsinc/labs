// common.tools uptime tile: a synthetic HTTP check, exercised with a stubbed
// fetch and a hand-made Ctx. No network.
//
// The tile keeps a consecutive-failure counter across collect() calls, and the
// module holds it for the life of the process. Each test that cares about the
// counter starts from a reachable check, which resets it to zero.
import { assert, assertEquals } from "@std/assert";
import type { Ctx } from "../types.ts";
import { commonToolsUp } from "./common-tools-up.ts";

function ctx(env: Record<string, string> = {}): Ctx {
  return {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: (k) => env[k],
  };
}

// Runs fn with fetch replaced. `reply` gets the requested url and returns the
// response, or throws to stand for an unreachable site. Records every url asked for.
async function withFetch<T>(
  reply: (url: string) => Response,
  fn: (urls: string[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (input: string | URL | Request) => {
    urls.push(String(input));
    return Promise.resolve(reply(String(input)));
  };
  try {
    return await fn(urls);
  } finally {
    globalThis.fetch = original;
  }
}

const ok = (status: number) => () => new Response(null, { status });
const unreachable = () => {
  throw new TypeError("error sending request");
};

// Makes Date.now() report the given elapsed span across the two readings the
// tile takes around fetch.
async function withElapsed<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const original = Date.now;
  const t0 = original();
  let call = 0;
  Date.now = () => (call++ === 0 ? t0 : t0 + ms);
  try {
    return await fn();
  } finally {
    Date.now = original;
  }
}

Deno.test("common.tools: a prompt 200 -> good, headlining the round-trip time", async () => {
  const v = await withFetch(ok(200), () => withElapsed(120, () => commonToolsUp.collect(ctx())));
  assertEquals(v.label, "common.tools");
  assertEquals(v.status, "good");
  assertEquals(v.value, "120 ms");
  assertEquals(v.sub, "HTTP 200 · common.tools");
  assertEquals(v.href, "https://common.tools/");
  assertEquals(v.hint, "open ↗");
});

Deno.test("common.tools: a redirect is not followed and still reads as good", async () => {
  // redirect: "manual" means the 301 is the answer, not a hop to chase.
  const v = await withFetch(ok(301), () => withElapsed(80, () => commonToolsUp.collect(ctx())));
  assertEquals(v.status, "good");
  assertEquals(v.sub, "HTTP 301 · common.tools");
  assertEquals(v.value, "80 ms");
});

Deno.test("common.tools: a slow but healthy answer -> warn, still showing the time", async () => {
  const v = await withFetch(ok(200), () => withElapsed(2501, () => commonToolsUp.collect(ctx())));
  assertEquals(v.status, "warn");
  assertEquals(v.value, "2501 ms");
  // 2500 ms exactly is still inside the budget.
  const edge = await withFetch(ok(200), () => withElapsed(2500, () => commonToolsUp.collect(ctx())));
  assertEquals(edge.status, "good");
});

Deno.test("common.tools: a 4xx -> warn (the site answered, just not with the page)", async () => {
  const v = await withFetch(ok(404), () => withElapsed(30, () => commonToolsUp.collect(ctx())));
  assertEquals(v.status, "warn");
  assertEquals(v.value, "30 ms"); // not "erroring" — only 5xx claims that
  assertEquals(v.sub, "HTTP 404 · common.tools");
});

Deno.test("common.tools: a 5xx -> bad immediately, headlined as erroring", async () => {
  const v = await withFetch(ok(503), () => withElapsed(15, () => commonToolsUp.collect(ctx())));
  assertEquals(v.status, "bad");
  assertEquals(v.value, "erroring");
  assertEquals(v.sub, "HTTP 503 · common.tools");
});

Deno.test("common.tools: one unreachable check -> gray, never red", async () => {
  await withFetch(ok(200), () => commonToolsUp.collect(ctx())); // reachable: clears the counter
  const v = await withFetch(unreachable, () => commonToolsUp.collect(ctx()));
  assertEquals(v.status, "unknown");
  assertEquals(v.value, "—");
  assertEquals(v.sub, "unreachable · common.tools");
  assertEquals(v.href, "https://common.tools/");
});

Deno.test("common.tools: only a sustained run of failures escalates to down", async () => {
  await withFetch(ok(200), () => commonToolsUp.collect(ctx())); // reachable: clears the counter
  const statuses: string[] = [];
  for (let i = 0; i < 3; i++) {
    statuses.push((await withFetch(unreachable, () => commonToolsUp.collect(ctx()))).status);
  }
  assertEquals(statuses, ["unknown", "unknown", "bad"]);
  const down = await withFetch(unreachable, () => commonToolsUp.collect(ctx()));
  assertEquals(down.value, "down");
  assertEquals(down.sub, "unreachable · common.tools");
});

Deno.test("common.tools: a reachable check resets the outage run", async () => {
  // Two failures, then a success, then a failure: the run restarts rather than
  // carrying the earlier two over the threshold.
  await withFetch(ok(200), () => commonToolsUp.collect(ctx()));
  await withFetch(unreachable, () => commonToolsUp.collect(ctx()));
  await withFetch(unreachable, () => commonToolsUp.collect(ctx()));
  const back = await withFetch(ok(200), () => withElapsed(40, () => commonToolsUp.collect(ctx())));
  assertEquals(back.status, "good");
  const v = await withFetch(unreachable, () => commonToolsUp.collect(ctx()));
  assertEquals(v.status, "unknown", "the counter restarted from zero");
});

Deno.test("common.tools: COMMON_TOOLS_URL retargets the check and the host in the sub", async () => {
  const env = { COMMON_TOOLS_URL: "https://www.common.tools/health" };
  const v = await withFetch(ok(200), (urls) =>
    withElapsed(60, async () => {
      const view = await commonToolsUp.collect(ctx(env));
      assertEquals(urls, ["https://www.common.tools/health"]);
      return view;
    }));
  assertEquals(v.sub, "HTTP 200 · www.common.tools");
  assertEquals(v.href, "https://www.common.tools/health");
});

Deno.test("common.tools: the tile is registered with a positive interval", () => {
  assertEquals(commonToolsUp.id, "common-tools-up");
  assert(commonToolsUp.intervalMs > 0);
});
