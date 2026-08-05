import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  CI_GANTT_DETAIL_DIRNAME,
  CiGanttDetailStore,
  ganttDetailDirectory,
} from "../ci-gantt-detail.ts";
import type {
  CachedCiGanttJob,
  CachedCiRunReference,
} from "../ci-job-cache.ts";

const SOURCE = { repo: "owner/repo", workflow: "ci.yml" };
const OTHER = { repo: "owner/other", workflow: "ci.yml" };

function ganttJob(name: string): CachedCiGanttJob {
  return {
    attempt: 1,
    name,
    status: "completed",
    conclusion: "success",
    started_at: "2026-06-20T18:00:00Z",
    completed_at: "2026-06-20T18:01:00Z",
    steps: [{
      name: `${name} step`,
      number: 1,
      conclusion: "success",
      started_at: "2026-06-20T18:00:00Z",
      completed_at: "2026-06-20T18:01:00Z",
    }],
  };
}

const attempt = (runId: number, runAttempt = 1): CachedCiRunReference => ({
  runId,
  runAttempt,
});

async function gzipped(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("ci-gantt-detail", () => {
  let directory: string;
  let store: CiGanttDetailStore;

  const names = async (): Promise<string[]> => {
    const found: string[] = [];
    for await (const entry of Deno.readDir(`${directory}/detail`)) {
      found.push(entry.name);
    }
    return found.sort();
  };

  beforeEach(async () => {
    directory = await Deno.makeTempDir({ prefix: "ci-gantt-detail-" });
    store = new CiGanttDetailStore(`${directory}/detail`);
  });

  afterEach(async () => {
    await Deno.remove(directory, { recursive: true });
  });

  describe("ganttDetailDirectory()", () => {
    it("returns a directory beside the run index it describes", () => {
      expect(
        ganttDetailDirectory(
          "/var/lib/dashboard/fabric-wall-ci-run-index.json",
        ),
      ).toBe(`/var/lib/dashboard/${CI_GANTT_DETAIL_DIRNAME}`);
    });
  });

  describe("CiGanttDetailStore", () => {
    describe("instance members", () => {
      describe("directory", () => {
        it("resolves a deferred directory once, on first use", () => {
          let resolved = 0;
          const deferred = new CiGanttDetailStore(() => {
            resolved++;
            return "/tmp/ci-gantt-detail-deferred";
          });
          expect(resolved).toBe(0);
          expect(deferred.directory).toBe("/tmp/ci-gantt-detail-deferred");
          expect(deferred.directory).toBe("/tmp/ci-gantt-detail-deferred");
          expect(resolved).toBe(1);
        });
      });

      describe("read()", () => {
        it("returns null for an attempt that was never written", async () => {
          expect(await store.read(SOURCE, 10, 1)).toBeNull();
        });

        it("returns the jobs the same attempt was written with", async () => {
          await store.write(SOURCE, 10, 1, [ganttJob("Check")]);
          expect((await store.read(SOURCE, 10, 1))?.[0].name).toBe("Check");
        });

        it("returns null for another attempt of the same run", async () => {
          await store.write(SOURCE, 10, 1, [ganttJob("Check")]);
          expect(await store.read(SOURCE, 10, 2)).toBeNull();
        });

        it("returns null for the same attempt of another repository", async () => {
          await store.write(SOURCE, 10, 1, [ganttJob("Check")]);
          expect(await store.read(OTHER, 10, 1)).toBeNull();
        });

        it("returns null for content it cannot use", async () => {
          await store.write(SOURCE, 11, 1, [ganttJob("Check")]);
          const path = `${directory}/detail/owner%2Frepo.ci%2Eyml.11.1.json`;
          // Null rather than an empty chart, so the collector fetches the
          // attempt again instead of drawing a run with no timings.
          for (
            const content of [
              "{",
              "null",
              JSON.stringify({ version: 99, jobs: [] }),
              JSON.stringify({ version: 1, jobs: [{ name: "Check" }] }),
              JSON.stringify({ version: 1 }),
            ]
          ) {
            await Deno.writeFile(path, await gzipped(content));
            expect(await store.read(SOURCE, 11, 1)).toBeNull();
          }
        });

        it("returns null for content that is not compressed", async () => {
          await store.write(SOURCE, 11, 1, [ganttJob("Check")]);
          await Deno.writeTextFile(
            `${directory}/detail/owner%2Frepo.ci%2Eyml.11.1.json`,
            JSON.stringify({ version: 1, jobs: [] }),
          );
          expect(await store.read(SOURCE, 11, 1)).toBeNull();
        });
      });

      describe("write()", () => {
        it("replaces the jobs an attempt was previously written with", async () => {
          await store.write(SOURCE, 10, 1, [ganttJob("Check")]);
          await store.write(SOURCE, 10, 1, [ganttJob("Recheck")]);
          expect((await store.read(SOURCE, 10, 1))?.[0].name).toBe("Recheck");
        });

        it("stores an attempt far smaller than its timings", async () => {
          // A run the size of the labs CI workflow: around fifty jobs, each
          // with a dozen or so steps drawn from a handful of repeated names.
          const stepNames = [
            "Set up job",
            "Checkout",
            "Install Deno",
            "Restore cache",
            "Run tests",
            "Upload coverage",
            "Post Checkout",
            "Complete job",
          ];
          const jobs: CachedCiGanttJob[] = Array.from(
            { length: 52 },
            (_, job) => ({
              attempt: 1,
              name: `Test (${job + 1}/52)`,
              status: "completed",
              conclusion: "success",
              started_at: new Date(1_760_000_000_000 + job * 1_000)
                .toISOString(),
              completed_at: new Date(1_760_000_600_000 + job * 1_000)
                .toISOString(),
              steps: Array.from({ length: 14 }, (_, step) => ({
                name: stepNames[step % stepNames.length],
                number: step + 1,
                conclusion: "success",
                started_at: new Date(1_760_000_000_000 + step * 30_000)
                  .toISOString(),
                completed_at: new Date(1_760_000_020_000 + step * 30_000)
                  .toISOString(),
              })),
            }),
          );

          await store.write(SOURCE, 50, 1, jobs);
          const stored = (await Deno.stat(
            `${directory}/detail/owner%2Frepo.ci%2Eyml.50.1.json`,
          )).size;
          const timings = JSON.stringify({ version: 1, jobs }).length;

          // The ratio is what lets every attempt the run index retains keep
          // its detail. Ten times is well inside what this data compresses to,
          // and far enough from it that ordinary changes to the timings do not
          // move it.
          expect(stored * 10).toBeLessThan(timings);
          expect((await store.read(SOURCE, 50, 1))?.length).toBe(jobs.length);
        });

        it("throws when the cache directory does not exist", async () => {
          const absent = new CiGanttDetailStore(
            `${directory}/absent/${CI_GANTT_DETAIL_DIRNAME}`,
          );
          await expect(absent.write(SOURCE, 30, 1, [ganttJob("Check")]))
            .rejects.toThrow(Deno.errors.NotFound);
        });

        it("removes its temporary file when the rename fails", async () => {
          const originalRename = Deno.rename;
          try {
            await store.write(SOURCE, 40, 1, [ganttJob("Check")]);
            Deno.rename = () => Promise.reject(new Error("rename failed"));
            await expect(store.write(SOURCE, 41, 1, [ganttJob("Check")]))
              .rejects.toThrow("rename failed");
            Deno.rename = originalRename;
            expect(await names()).toEqual(["owner%2Frepo.ci%2Eyml.40.1.json"]);
          } finally {
            Deno.rename = originalRename;
          }
        });
      });

      describe("prune()", () => {
        it("removes the attempts the keep set does not name", async () => {
          for (const runId of [10, 11, 12]) {
            await store.write(SOURCE, runId, 1, [ganttJob("Check")]);
          }
          await store.write(SOURCE, 12, 2, [ganttJob("Check")]);
          await store.write(OTHER, 1, 1, [ganttJob("Check")]);

          // The keep set is the run index's decision, not the file name's: run
          // 10 is retained though its identifier is the smallest, and attempt 1
          // of run 12 is dropped though a later attempt of it is kept. Another
          // repository is left alone entirely.
          await store.prune(SOURCE, [attempt(10), attempt(12, 2)]);

          expect(await names()).toEqual([
            "owner%2Fother.ci%2Eyml.1.1.json",
            "owner%2Frepo.ci%2Eyml.10.1.json",
            "owner%2Frepo.ci%2Eyml.12.2.json",
          ]);
        });

        it("removes temporary files an interrupted write left behind", async () => {
          await store.write(SOURCE, 20, 1, [ganttJob("Check")]);
          const orphan =
            `${directory}/detail/owner%2Frepo.ci%2Eyml.20.1.json.old.tmp`;
          await Deno.writeTextFile(orphan, "{}");

          await store.prune(SOURCE, [attempt(20)]);

          expect(await store.read(SOURCE, 20, 1)).not.toBeNull();
          await expect(Deno.stat(orphan)).rejects.toThrow(Deno.errors.NotFound);
        });

        it("removes nothing while a chart holds it off", async () => {
          await store.write(SOURCE, 30, 1, [ganttJob("Check")]);

          const resume = store.pausePruning();
          const alsoDrawing = store.pausePruning();
          await store.prune(SOURCE, []);
          expect(await store.read(SOURCE, 30, 1)).not.toBeNull();

          // Releasing one of two charts is not enough, and releasing the same
          // chart twice does not release the other.
          resume();
          resume();
          await store.prune(SOURCE, []);
          expect(await store.read(SOURCE, 30, 1)).not.toBeNull();

          alsoDrawing();
          await store.prune(SOURCE, []);
          expect(await store.read(SOURCE, 30, 1)).toBeNull();
        });

        it("stops removing when a chart starts partway through", async () => {
          for (const runId of [60, 61, 62]) {
            await store.write(SOURCE, runId, 1, [ganttJob("Check")]);
          }
          // Listing the directory yields, so a chart can start after prune has
          // passed its entry check and before it has removed anything.
          const listing = Deno.readDir;
          let resume: () => void = () => {};
          try {
            Deno.readDir = (path: string | URL) => {
              Deno.readDir = listing;
              resume = store.pausePruning();
              return listing(path);
            };
            await store.prune(SOURCE, []);
          } finally {
            Deno.readDir = listing;
            resume();
          }

          expect(await store.read(SOURCE, 60, 1)).not.toBeNull();
          expect(await store.read(SOURCE, 61, 1)).not.toBeNull();
          expect(await store.read(SOURCE, 62, 1)).not.toBeNull();
        });

        it("returns without error when the directory does not exist", async () => {
          const absent = new CiGanttDetailStore(`${directory}/absent`);
          await absent.prune(SOURCE, []);
        });
      });
    });
  });
});
