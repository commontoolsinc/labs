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
  call("c1", "search_patterns", { text: "reading list", tags: ["#books"] }),
  result("c1", "search_patterns", {
    outputId: "r1:search_patterns:1",
    status: "ok",
    results: [
      {
        patternId: "p-books",
        description: "Reading list",
        hashtags: ["#books"],
        importHint: "#books/p-books",
        signals: { uses: 4, score: 0.82 },
      },
    ],
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
  call("c5", "record_feedback", { patternId: "p-books", verdict: "up" }),
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
      expect(lens.searches[0].query).toBe("reading list #books");
      expect(lens.searches[0].hits[0]).toEqual({
        patternId: "p-books",
        description: "Reading list",
        score: 0.82,
      });
      expect(lens.feedback[0].verdict).toBe("up");
      expect(lens.pieces[0].url).toBe("http://localhost:8000/my-space/books");
    });

    it("names a search made on tags alone by its tags", () => {
      const lens = kickoffRunLens([
        call("c1", "search_patterns", { tags: ["#books", "#reading"] }),
        result("c1", "search_patterns", { status: "ok", results: [] }),
      ]);
      expect(lens.searches[0].query).toBe("#books #reading");
    });

    it("leaves a hit the index ranked no signal for without a score", () => {
      const lens = kickoffRunLens([
        call("c1", "search_patterns", { text: "books" }),
        result("c1", "search_patterns", {
          status: "ok",
          results: [{ patternId: "p-books", description: "Reading list" }],
        }),
      ]);
      expect(lens.searches[0].hits[0]).toEqual({
        patternId: "p-books",
        description: "Reading list",
      });
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

    /** A tool-output file named the way the artifact store names one. */
    const toolOutputName = (
      runId: string,
      toolId: string,
      sequence: number,
    ): string => `${runId}_${toolId}_${sequence}-${toolId}.json`;

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
      // Two tools, and a run long enough that the tenth call would sort before
      // the second on the digits alone.
      for (
        const [toolId, sequence] of [
          ["search_patterns", 1],
          ["run_pattern", 2],
          ["run_pattern", 10],
        ] as const
      ) {
        await Deno.writeTextFile(
          join(
            runRoot,
            "tool-outputs",
            toolOutputName(runId, toolId, sequence),
          ),
          JSON.stringify({ status: "ok" }),
        );
      }
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
        // The order the calls were made in, not the order their tools sort in.
        expect(detail?.toolOutputNames).toEqual([
          "r1_search_patterns_1-search_patterns.json",
          "r1_run_pattern_2-run_pattern.json",
          "r1_run_pattern_10-run_pattern.json",
        ]);
      });
    });

    it("lists a tool-output name of another shape after every call", async () => {
      await withArtifactRoot(async (root) => {
        await writeRun(root, "r1", "2026-01-01T00:00:01.000Z");
        await Deno.writeTextFile(
          join(root, "r1", "tool-outputs", "unnumbered.json"),
          "{}",
        );
        const detail = await readKickoffRun(root, "r1");
        expect(detail?.toolOutputNames.at(-1)).toBe("unnumbered.json");
      });
    });

    it("reads one tool output untruncated", async () => {
      await withArtifactRoot(async (root) => {
        await writeRun(root, "r1", "2026-01-01T00:00:01.000Z");
        expect(
          await readKickoffToolOutput(
            root,
            "r1",
            "r1_run_pattern_2-run_pattern.json",
          ),
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
