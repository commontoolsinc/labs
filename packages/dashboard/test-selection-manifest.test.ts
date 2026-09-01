import { assertEquals } from "@std/assert";
import {
  sampleEntry,
  sampleManifest,
  serializeManifest,
} from "@commonfabric/test-support/records";

import { generatedAtOf, newestManifest } from "./test-selection-manifest.ts";
import { makeTestFlakes } from "./tiles/test-flakes.ts";
import {
  LANE_BUDGET_FALLBACK_SECONDS,
  laneBudgetOf,
  makeTestSelection,
} from "./tiles/test-selection.ts";
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

Deno.test("newestManifest treats a malformed manifest as absent", async () => {
  const found = await newestManifest({
    fetchImpl: storeOf({
      [`${PREFIX}/manifest-2026-08-20T04:00:00.000Z-b.json.gz`]:
        "{not a manifest",
    }),
  });
  assertEquals(found, undefined);
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

Deno.test("newestManifest treats a refused manifest as absent", async () => {
  // Listed but not readable, which is what a manifest deleted between
  // the listing and the read looks like.
  for (const status of [403, 404, 500]) {
    const found = await newestManifest({
      fetchImpl: storeRefusing(() =>
        Promise.resolve(new Response("", { status }))
      ),
    });
    assertEquals(found, undefined);
  }
});

Deno.test("newestManifest treats a failed read as absent", async () => {
  const found = await newestManifest({
    fetchImpl: storeRefusing(() => Promise.reject(new Error("no network"))),
  });
  assertEquals(found, undefined);
});

Deno.test("newestManifest treats an unreachable store as absent", async () => {
  const found = await newestManifest({
    fetchImpl: (() => Promise.reject(new Error("no network"))) as typeof fetch,
  });
  assertEquals(found, undefined);
});

const CTX: Ctx = {
  runs: () => Promise.resolve([]),
  runsFor: () => Promise.resolve([]),
  env: () => undefined,
};

/** A store holding one manifest under a fixed name. */
function storeHolding(manifest: Parameters<typeof serializeManifest>[0]) {
  return storeOf({
    [`${PREFIX}/manifest-2026-08-20T04:00:00.000Z-a.json.gz`]:
      serializeManifest(manifest),
  });
}

Deno.test("both test tiles are unknown when there is no manifest", async () => {
  const empty = storeOf({});
  for (
    const tile of [
      makeTestFlakes({ fetchImpl: empty }),
      makeTestSelection({ fetchImpl: empty }),
    ]
  ) {
    const view = await tile.collect(CTX);
    assertEquals(view.status, "unknown");
    assertEquals(view.sub, "no selection manifest yet");
  }
});

Deno.test("the flake tile is green when nothing is withheld as flaky", async () => {
  const tile = makeTestFlakes({ fetchImpl: storeHolding(sampleManifest()) });
  const view = await tile.collect(CTX);
  assertEquals(view.status, "good");
  assertEquals(view.value, "0");
});

Deno.test("the flake tile counts what selection held back, and names the worst", async () => {
  const longName = "space > flakes with a name that keeps going past the tile limit";
  const noisy = sampleEntry({ k: "unit", s: "memory", n: longName, v: "worker" }, {
    flakeRate: 0.4,
  });
  const manifest = sampleManifest({
    entries: [noisy],
    withheld: [{ test: noisy.test, suite: noisy.suite, reason: "flaky" }],
  });
  const view = await makeTestFlakes({ fetchImpl: storeHolding(manifest) })
    .collect(CTX);
  assertEquals(view.status, "warn");
  assertEquals(view.value, "1");
  assertEquals(view.extra?.includes('class="tile-detail-list"'), true);
  assertEquals(view.extra?.includes('role="region"'), true);
  assertEquals(view.extra?.includes('tabindex="0"'), true);
  assertEquals(view.extra?.includes("scroll for more"), false);
  assertEquals(
    view.extra?.includes(
      `title="40.0% · unit · memory: ${longName.replace(">", "&gt;")} (worker)"`,
    ),
    true,
  );
  assertEquals(view.extra?.includes("… (worker)</div>"), true);
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
    fetchImpl: storeHolding(manifest),
    now: () => Date.parse("2026-08-20T05:00:00.000Z"),
  }).collect(CTX);
  assertEquals(view.status, "good");
  assertEquals(view.value, "50%");
  assertEquals(
    view.sub,
    `1 of 2 tests · fullest lane 3s of ${LANE_BUDGET_FALLBACK_SECONDS}s`,
  );
});

Deno.test("the selection tile goes amber once the manifest has gone stale", async () => {
  const view = await makeTestSelection({
    fetchImpl: storeHolding(sampleManifest()),
    now: () => Date.parse("2026-08-21T04:00:00.000Z"),
  }).collect(CTX);
  assertEquals(view.status, "warn");
  assertEquals(view.aside, "28h old");
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
    fetchImpl: storeHolding(manifest),
    now: () => Date.parse("2026-08-20T05:00:00.000Z"),
  }).collect(CTX);
  assertEquals(view.status, "bad");
});
