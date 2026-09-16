import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";

import { REPO, TEST_SELECTION_WORKFLOW } from "../config.ts";
import { publisherRunning } from "../test-selection-activity.ts";
import { makeTestFlakes } from "../tiles/test-flakes.ts";
import { makeTestSelection } from "../tiles/test-selection.ts";
import type { Ctx } from "../types.ts";

function context(token = "test-token"): Ctx {
  return {
    env: (key) => key === "GITHUB_TOKEN" ? token : undefined,
    runs: () => Promise.reject(new Error("history is not activity")),
    runsFor: () => Promise.reject(new Error("history is not activity")),
  };
}

describe("test-selection-activity", () => {
  it("returns true for unfinished runs, including old reruns", async () => {
    const requests: URL[] = [];
    let activeStatus = "";
    using _fetch = stub(globalThis, "fetch", (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      // This rerun's creation time predates the dashboard's workflow history.
      const active = {
        id: 221,
        created_at: "2020-01-01T00:00:00Z",
        run_attempt: 2,
      };
      return Promise.resolve(
        new Response(JSON.stringify({
          workflow_runs: url.searchParams.get("status") === activeStatus
            ? [active]
            : [],
        })),
      );
    });
    for (
      const status of [
        "queued",
        "in_progress",
        "waiting",
        "requested",
        "pending",
      ]
    ) {
      activeStatus = status;
      expect(await publisherRunning(context())).toBe(true);
    }
    activeStatus = "completed";
    expect(await publisherRunning(context())).toBe(false);
    for (const url of requests) {
      expect(url.pathname).toBe(
        `/repos/${REPO}/actions/workflows/${TEST_SELECTION_WORKFLOW}/runs`,
      );
      expect(url.searchParams.get("branch")).toBe("main");
      expect(url.searchParams.get("per_page")).toBe("1");
      expect(url.searchParams.has("created")).toBe(false);
      expect(url.searchParams.has("page")).toBe(false);
    }
  });

  it("shares activity reads between both tiles and refreshes after completion", async () => {
    using time = new FakeTime();
    let requests = 0;
    let running = true;
    using _fetch = stub(globalThis, "fetch", (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test-token",
      );
      requests++;
      return Promise.resolve(
        new Response(JSON.stringify({
          workflow_runs:
            running && url.searchParams.get("status") === "in_progress"
              ? [{ id: 1 }]
              : [],
        })),
      );
    });
    const ctx = context();
    const tiles = [makeTestFlakes(), makeTestSelection()];
    expect(tiles.map((tile) => tile.intervalMs)).toEqual([30_000, 30_000]);
    const read = () =>
      Promise.all(tiles.map((tile) => tile.collectActivity!(ctx)));
    expect(await read()).toEqual([true, true]);
    expect(requests).toBe(5);
    expect(await read()).toEqual([true, true]);
    expect(requests).toBe(5);
    time.tick(30_001);
    running = false;
    expect(await read()).toEqual([false, false]);
    expect(requests).toBe(10);
  });

  it("returns undefined without credentials and rejects failed reads", async () => {
    let requests = 0;
    using _fetch = stub(globalThis, "fetch", () => {
      requests++;
      return Promise.resolve(new Response(null, { status: 503 }));
    });
    expect(await publisherRunning(context(""))).toBeUndefined();
    expect(requests).toBe(0);
    await expect(publisherRunning(context())).rejects.toThrow();
    expect(requests).toBe(5);
  });
});
