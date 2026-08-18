import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  closedDays,
  compactDays,
  COMPACTION_LAG_DAYS,
  rollupName,
} from "./test-records-compact.ts";
import {
  buildObjectBody,
  type RunContext,
  type TestRecord,
} from "@commonfabric/test-support/records";

const NOW = Date.parse("2026-08-18T12:00:00Z");

const RECORD: TestRecord = {
  line: "record",
  test: { k: "unit", s: "bakery", n: "glaze > sets" },
  outcome: "pass",
  durationMs: 4,
};

function contextOn(day: string): RunContext {
  return {
    schema: 1,
    line: "context",
    reportId: "01COMPACT000000000000000",
    repo: "commontoolsinc/labs",
    commit: "e".repeat(40),
    dirty: false,
    env: "ci",
    ci: { workflowRunId: "9", runAttempt: 1, workflow: "CI", job: "Test" },
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt: `${day.replaceAll("/", "-")}T01:00:00.000Z`,
  };
}

// A store stub: listings answer by prefix, reads serve raw objects, and
// creates are logged. `rollups` names days whose rollup already exists;
// `rawByDay` maps a day to its raw objects' bodies.
function storeFetch(state: {
  rollups: string[];
  rawByDay: Record<string, string[]>;
  created: string[];
}): typeof fetch {
  return ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      // The object name rides in the multipart metadata part, ahead of the
      // gzipped payload.
      const head = new TextDecoder("utf-8", { fatal: false }).decode(
        (init.body as Uint8Array).subarray(0, 2048),
      );
      state.created.push(head.match(/"name":"([^"]+)"/)?.[1] ?? "unnamed");
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    if (url.includes("/storage/v1/")) {
      const prefix = new URL(url).searchParams.get("prefix")!;
      if (prefix.includes("/aggregated/")) {
        const day = prefix.match(/(\d{4}\/\d{2}\/\d{2})\.ndjson$/)?.[1];
        const items = day !== undefined && state.rollups.includes(day)
          ? [{ name: prefix }]
          : [];
        return Promise.resolve(
          new Response(JSON.stringify({ items }), { status: 200 }),
        );
      }
      const day = prefix.match(/(\d{4}\/\d{2}\/\d{2})\/$/)?.[1];
      const items = (state.rawByDay[day ?? ""] ?? []).map((_, index) => ({
        name: `${prefix}raw-${index}.ndjson`,
      }));
      return Promise.resolve(
        new Response(JSON.stringify({ items }), { status: 200 }),
      );
    }
    const raw = url.match(/(\d{4}\/\d{2}\/\d{2})\/raw-(\d+)\.ndjson$/);
    if (raw !== null) {
      const body = state.rawByDay[raw[1]!]![Number(raw[2]!)]!;
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    return Promise.resolve(new Response("unexpected", { status: 500 }));
  }) as typeof fetch;
}

describe("test-records-compact", () => {
  describe("closedDays()", () => {
    it("returns the partitions between the lag and the window edge", () => {
      const days = closedDays(COMPACTION_LAG_DAYS + 2, NOW);
      expect(days).toEqual(["2026/08/11", "2026/08/10", "2026/08/09"]);
    });
  });

  describe("compactDays()", () => {
    const options = {
      days: COMPACTION_LAG_DAYS,
      bucket: "cf-ci-metadata",
      rawPrefix: "labs/test-records/submissions/ci",
      token: "t",
      now: NOW,
    };

    it("writes one rollup for a day with records", async () => {
      const day = "2026/08/11";
      const state = {
        rollups: [],
        rawByDay: {
          [day]: [buildObjectBody(contextOn(day), [RECORD, RECORD])],
        },
        created: [] as string[],
      };
      await compactDays({
        ...options,
        plan: false,
        fetchImpl: storeFetch(state),
      });
      expect(state.created).toEqual([rollupName(day)]);
    });

    it("skips a day whose rollup already exists", async () => {
      const day = "2026/08/11";
      const state = {
        rollups: [day],
        rawByDay: {
          [day]: [buildObjectBody(contextOn(day), [RECORD])],
        },
        created: [] as string[],
      };
      await compactDays({
        ...options,
        plan: false,
        fetchImpl: storeFetch(state),
      });
      expect(state.created).toEqual([]);
    });

    it("leaves a day with no records open", async () => {
      const day = "2026/08/11";
      const state = {
        rollups: [],
        rawByDay: { [day]: [buildObjectBody(contextOn(day), [])] },
        created: [] as string[],
      };
      await compactDays({
        ...options,
        plan: false,
        fetchImpl: storeFetch(state),
      });
      expect(state.created).toEqual([]);
    });

    it("writes nothing in plan mode", async () => {
      const day = "2026/08/11";
      const state = {
        rollups: [],
        rawByDay: {
          [day]: [buildObjectBody(contextOn(day), [RECORD])],
        },
        created: [] as string[],
      };
      await compactDays({
        ...options,
        plan: true,
        fetchImpl: storeFetch(state),
      });
      expect(state.created).toEqual([]);
    });
  });
});
