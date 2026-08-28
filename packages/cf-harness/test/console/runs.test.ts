import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { consoleRunLens, summarizeConsoleRun } from "../../console/runs.ts";
import {
  listConsoleRuns,
  readConsoleRun,
  readConsoleRunArtifact,
  readConsoleRunFlow,
  readConsoleToolOutput,
} from "../../console/run-store.ts";
import { createHarnessRunState } from "../../src/run-state.ts";
import type { HarnessTranscriptMessage } from "../../src/contracts/transcript.ts";
import {
  HARNESS_CELL_LABELS_TYPE,
  type HarnessCellLabels,
} from "../../src/contracts/cell-labels.ts";
import {
  HARNESS_HANDLE_TABLE_TYPE,
  type HarnessHandleTable,
} from "../../src/contracts/handle-table.ts";

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

/** A snapshot the space was read for, naming one cell it labels. */
const labelSnapshot = (entityId = "of:fid1:abc"): HarnessCellLabels => ({
  type: HARNESS_CELL_LABELS_TYPE,
  version: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  status: "read",
  space: { configured: "my-space" },
  cells: [
    {
      entityId,
      ref: `/${entityId}`,
      entries: [
        {
          path: [],
          confidentiality: [
            { type: "https://common.tools/cfc/Secret", name: "Secret" },
          ],
          integrity: [],
          origin: "declared",
        },
      ],
    },
  ],
});

/** The same cell, under a reader that ran out of nodes partway through it. */
const truncatedLabelSnapshot = (
  entityId = "of:fid1:abc",
): HarnessCellLabels => ({
  ...labelSnapshot(entityId),
  cells: [
    {
      entityId,
      ref: `/${entityId}`,
      entries: [],
      truncationReason: "node-budget-exhausted",
    },
  ],
});

/** The same cell, read through and found to carry no label. */
const bareLabelSnapshot = (entityId = "of:fid1:abc"): HarnessCellLabels => ({
  ...labelSnapshot(entityId),
  cells: [{ entityId, ref: `/${entityId}`, entries: [] }],
});

/** A snapshot taken on a host that holds no copy of the run's space. */
const unreadSnapshot = (): HarnessCellLabels => ({
  type: HARNESS_CELL_LABELS_TYPE,
  version: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  status: "unavailable",
  unavailableReason: "space-not-found",
  unavailableDetail: "no space database for my-space on this host",
  space: { configured: "my-space" },
  cells: [],
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

describe("console/runs", () => {
  describe("consoleRunLens()", () => {
    it("keeps every run_pattern attempt, so the fix rounds stay visible", () => {
      const lens = consoleRunLens(buildTranscript());
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
      const lens = consoleRunLens(buildTranscript());
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
      const lens = consoleRunLens([
        call("c1", "search_patterns", { tags: ["#books", "#reading"] }),
        result("c1", "search_patterns", { status: "ok", results: [] }),
      ]);
      expect(lens.searches[0].query).toBe("#books #reading");
    });

    it("leaves a hit the index ranked no signal for without a score", () => {
      const lens = consoleRunLens([
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
      const lens = consoleRunLens([
        call("c1", "run_pattern", { sourceText: "x" }),
        result("c1", "run_pattern", "the sandbox died mid-write"),
      ]);
      expect(lens.patternAttempts).toHaveLength(1);
      expect(lens.patternAttempts[0].status).toBe("unknown");
    });
  });

  describe("summarizeConsoleRun()", () => {
    it("titles a run by the last thing a person asked it", () => {
      const summary = summarizeConsoleRun(
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
      const summary = summarizeConsoleRun(
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
      cellLabels?: HarnessCellLabels,
    ): Promise<void> => {
      const runRoot = join(root, runId);
      await Deno.mkdir(join(runRoot, "tool-outputs"), { recursive: true });
      await Deno.writeTextFile(
        join(runRoot, "run-state.json"),
        JSON.stringify(runState(runId, updatedAt)),
      );
      if (cellLabels !== undefined) {
        await Deno.writeTextFile(
          join(runRoot, "cell-labels.json"),
          JSON.stringify(cellLabels),
        );
      }
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
        const runs = await listConsoleRuns(root);
        expect(runs.map((run) => run.runId)).toEqual(["newer", "older"]);
      });
    });

    it("is empty rather than failing when no run has been made", async () => {
      await withArtifactRoot(async (root) => {
        expect(await listConsoleRuns(join(root, "absent"))).toEqual([]);
      });
    });

    it("reads a run whole, with its tool outputs in call order", async () => {
      await withArtifactRoot(async (root) => {
        await writeRun(root, "r1", "2026-01-01T00:00:01.000Z");
        const detail = await readConsoleRun(root, "r1");
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
        const detail = await readConsoleRun(root, "r1");
        expect(detail?.toolOutputNames.at(-1)).toBe("unnumbered.json");
      });
    });

    it("reads one tool output untruncated", async () => {
      await withArtifactRoot(async (root) => {
        await writeRun(root, "r1", "2026-01-01T00:00:01.000Z");
        expect(
          await readConsoleToolOutput(
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
        expect(await readConsoleRun(root, "../..")).toBeUndefined();
        expect(await readConsoleRun(root, "a/b")).toBeUndefined();
        expect(
          await readConsoleToolOutput(root, "r1", "../transcript.json"),
        ).toBeUndefined();
        expect(
          await readConsoleRunArtifact(root, "r1", "../transcript.json"),
        ).toBeUndefined();
      });
    });

    it("reports no label snapshot for a run that wrote none", async () => {
      await withArtifactRoot(async (root) => {
        await writeRun(root, "r1", "2026-01-01T00:00:01.000Z");
        const detail = await readConsoleRun(root, "r1");
        // Nobody asked the space, which is not a space with nothing to say.
        expect(detail?.cellLabels.status).toBe("absent");
        expect(detail?.cellLabels.cellsRead).toBe(0);
      });
    });

    it("reads the label snapshot a run wrote, and offers it as an artifact", async () => {
      await withArtifactRoot(async (root) => {
        await writeRun(
          root,
          "r1",
          "2026-01-01T00:00:01.000Z",
          labelSnapshot(),
        );
        const detail = await readConsoleRun(root, "r1");
        expect(detail?.cellLabels.status).toBe("read");
        expect(detail?.cellLabels.cellsRead).toBe(1);
        expect(detail?.cellLabels.cellsLabelled).toBe(1);
        expect(detail?.cellLabels.space?.configured).toBe("my-space");
        expect(detail?.artifactNames).toContain("cell-labels.json");
      });
    });

    /**
     * A run of a family: the cells it minted, and the snapshot it recorded
     * for them. A run with no refs minted no cell, so it never records one.
     */
    const writeMember = async (
      root: string,
      runId: string,
      options: {
        refs?: readonly string[];
        cellLabels?: HarnessCellLabels;
      } = {},
    ): Promise<void> => {
      const runRoot = join(root, runId);
      await Deno.mkdir(runRoot, { recursive: true });
      const handleTable: HarnessHandleTable = {
        type: HARNESS_HANDLE_TABLE_TYPE,
        version: 1,
        salt: runId,
        entries: (options.refs ?? []).map((ref, index) => ({
          token: `cfh:a:abcd${index + 2}`,
          kind: "address",
          ref,
          addressKey: ref,
        })),
      };
      await Deno.writeTextFile(
        join(runRoot, "run-state.json"),
        JSON.stringify({
          ...runState(runId, "2026-01-01T00:00:01.000Z"),
          handleTable,
        }),
      );
      if (options.cellLabels !== undefined) {
        await Deno.writeTextFile(
          join(runRoot, "cell-labels.json"),
          JSON.stringify(options.cellLabels),
        );
      }
    };

    /** What the map's header states about the space, for the family of `runId`. */
    const familyCellLabels = async (root: string, runId: string) =>
      (await readConsoleRunFlow(root, runId))?.cellLabels;

    it("counts the cells of every run in a family that read its space", async () => {
      await withArtifactRoot(async (root) => {
        await writeMember(root, "r1", {
          refs: ["/of:fid1:abc"],
          cellLabels: labelSnapshot("of:fid1:abc"),
        });
        await writeMember(root, "r1.subagent.0", {
          refs: ["/of:fid1:def"],
          cellLabels: labelSnapshot("of:fid1:def"),
        });

        expect(await familyCellLabels(root, "r1")).toMatchObject({
          status: "read",
          cellsRead: 2,
          cellsLabelled: 2,
        });
      });
    });

    it("refuses to read a child whose space went unread under the root's status", async () => {
      await withArtifactRoot(async (root) => {
        await writeMember(root, "r1", {
          refs: ["/of:fid1:abc"],
          cellLabels: labelSnapshot("of:fid1:abc"),
        });
        await writeMember(root, "r1.subagent.0", {
          refs: ["/of:fid1:def"],
          cellLabels: unreadSnapshot(),
        });

        // The root's `read` would say the child's cells carry no label; they
        // are cells nobody asked about.
        expect(await familyCellLabels(root, "r1")).toMatchObject({
          status: "unavailable",
          detail: "the runs in this family disagree: 1 read, 1 unavailable",
        });
      });
    });

    it("refuses to read a child that read its space under the root's absent snapshot", async () => {
      await withArtifactRoot(async (root) => {
        await writeMember(root, "r1", { refs: ["/of:fid1:abc"] });
        await writeMember(root, "r1.subagent.0", {
          refs: ["/of:fid1:def"],
          cellLabels: labelSnapshot("of:fid1:def"),
        });

        // The root's `absent` would say nobody asked about the child's cell,
        // and the child's own snapshot says what the space holds for it.
        expect(await familyCellLabels(root, "r1")).toMatchObject({
          status: "unavailable",
          detail: "the runs in this family disagree: 1 read, 1 absent",
          cellsRead: 1,
          cellsLabelled: 1,
        });
      });
    });

    it("leaves a run that minted no cell out of the family's reading", async () => {
      await withArtifactRoot(async (root) => {
        await writeMember(root, "r1", {
          refs: ["/of:fid1:abc"],
          cellLabels: labelSnapshot("of:fid1:abc"),
        });
        // A child with no cell of its own takes no snapshot, which is not a
        // reading of the space to disagree with.
        await writeMember(root, "r1.subagent.0");

        expect(await familyCellLabels(root, "r1")).toMatchObject({
          status: "read",
          cellsRead: 1,
        });
      });
    });

    it("counts a cell as partial when the root did not finish reading it", async () => {
      await withArtifactRoot(async (root) => {
        await writeMember(root, "r1", {
          refs: ["/of:fid1:abc"],
          cellLabels: truncatedLabelSnapshot("of:fid1:abc"),
        });
        await writeMember(root, "r1.subagent.0", {
          refs: ["/of:fid1:abc"],
          cellLabels: labelSnapshot("of:fid1:abc"),
        });

        // The child read the cell whole; the root did not finish it. Counting
        // the child's reading alone would state the cell as fully read.
        expect(await familyCellLabels(root, "r1")).toMatchObject({
          status: "read",
          cellsRead: 1,
          cellsLabelled: 1,
          cellsPartial: 1,
        });
      });
    });

    it("counts a cell as partial when a child did not finish reading it", async () => {
      await withArtifactRoot(async (root) => {
        await writeMember(root, "r1", {
          refs: ["/of:fid1:abc"],
          cellLabels: labelSnapshot("of:fid1:abc"),
        });
        await writeMember(root, "r1.subagent.0", {
          refs: ["/of:fid1:abc"],
          cellLabels: truncatedLabelSnapshot("of:fid1:abc"),
        });

        // The same two readings, met in the other order, and the same answer:
        // the fold is a union, so which member arrives first cannot matter.
        expect(await familyCellLabels(root, "r1")).toMatchObject({
          status: "read",
          cellsRead: 1,
          cellsLabelled: 1,
          cellsPartial: 1,
        });
      });
    });

    it("reports a cell no member found a label for as unlabelled", async () => {
      await withArtifactRoot(async (root) => {
        await writeMember(root, "r1", {
          refs: ["/of:fid1:abc"],
          cellLabels: bareLabelSnapshot("of:fid1:abc"),
        });
        await writeMember(root, "r1.subagent.0", {
          refs: ["/of:fid1:abc"],
          cellLabels: bareLabelSnapshot("of:fid1:abc"),
        });

        // Both read it through and neither found an entry, which is a cell
        // the space holds no label for rather than one nobody finished.
        expect(await familyCellLabels(root, "r1")).toMatchObject({
          status: "read",
          cellsRead: 1,
          cellsLabelled: 0,
          cellsPartial: 0,
        });
      });
    });

    it("reads only the artifact names a run is known to write", async () => {
      await withArtifactRoot(async (root) => {
        await writeRun(root, "r1", "2026-01-01T00:00:01.000Z");
        expect(
          await readConsoleRunArtifact(root, "r1", "run-state.json"),
        ).toContain('"runId":"r1"');
        await Deno.writeTextFile(join(root, "r1", "secret.json"), "{}");
        expect(
          await readConsoleRunArtifact(root, "r1", "secret.json"),
        ).toBeUndefined();
      });
    });
  });
});
