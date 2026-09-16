import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import {
  type Manifest,
  sampleEntry,
  sampleManifest,
  serializeManifest,
} from "@commonfabric/test-support/records";

import {
  makeTestSelectionSource,
  type SelectionHistory,
  withSelectionHistory,
} from "./test-selection-history.ts";
import {
  MANIFEST_SHARE_MS,
  TEST_SELECTION_PREFIX,
} from "./test-selection-manifest.ts";
import { makeTestFlakes } from "./tiles/test-flakes.ts";
import { makeTestSelection } from "./tiles/test-selection.ts";
import type { Ctx, TileView } from "./types.ts";

const DAY = 86_400_000;
const CTX: Ctx = {
  runs: () => Promise.resolve([]),
  runsFor: () => Promise.resolve([]),
  env: () => undefined,
};

/** Builds a four-test corpus with a chosen packing and flaky count. */
function measurement(at: string, selected = 2, flaky = 1): Manifest {
  const entries = Array.from(
    { length: 4 },
    (_, i) => sampleEntry({ k: "unit", s: "memory", n: `test ${i}` }),
  );
  return sampleManifest({
    generatedAt: at,
    entries,
    withheld: entries.slice(0, flaky).map((entry) => ({
      test: entry.test,
      suite: entry.suite,
      reason: "flaky",
    })),
    lanes: [{
      lane: 1,
      projectedSeconds: 10,
      batches: [{
        suite: "memory",
        identities: entries.slice(flaky, flaky + selected).map((entry) =>
          JSON.stringify(entry.test)
        ),
      }],
    }],
  });
}

/** Returns the immutable object name used by the fake store. */
const objectName = (at: string): string =>
  `${TEST_SELECTION_PREFIX}manifest-${at}-measurement.json.gz`;

/** Serves paginated listings and mutable responses while recording every read. */
function storeOf(manifests: Manifest[]) {
  const objects: Record<string, string | number> = Object.fromEntries(
    manifests.map((manifest) => [
      objectName(manifest.generatedAt),
      serializeManifest(manifest),
    ]),
  );
  const reads: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/o")) {
      const offset = Number(url.searchParams.get("pageToken") ?? 0);
      reads.push(`list:${offset}`);
      const names = Object.keys(objects).filter((name) =>
        name.startsWith(url.searchParams.get("prefix") ?? "")
      ).reverse();
      return Promise.resolve(
        new Response(JSON.stringify({
          items: names.slice(offset, offset + 2).map((name) => ({ name })),
          ...(offset + 2 < names.length
            ? { nextPageToken: String(offset + 2) }
            : {}),
        })),
      );
    }
    const name = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    reads.push(name);
    const value = objects[name] ?? 404;
    return Promise.resolve(
      typeof value === "number"
        ? new Response(null, { status: value })
        : new Response(value),
    );
  };
  return { objects, reads, fetchImpl };
}

/** Returns the chart's connected lines as numeric coordinates. */
function linesOf(svg = ""): number[][][] {
  return [...svg.matchAll(/<polyline points="([^"]+)"/g)].map((match) =>
    match[1].split(" ").map((point) => point.split(",").map(Number))
  );
}

describe("test-selection-history", () => {
  let directory: string;
  let cacheFile: string;
  let time: FakeTime;

  beforeEach(async () => {
    directory = await Deno.makeTempDir({ prefix: "test-selection-history-" });
    cacheFile = join(directory, "history.json");
    time = new FakeTime("2026-09-15T00:00:00.000Z");
  });

  afterEach(async () => {
    time.restore();
    await Deno.remove(directory, { recursive: true });
  });

  describe("makeTestSelectionSource()", () => {
    it("reads every page and every available date once across the tiles and detail reader", async () => {
      const first = measurement("2025-01-01T00:00:00.000Z", 1, 0);
      const middle = measurement("2026-06-01T00:00:00.000Z", 2, 1);
      const last = measurement("2026-09-14T20:00:00.000Z", 1, 2);
      const store = storeOf([first, middle, last]);
      store.objects[`${TEST_SELECTION_PREFIX}state/aggregate.json.gz`] = "{}";
      store.objects[objectName("2026-99-99T00:00:00.000Z")] = "{}";
      store
        .objects[
          "labs/test-selection/v10/manifest-2030-01-01T00:00:00Z-x.json.gz"
        ] = "{}";
      const source = makeTestSelectionSource({
        fetchImpl: store.fetchImpl,
        cacheFile,
      });
      const [flakes, selection, manifest, history] = await Promise.all([
        makeTestFlakes({ source }).collect(CTX),
        makeTestSelection({ source }).collect(CTX),
        source.latest(),
        source.history(),
      ]);
      expect(manifest?.generatedAt).toBe(last.generatedAt);
      expect(flakes.value).toBe("2 flaky tests");
      expect(selection.value).toBe("25%");
      expect(history.samples).toEqual([
        {
          at: Date.parse(first.generatedAt),
          counts: { known: 4, selected: 1, flaky: 0 },
        },
        {
          at: Date.parse(middle.generatedAt),
          counts: { known: 4, selected: 2, flaky: 1 },
        },
        {
          at: Date.parse(last.generatedAt),
          counts: { known: 4, selected: 1, flaky: 2 },
        },
      ]);
      expect(history.errors).toEqual([]);
      expect(flakes.duration).toBe(
        Date.parse(last.generatedAt) - Date.parse(first.generatedAt),
      );
      expect(selection.duration).toBe(flakes.duration);
      expect(linesOf(flakes.extra)[0]).toHaveLength(3);
      expect(store.reads.filter((name) => name.startsWith("list:"))).toEqual([
        "list:0",
        "list:2",
        "list:4",
      ]);
      for (const sample of [first, middle, last]) {
        expect(
          store.reads.filter((name) => name === objectName(sample.generatedAt)),
        ).toHaveLength(1);
      }
      expect(store.reads.filter((name) => !name.startsWith("list:")))
        .toHaveLength(3);
    });

    it("publishes the latest headlines or errors while historical downloads are pending", async () => {
      for (const status of [200, 503]) {
        const first = measurement("2026-09-01T00:00:00.000Z");
        const last = measurement("2026-09-15T00:00:00.000Z");
        const store = storeOf([first, last]);
        if (status !== 200) {
          store.objects[objectName(last.generatedAt)] = status;
        }
        const historical = Promise.withResolvers<void>();
        const source = makeTestSelectionSource({
          cacheFile: join(directory, `history-${status}.json`),
          fetchImpl: async (input, init) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
            );
            if (
              decodeURIComponent(url.pathname).endsWith(
                objectName(first.generatedAt),
              )
            ) {
              await historical.promise;
            }
            return store.fetchImpl(input, init);
          },
        });
        const flakes = Promise.withResolvers<TileView>();
        const selection = Promise.withResolvers<TileView>();
        const collecting = Promise.all([
          makeTestFlakes({ source }).collect(CTX, flakes.resolve),
          makeTestSelection({ source }).collect(CTX, selection.resolve),
        ]);
        const [flakeHeadline, selectionHeadline] = await Promise.all([
          flakes.promise,
          selection.promise,
        ]);
        expect(flakeHeadline.value).toBe(status === 200 ? "1 flaky test" : "—");
        expect(selectionHeadline.value).toBe(status === 200 ? "50%" : "—");
        if (status !== 200) {
          expect(flakeHeadline.status).toBe("unknown");
          expect(selectionHeadline.status).toBe("unknown");
          expect(flakeHeadline.sub).toBe("temporarily unavailable");
          expect(selectionHeadline.sub).toBe("temporarily unavailable");
        }
        expect(flakeHeadline.extra).toBeUndefined();
        expect(selectionHeadline.extra).toBeUndefined();
        expect(store.reads).not.toContain(objectName(first.generatedAt));
        historical.resolve();
        for (const view of await collecting) {
          if (status === 200) expect(linesOf(view.extra)[0]).toHaveLength(2);
          else expect(view.extra).toContain("<circle");
        }
        expect(
          store.reads.filter((name) => name === objectName(first.generatedAt)),
        )
          .toHaveLength(1);
      }
    });

    it("restores counts after a restart without downloading historical inventories", async () => {
      const first = measurement("2026-01-01T00:00:00.000Z");
      const last = measurement("2026-09-01T00:00:00.000Z", 1, 0);
      const store = storeOf([first, last]);
      const options = { fetchImpl: store.fetchImpl, cacheFile };
      const expected = await makeTestSelectionSource(options).history();
      const persisted = await Deno.readTextFile(cacheFile);
      expect(persisted.length).toBeLessThan(1000);
      expect(persisted).not.toContain("identities");
      store.reads.length = 0;
      const restored = await makeTestSelectionSource(options).history();
      expect(restored).toEqual(expected);
      expect(store.reads.filter((name) => !name.startsWith("list:"))).toEqual([
        objectName(last.generatedAt),
      ]);
      expect(await Deno.readTextFile(cacheFile)).toBe(persisted);
    });

    it("collects new manifests and removes cached objects absent from a later listing", async () => {
      const first = measurement("2026-01-01T00:00:00.000Z");
      const middle = measurement("2026-05-01T00:00:00.000Z");
      const last = measurement("2026-09-01T00:00:00.000Z");
      const store = storeOf([first, middle]);
      const source = makeTestSelectionSource({
        fetchImpl: store.fetchImpl,
        cacheFile,
      });
      await source.history();
      delete store.objects[objectName(first.generatedAt)];
      store.objects[objectName(last.generatedAt)] = serializeManifest(last);
      store.reads.length = 0;
      time.tick(MANIFEST_SHARE_MS + 1);
      const result = await source.history();
      expect(result.samples.map((sample) => sample.at)).toEqual([
        Date.parse(middle.generatedAt),
        Date.parse(last.generatedAt),
      ]);
      expect(store.reads.filter((name) => !name.startsWith("list:"))).toEqual([
        objectName(last.generatedAt),
      ]);
      expect(await Deno.readTextFile(cacheFile)).not.toContain(
        objectName(first.generatedAt),
      );
      delete store.objects[objectName(middle.generatedAt)];
      delete store.objects[objectName(last.generatedAt)];
      time.tick(MANIFEST_SHARE_MS + 1);
      expect(await source.latest()).toBeUndefined();
      expect(await source.history()).toEqual({ samples: [], errors: [] });
      expect(JSON.parse(await Deno.readTextFile(cacheFile)).counts).toEqual({});
    });

    it("keeps gaps for empty and unreadable manifests and fills recovered reads on refresh", async () => {
      const empty = sampleManifest({
        generatedAt: "2026-09-01T00:00:00.000Z",
        entries: [],
      });
      const broken = measurement("2026-09-02T00:00:00.000Z");
      const missing = measurement("2026-09-03T00:00:00.000Z");
      const last = measurement("2026-09-04T00:00:00.000Z", 0, 0);
      const store = storeOf([empty, broken, missing, last]);
      store.objects[objectName(broken.generatedAt)] = "{broken";
      store.objects[objectName(missing.generatedAt)] = 404;
      const source = makeTestSelectionSource({
        fetchImpl: store.fetchImpl,
        cacheFile,
      });
      const result = await source.history();
      expect(result.samples.map((sample) => sample.counts)).toEqual([
        null,
        null,
        null,
        { known: 4, selected: 0, flaky: 0 },
      ]);
      expect(result.errors).toHaveLength(2);
      store.objects[objectName(broken.generatedAt)] = serializeManifest(broken);
      store.objects[objectName(missing.generatedAt)] = serializeManifest(
        missing,
      );
      store.reads.length = 0;
      time.tick(MANIFEST_SHARE_MS + 1);
      const recovered = await source.history();
      expect(recovered.errors).toEqual([]);
      expect(recovered.samples.map((sample) => sample.counts?.known)).toEqual([
        undefined,
        4,
        4,
        4,
      ]);
      expect(store.reads.filter((name) => !name.startsWith("list:")).sort())
        .toEqual([
          objectName(broken.generatedAt),
          objectName(missing.generatedAt),
        ]);
    });

    it("draws the available history when the newest manifest cannot be read", async () => {
      const first = measurement("2026-09-01T00:00:00.000Z");
      const last = measurement("2026-09-02T00:00:00.000Z");
      const store = storeOf([first, last]);
      store.objects[objectName(last.generatedAt)] = 503;
      const source = makeTestSelectionSource({
        fetchImpl: store.fetchImpl,
        cacheFile,
      });
      const tiles = await Promise.all([
        makeTestFlakes({ source }).collect(CTX),
        makeTestSelection({ source }).collect(CTX),
      ]);
      for (const view of tiles) {
        expect(view.status).toBe("unknown");
        expect(view.value).toBe("—");
        expect(view.extra).toContain('<circle cx="0.0"');
        expect(view.aside).toContain("history warning");
        expect(view.duration).toBe(DAY);
      }
      expect(
        store.reads.filter((name) => name === objectName(last.generatedAt)),
      ).toHaveLength(1);
    });

    it("reports an empty latest corpus as unknown while retaining earlier measurements", async () => {
      const first = measurement("2026-09-01T00:00:00.000Z", 0, 0);
      const empty = sampleManifest({
        generatedAt: "2026-09-02T00:00:00.000Z",
        entries: [],
      });
      const store = storeOf([first, empty]);
      const source = makeTestSelectionSource({
        fetchImpl: store.fetchImpl,
        cacheFile,
      });
      for (
        const tile of [
          makeTestFlakes({ source }),
          makeTestSelection({ source }),
        ]
      ) {
        const view = await tile.collect(CTX);
        expect(view.status).toBe("unknown");
        expect(view.value).toBe("—");
        expect(view.sub).toBe("selection manifest has no tests");
        expect(view.extra).toContain("<circle");
      }
    });

    it("reconstructs malformed and incompatible caches from the source", async () => {
      const manifest = measurement("2026-09-01T00:00:00.000Z");
      const store = storeOf([manifest]);
      const incompatible = {
        version: 1,
        bucket: "cf-ci-metadata",
        prefix: TEST_SELECTION_PREFIX,
        counts: {
          [objectName(manifest.generatedAt)]: {
            known: 1,
            selected: 0,
            flaky: 0,
          },
        },
      };
      for (
        const body of [
          "{broken",
          JSON.stringify({ ...incompatible, version: 2 }),
          JSON.stringify({ ...incompatible, bucket: "another-bucket" }),
          JSON.stringify({ ...incompatible, prefix: "another-prefix/" }),
          JSON.stringify({
            ...incompatible,
            counts: {
              [objectName(manifest.generatedAt)]: {
                known: -1,
                selected: 0,
                flaky: 0,
              },
            },
          }),
        ]
      ) {
        await Deno.writeTextFile(cacheFile, body);
        const history = await makeTestSelectionSource({
          fetchImpl: store.fetchImpl,
          cacheFile,
        }).history();
        expect(history.samples[0].counts).toEqual({
          known: 4,
          selected: 2,
          flaky: 1,
        });
        expect(history.errors).toEqual([]);
      }
    });

    it("keeps measurements visible through cache failures and later persists them", async () => {
      const store = storeOf([measurement("2026-09-01T00:00:00.000Z")]);
      const unavailable = join(directory, "missing", "history.json");
      const source = makeTestSelectionSource({
        fetchImpl: store.fetchImpl,
        cacheFile: unavailable,
      });
      const failed = await source.history();
      expect(failed.samples[0].counts).toEqual({
        known: 4,
        selected: 2,
        flaky: 1,
      });
      expect(failed.errors).toHaveLength(1);
      expect(failed.errors[0]).toContain("Could not write history cache");
      const view = await makeTestFlakes({ source }).collect(CTX);
      expect(view.status).toBe("warn");
      expect(view.value).toBe("1 flaky test");
      expect(view.extra).toContain("<circle");
      expect(view.aside).toContain("history warning");
      const downloads = store.reads.filter((name) => !name.startsWith("list:"));
      await Deno.mkdir(join(directory, "missing"));
      time.tick(MANIFEST_SHARE_MS + 1);
      const recovered = await source.history();
      expect(recovered.samples).toEqual(failed.samples);
      expect(recovered.errors).toEqual([]);
      expect(store.reads.filter((name) => !name.startsWith("list:"))).toEqual(
        downloads,
      );
      expect(JSON.parse(await Deno.readTextFile(unavailable)).version).toBe(1);
      const directoryCache = join(directory, "directory-cache");
      await Deno.mkdir(directoryCache);
      const invalid = makeTestSelectionSource({
        fetchImpl: store.fetchImpl,
        cacheFile: directoryCache,
      });
      const readable = await invalid.history();
      expect(readable.samples).toEqual(failed.samples);
      expect(readable.errors).toHaveLength(2);
      expect(readable.errors[0]).toContain("Could not read history cache");
      expect(readable.errors[1]).toContain("Could not write history cache");
    });

    it("leaves the cache intact when listing fails", async () => {
      const store = storeOf([measurement("2026-09-01T00:00:00.000Z")]);
      await makeTestSelectionSource({ fetchImpl: store.fetchImpl, cacheFile })
        .history();
      const persisted = await Deno.readTextFile(cacheFile);
      const source = makeTestSelectionSource({
        cacheFile,
        fetchImpl: () => Promise.reject(new Error("no network")),
      });
      await expect(source.history()).rejects.toThrow("no network");
      expect(await Deno.readTextFile(cacheFile)).toBe(persisted);
    });
  });

  describe("withSelectionHistory()", () => {
    const view: TileView = {
      label: "test selection",
      status: "good",
      value: "50%",
    };
    const counts = (value: number) => ({
      known: 100,
      selected: value,
      flaky: value,
    });

    it("breaks lines at missing measurements without compressing time or changing scale", () => {
      const history: SelectionHistory = {
        samples: [
          { at: 0, counts: counts(10) },
          { at: DAY, counts: counts(20) },
          { at: 2 * DAY, counts: null },
          { at: 3 * DAY, counts: null },
          { at: 4 * DAY, counts: counts(40) },
          { at: 5 * DAY, counts: counts(20) },
        ],
        errors: [],
      };
      const chart = withSelectionHistory(view, history, "flaky");
      const lines = linesOf(chart.extra);
      expect(lines).toHaveLength(2);
      expect(lines.map((line) => line.map(([x]) => x))).toEqual([[0, 44], [
        176,
        220,
      ]]);
      expect(lines[0][1][1]).toBe(lines[1][1][1]);
      expect(lines[0][0][1]).toBeGreaterThan(lines[0][1][1]);
      expect(lines[1][0][1]).toBeLessThan(lines[1][1][1]);
      expect(chart.duration).toBe(5 * DAY);
    });

    it("uses each sample's corpus for the selected percentage", () => {
      const history: SelectionHistory = {
        samples: [
          { at: 0, counts: { known: 10, selected: 5, flaky: 1 } },
          { at: DAY, counts: { known: 20, selected: 10, flaky: 2 } },
          { at: 2 * DAY, counts: { known: 20, selected: 5, flaky: 1 } },
        ],
        errors: [],
      };
      const line =
        linesOf(withSelectionHistory(view, history, "selected").extra)[0];
      expect(line[0][1]).toBe(line[1][1]);
      expect(line[2][1]).toBeGreaterThan(line[1][1]);
    });

    it("draws isolated zero measurements as dots and keeps missing edges blank", () => {
      const chart = withSelectionHistory(view, {
        samples: [
          { at: 0, counts: null },
          { at: DAY, counts: counts(0) },
          { at: 2 * DAY, counts: null },
          { at: 3 * DAY, counts: counts(10) },
          { at: 4 * DAY, counts: null },
        ],
        errors: [],
      }, "selected");
      expect(linesOf(chart.extra)).toEqual([]);
      expect(chart.extra).toContain('<circle cx="55.0"');
      expect(chart.extra).toContain('<circle cx="165.0"');
      expect(chart.extra).not.toContain("NaN");
    });

    it("draws one available measurement and omits a chart when every sample is missing", () => {
      const single = withSelectionHistory(view, {
        samples: [{ at: DAY, counts: counts(0) }],
        errors: [],
      }, "flaky");
      expect(single.extra).toContain('<circle cx="110.0"');
      for (const samples of [[], [{ at: DAY, counts: null }]]) {
        const empty = withSelectionHistory(
          view,
          { samples, errors: [] },
          "flaky",
        );
        expect(empty.extra).toBeUndefined();
        expect(empty.duration).toBeUndefined();
      }
    });

    it("preserves status and existing badges while escaping a history warning", () => {
      const result = withSelectionHistory({
        ...view,
        status: "bad",
        aside: "age badge",
      }, {
        samples: [],
        errors: ['bad "<script>"'],
      }, "flaky");
      expect(result.status).toBe("bad");
      expect(result.aside).toContain("age badge");
      expect(result.aside).toContain("history warning");
      expect(result.aside).toContain("&lt;script&gt;");
      expect(result.aside).not.toContain("<script>");
    });
  });
});
