import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { kickoffRunLens, summarizeKickoffRun } from "../../kickoff/runs.ts";
import {
  listKickoffRuns,
  readKickoffRun,
  readKickoffRunArtifact,
  readKickoffToolOutput,
} from "../../kickoff/run-store.ts";
import { createHarnessRunState } from "../../src/run-state.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";

const runState = (runId: string, updatedAt: string) => ({
  ...createHarnessRunState({
    runId,
    cfcEnforcementMode: "observe",
    currentDir: "/workspace",
    now: "2026-01-01T00:00:00.000Z",
  }),
  updatedAt,
});

const call = (
  id: string,
  name: string,
  args: Record<string, unknown>,
): HarnessTranscriptMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [
    {
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});

const result = (
  toolCallId: string,
  toolName: string,
  content: unknown,
): HarnessTranscriptMessage => ({
  role: "tool",
  toolCallId,
  toolName,
  content: typeof content === "string" ? content : JSON.stringify(content),
});

/** A run that searched, failed to compile, fixed, and named the piece. */
const buildTranscript = (): HarnessTranscriptMessage[] => [
  { role: "user", content: "track the books I am reading" },
  call("c1", "search_patterns", { query: "reading list" }),
  result("c1", "search_patterns", {
    results: [{ patternId: "p-books", title: "Reading list", score: 0.82 }],
  }),
  call("c2", "run_pattern", { sourceText: "export default () => {}" }),
  result("c2", "run_pattern", {
    status: "compile-error",
    message: "TS2304: Cannot find name 'recipe'",
  }),
  call("c3", "run_pattern", {
    sourceText: "export default recipe(...)",
    inputs: { books: "handle:1" },
  }),
  result("c3", "run_pattern", { status: "ok", pieceId: "piece-9" }),
  call("c4", "assign_slug", { slug: "books" }),
  result("c4", "assign_slug", {
    slug: "books",
    url: "http://localhost:8000/my-space/books",
  }),
  call("c5", "record_feedback", { patternId: "p-books", event: "success" }),
  result("c5", "record_feedback", { status: "ok" }),
];

describe("kickoff/runs", () => {
  describe("kickoffRunLens()", () => {
    it("keeps every run_pattern attempt, so the fix rounds stay visible", () => {
      const lens = kickoffRunLens(buildTranscript());
      expect(lens.patternAttempts.map((attempt) => attempt.status)).toEqual([
        "compile-error",
        "ok",
      ]);
      expect(lens.patternAttempts[0].message).toBe(
        "TS2304: Cannot find name 'recipe'",
      );
      expect(lens.patternAttempts[1].source).toBe("export default recipe(...)");
      expect(lens.patternAttempts[1].inputNames).toEqual(["books"]);
      expect(lens.patternAttempts[1].pieceId).toBe("piece-9");
    });

    it("reads the index calls and the address a person can open", () => {
      const lens = kickoffRunLens(buildTranscript());
      expect(lens.searches[0].query).toBe("reading list");
      expect(lens.searches[0].hits[0]).toEqual({
        patternId: "p-books",
        title: "Reading list",
        score: 0.82,
      });
      expect(lens.feedback[0].event).toBe("success");
      expect(lens.pieces[0].url).toBe("http://localhost:8000/my-space/books");
    });

    it("reports a call whose result did not parse rather than dropping it", () => {
      const lens = kickoffRunLens([
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", "the sandbox died mid-write"),
      ]);
      expect(lens.patternAttempts).toHaveLength(1);
      expect(lens.patternAttempts[0].status).toBe("unknown");
    });
  });

  describe("summarizeKickoffRun()", () => {
    it("titles a run by the last thing a person asked it", () => {
      const summary = summarizeKickoffRun(
        runState("r1", "2026-01-01T00:00:01.000Z"),
        [
          { role: "user", content: "first task" },
          { role: "assistant", content: "done" },
          { role: "user", content: "now add a total" },
        ],
      );
      expect(summary.title).toBe("now add a total");
    });

    it("carries every piece the run named", () => {
      const summary = summarizeKickoffRun(
        runState("r1", "2026-01-01T00:00:01.000Z"),
        buildTranscript(),
      );
      expect(summary.pieceUrls).toEqual([
        "http://localhost:8000/my-space/books",
      ]);
    });
  });

  describe("the run store", () => {
    const withArtifactRoot = async (
      body: (root: string) => Promise<void>,
    ): Promise<void> => {
      const root = await Deno.makeTempDir();
      try {
        await body(root);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    };

    const writeRun = async (
      root: string,
      runId: string,
      updatedAt: string,
    ): Promise<void> => {
      const runRoot = join(root, runId);
      await Deno.mkdir(join(runRoot, "tool-outputs"), { recursive: true });
      await Deno.writeTextFile(
        join(runRoot, "run-state.json"),
        JSON.stringify(runState(runId, updatedAt)),
      );
      await Deno.writeTextFile(
        join(runRoot, "transcript.json"),
        JSON.stringify(buildTranscript()),
      );
      await Deno.writeTextFile(
        join(runRoot, "tool-outputs", `${runId}_run_pattern-2.json`),
        JSON.stringify({ status: "ok" }),
      );
      await Deno.writeTextFile(
        join(runRoot, "tool-outputs", `${runId}_run_pattern-10.json`),
        JSON.stringify({ status: "ok" }),
      );
    };

    it("lists runs most recently touched first", async () => {
      await withArtifactRoot(async (root) => {
        await writeRun(root, "older", "2026-01-01T00:00:01.000Z");
        await writeRun(root, "newer", "2026-01-01T00:00:02.000Z");
        const runs = await listKickoffRuns(root);
        expect(runs.map((run) => run.runId)).toEqual(["newer", "older"]);
      });
    });

    it("is empty rather than failing when no run has been made", async () => {
      await withArtifactRoot(async (root) => {
        expect(await listKickoffRuns(join(root, "absent"))).toEqual([]);
      });
    });

    it("reads a run whole, with its tool outputs in call order", async () => {
      await withArtifactRoot(async (root) => {
        await writeRun(root, "r1", "2026-01-01T00:00:01.000Z");
        const detail = await readKickoffRun(root, "r1");
        expect(detail?.lens.patternAttempts).toHaveLength(2);
        expect(detail?.artifactNames).toEqual([
          "run-state.json",
          "transcript.json",
        ]);
        expect(detail?.toolOutputNames).toEqual([
          "r1_run_pattern-2.json",
          "r1_run_pattern-10.json",
        ]);
      });
    });

    it("reads one tool output untruncated", async () => {
      await withArtifactRoot(async (root) => {
        await writeRun(root, "r1", "2026-01-01T00:00:01.000Z");
        expect(
          await readKickoffToolOutput(root, "r1", "r1_run_pattern-2.json"),
        ).toBe(JSON.stringify({ status: "ok" }));
      });
    });

    it("refuses a run id or artifact name that escapes the run tree", async () => {
      await withArtifactRoot(async (root) => {
        await writeRun(root, "r1", "2026-01-01T00:00:01.000Z");
        expect(await readKickoffRun(root, "../..")).toBeUndefined();
        expect(await readKickoffRun(root, "a/b")).toBeUndefined();
        expect(
          await readKickoffToolOutput(root, "r1", "../transcript.json"),
        ).toBeUndefined();
        expect(
          await readKickoffRunArtifact(root, "r1", "../transcript.json"),
        ).toBeUndefined();
      });
    });

    it("reads only the artifact names a run is known to write", async () => {
      await withArtifactRoot(async (root) => {
        await writeRun(root, "r1", "2026-01-01T00:00:01.000Z");
        expect(
          await readKickoffRunArtifact(root, "r1", "run-state.json"),
        ).toContain('"runId":"r1"');
        await Deno.writeTextFile(join(root, "r1", "secret.json"), "{}");
        expect(
          await readKickoffRunArtifact(root, "r1", "secret.json"),
        ).toBeUndefined();
      });
    });
  });
});
