import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  sampleEntry,
  sampleManifest,
  serializeManifest,
} from "@commonfabric/test-support/records";

import {
  FLAKE_WINDOW_FALLBACK_DAYS,
  generatedAtOf,
  LANE_BUDGET_FALLBACK_SECONDS,
  laneBudgetOf,
  type ManifestReader,
  newestManifest,
} from "./test-selection-manifest.ts";
import { makeTestFlakes } from "./tiles/test-flakes.ts";
import { makeTestSelection } from "./tiles/test-selection.ts";
import { TEST_SELECTION_PATH } from "./test-selection-page.ts";
import type { Ctx } from "./types.ts";

const PREFIX = "labs/test-selection/v1";

/**
 * A store answering one listing and the objects it named. Bodies are the
 * text a real fetch delivers: the store serves with transcoding, so the
 * gzip an object is stored under is already decoded by the time a reader
 * sees it.
 */
function storeOf(objects: Record<string, string>): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/o")) {
      const items = Object.keys(objects).map((name) => ({ name }));
      return Promise.resolve(new Response(JSON.stringify({ items }), { status: 200 }));
    }
    const name = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    const body = objects[name];
    return Promise.resolve(
      body === undefined
        ? new Response("", { status: 404 })
        : new Response(body as BodyInit, { status: 200 }),
    );
  }) as typeof fetch;
}

Deno.test("generatedAtOf reads the time out of a manifest's name", () => {
  assertEquals(
    generatedAtOf(`${PREFIX}/manifest-2026-08-20T04:00:00.000Z-a.json.gz`),
    "2026-08-20T04:00:00.000Z",
  );
  assertEquals(generatedAtOf(`${PREFIX}/state/2026-08-20-a.json.gz`), undefined);
});

Deno.test("newestManifest takes the newest object under the prefix", async () => {
  const older = sampleManifest({ generatedAt: "2026-08-20T00:00:00.000Z" });
  const newer = sampleManifest({ generatedAt: "2026-08-20T04:00:00.000Z" });
  const found = await newestManifest({
    fetchImpl: storeOf({
      [`${PREFIX}/manifest-2026-08-20T00:00:00.000Z-a.json.gz`]:
        serializeManifest(older),
      [`${PREFIX}/manifest-2026-08-20T04:00:00.000Z-b.json.gz`]:
        serializeManifest(newer),
    }),
  });
  assertEquals(found?.generatedAt, "2026-08-20T04:00:00.000Z");
});

Deno.test("newestManifest reports a body that is not a manifest", async () => {
  await assertRejects(
    () =>
      newestManifest({
        fetchImpl: storeOf({
          [`${PREFIX}/manifest-2026-08-20T04:00:00.000Z-b.json.gz`]:
            "{not a manifest",
        }),
      }),
    Error,
    "not a manifest",
  );
});

Deno.test("newestManifest reports nothing when the store holds none", async () => {
  assertEquals(await newestManifest({ fetchImpl: storeOf({}) }), undefined);
});

/**
 * A store that lists one manifest and then answers for the object
 * itself however the caller says. The listing has to succeed for the
 * reader to reach the object at all.
 */
function storeRefusing(answer: () => Promise<Response>): typeof fetch {
  const name = `${PREFIX}/manifest-2026-08-20T04:00:00.000Z-a.json.gz`;
  return ((input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/o")) {
      return Promise.resolve(
        new Response(JSON.stringify({ items: [{ name }] }), { status: 200 }),
      );
    }
    return answer();
  }) as typeof fetch;
}

Deno.test("newestManifest reports a refused manifest", async () => {
  // Listed but not readable, which is what a manifest deleted between
  // the listing and the read looks like.
  for (const status of [403, 404, 500]) {
    await assertRejects(
      () =>
        newestManifest({
          fetchImpl: storeRefusing(() =>
            Promise.resolve(new Response("", { status }))
          ),
        }),
      Error,
      `HTTP ${status}`,
    );
  }
});

Deno.test("newestManifest reports a failed read", async () => {
  await assertRejects(
    () =>
      newestManifest({
        fetchImpl: storeRefusing(() => Promise.reject(new Error("no network"))),
      }),
    Error,
    "no network",
  );
});

Deno.test("newestManifest reports an unreachable store", async () => {
  await assertRejects(
    () =>
      newestManifest({
        fetchImpl: (() =>
          Promise.reject(new Error("no network"))) as typeof fetch,
      }),
    Error,
    "no network",
  );
});

const CTX: Ctx = {
  runs: () => Promise.resolve([]),
  runsFor: () => Promise.resolve([]),
  env: () => undefined,
};

/** A reader over a store holding one manifest under a fixed name. */
function reading(
  manifest: Parameters<typeof serializeManifest>[0],
): ManifestReader {
  const fetchImpl = storeOf({
    [`${PREFIX}/manifest-2026-08-20T04:00:00.000Z-a.json.gz`]:
      serializeManifest(manifest),
  });
  return () => newestManifest({ fetchImpl });
}

Deno.test("both test tiles are unknown when there is no manifest", async () => {
  const empty: ManifestReader = () => Promise.resolve(undefined);
  for (
    const tile of [
      makeTestFlakes({ read: empty }),
      makeTestSelection({ read: empty }),
    ]
  ) {
    const view = await tile.collect(CTX);
    assertEquals(view.status, "unknown");
    assertEquals(view.sub, "no selection manifest yet");
  }
});

Deno.test("the flake tile is green when nothing is withheld as flaky", async () => {
  const tile = makeTestFlakes({
    read: reading(sampleManifest()),
    now: () => Date.parse("2026-08-20T00:30:00.000Z"),
  });
  const view = await tile.collect(CTX);
  assertEquals(view.status, "good");
  assertEquals(view.value, "no flaky tests");
  // What the conclusion was drawn from: the window the share is measured
  // over, and how long ago the publisher measured it.
  assertEquals(view.sub, `${FLAKE_WINDOW_FALLBACK_DAYS} days of runs · 30m old`);
});

Deno.test("the flake tile counts what selection held back, and points at them", async () => {
  const longName = "space > flakes with a name that keeps going past the tile limit";
  const noisy = sampleEntry({ k: "unit", s: "memory", n: longName, v: "worker" }, {
    flakeRate: 0.4,
  });
  const manifest = sampleManifest({
    entries: [noisy],
    withheld: [{ test: noisy.test, suite: noisy.suite, reason: "flaky" }],
  });
  const view = await makeTestFlakes({
    read: reading(manifest),
    now: () => Date.parse("2026-08-20T04:00:00.000Z"),
  }).collect(CTX);
  assertEquals(view.status, "warn");
  assertEquals(view.value, "1 flaky test");
  assertEquals(view.sub, `${FLAKE_WINDOW_FALLBACK_DAYS} days of runs · 4h old`);
  // The count is the whole tile: no name reaches it to be cut in half.
  assertEquals(view.extra, undefined);
  assertEquals(view.href, "/test-selection#flaky");
  assertEquals(view.hint, "flakes ↗");
});

Deno.test("the selection tile says what share of the corpus would run", async () => {
  const entry = sampleEntry({ k: "unit", s: "memory", n: "a" }, { cost: 3 });
  const other = sampleEntry({ k: "unit", s: "memory", n: "b" }, { cost: 1 });
  const manifest = sampleManifest({
    entries: [entry, other],
    lanes: [{
      lane: 1,
      projectedSeconds: 3,
      batches: [{
        suite: entry.suite,
        identities: [JSON.stringify(entry.test)],
      }],
    }],
  });
  const view = await makeTestSelection({
    read: reading(manifest),
    now: () => Date.parse("2026-08-20T05:00:00.000Z"),
  }).collect(CTX);
  assertEquals(view.status, "good");
  assertEquals(view.value, "50%");
  assertEquals(view.sub, "1 of 2 tests");
  assertEquals(view.href, "/test-selection");
  assertEquals(view.hint, "lanes ↗");
});

Deno.test("the selection tile goes amber once the manifest has gone stale", async () => {
  const view = await makeTestSelection({
    read: reading(sampleManifest()),
    now: () => Date.parse("2026-08-21T04:00:00.000Z"),
  }).collect(CTX);
  assertEquals(view.status, "warn");
  assertEquals(view.aside, '<span class="hfacet" title="28h old">28h old</span>');
});

Deno.test("the lane budget comes from the manifest that named it", () => {
  assertEquals(laneBudgetOf({ LANE_BUDGET_SECONDS: 180 }), 180);
  assertEquals(laneBudgetOf({}), LANE_BUDGET_FALLBACK_SECONDS);
  assertEquals(laneBudgetOf({ LANE_BUDGET_SECONDS: 0 }), LANE_BUDGET_FALLBACK_SECONDS);
  assertEquals(laneBudgetOf({ LANE_BUDGET_SECONDS: "x" }), LANE_BUDGET_FALLBACK_SECONDS);
});

Deno.test("the selection tile goes red when a lane is past its budget", async () => {
  const heavy = sampleEntry({ k: "unit", s: "memory", n: "a" }, { cost: 400 });
  const manifest = sampleManifest({
    entries: [heavy],
    lanes: [{
      lane: 1,
      projectedSeconds: 400,
      batches: [{
        suite: heavy.suite,
        identities: [JSON.stringify(heavy.test)],
      }],
    }],
  });
  const view = await makeTestSelection({
    read: reading(manifest),
    now: () => Date.parse("2026-08-20T05:00:00.000Z"),
  }).collect(CTX);
  assertEquals(view.status, "bad");
  // The overrun is why the tile is red, so it takes the line the share holds.
  assertEquals(
    view.sub,
    `fullest lane 400s of ${LANE_BUDGET_FALLBACK_SECONDS}s`,
  );
});

Deno.test("the selection tile serves the page both tiles link to", async () => {
  const tile = makeTestSelection({ read: reading(sampleManifest()) });
  const route = tile.routes?.find((r) => r.path === TEST_SELECTION_PATH);
  assertExists(route);
  const url = new URL(`http://wall${TEST_SELECTION_PATH}`);
  const response = await route.handler(new Request(url), url);
  assertEquals(
    response.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  assertStringIncludes(await response.text(), "<title>Test selection</title>");
});

Deno.test("both tiles link into the page the route serves", async () => {
  const read = reading(sampleManifest());
  const flakes = await makeTestFlakes({ read }).collect(CTX);
  const selection = await makeTestSelection({ read }).collect(CTX);
  assertEquals(selection.href, TEST_SELECTION_PATH);
  assertEquals(flakes.href?.split("#")[0], TEST_SELECTION_PATH);
});

Deno.test("a tile lets a store failure through, for the wall to gray it", async () => {
  // The wall turns a collection that throws into a gray tile carrying the
  // reason, which is what separates an unreadable store from an empty one.
  const failing: ManifestReader = () => Promise.reject(new Error("no network"));
  for (
    const tile of [
      makeTestFlakes({ read: failing }),
      makeTestSelection({ read: failing }),
    ]
  ) {
    await assertRejects(() => tile.collect(CTX), Error, "no network");
  }
});

Deno.test("the page says a store could not be read, rather than that it is empty", async () => {
  const tile = makeTestSelection({
    read: () => Promise.reject(new Error("no network")),
  });
  const route = tile.routes?.find((r) => r.path === TEST_SELECTION_PATH);
  assertExists(route);
  const url = new URL(`http://wall${TEST_SELECTION_PATH}`);
  const response = await route.handler(new Request(url), url);
  assertEquals(response.status, 503);
  const body = await response.text();
  assertStringIncludes(body, "could not be read: source unreachable");
  assertEquals(body.includes("has been published yet"), false);
});
