import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { HarnessAssistantTranscriptMessage } from "../src/contracts/transcript.ts";
import {
  CRITERIA,
  type JudgedPair,
  judgePair,
  LIMITS,
  materialOf,
  median,
  pairPrompt,
  pairRuns,
  RUBRIC,
  type Score,
  selectRuns,
  spread,
  summarise,
  summaryTable,
  unblind,
  VERDICT_TOOL,
  verdictOf,
  winnerOf,
} from "../scripts/want-eval/shape-rubric.ts";
import {
  defaultHarnessHome,
  defaultRunsRoot,
} from "../scripts/want-eval/runs.ts";

/** Every criterion at `score`, as a judge would write it. */
const side = (score: number) =>
  Object.fromEntries(
    CRITERIA.map((key) => [key, { score, reason: `${key} ${score}` }]),
  );

/** A judge's reply: `args` as the arguments of one call to `tool`. */
const called = (
  args: unknown,
  tool = "submit_verdict",
): HarnessAssistantTranscriptMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{
    id: "call-1",
    type: "function",
    function: { name: tool, arguments: JSON.stringify(args) },
  }],
});

const reply = (a: number, b: number, winner: string) =>
  called({ A: side(a), B: side(b), winner, reason: "because" });

/** The deleted parse: the reply's text from its first `{` to its last `}`. */
const sliceParse = (text: string): unknown =>
  JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));

describe("shape-rubric", () => {
  describe("verdictOf", () => {
    it("reads the verdict from the submit_verdict call's arguments", () => {
      const verdict = verdictOf(reply(2, 4, "B"));

      expect(verdict.winner).toBe("B");
      expect(verdict.A.substance).toEqual({ score: 2, reason: "substance 2" });
      expect(verdict.B.fit.score).toBe(4);
      expect(verdict.reason).toBe("because");
    });

    it("reads a reason with quotes and braces exactly, where slicing the text broke", () => {
      // What a live judge wrote: a reason quoting a run, quotes and braces
      // and all. Typed into prose, they are not JSON; as tool arguments, the
      // provider encodes them.
      const reason =
        'B says "nothing on {Tuesday}" but its read shows {"events": 2}} } {';
      const verdict = verdictOf(
        called({ A: side(3), B: side(2), winner: "A", reason }),
      );
      expect(verdict.reason).toBe(reason);

      const typed = `Verdict: {"A": ${JSON.stringify(side(3))}, "B": ${
        JSON.stringify(side(2))
      }, "winner": "A", "reason": "${reason}"}`;
      expect(() => sliceParse(typed)).toThrow(SyntaxError);
    });

    it("refuses a reply with no submit_verdict call, even one with a verdict in its text", () => {
      const text = JSON.stringify({
        A: side(3),
        B: side(3),
        winner: "tie",
        reason: "",
      });
      expect(() => verdictOf({ role: "assistant", content: text })).toThrow(
        "expected one submit_verdict call, got 0",
      );
      expect(() => verdictOf(called(JSON.parse(text), "other_tool"))).toThrow(
        "got 0",
      );
    });

    it("refuses arguments the tool's schema refuses", () => {
      const a = side(3);
      delete a.honest;
      expect(() =>
        verdictOf(called({ A: a, B: side(3), winner: "tie", reason: "" }))
      ).toThrow();
      expect(() => verdictOf(reply(0, 3, "B"))).toThrow();
      expect(() => verdictOf(reply(6, 3, "B"))).toThrow();
      expect(() => verdictOf(reply(2.5, 3, "B"))).toThrow();
      expect(() => verdictOf(reply(3, 3, "both"))).toThrow();
      expect(() =>
        verdictOf(
          called({ A: side(3), B: side(3), winner: "tie", reason: "", x: 1 }),
        )
      ).toThrow();
      expect(() => verdictOf(reply(3, 3, "tie"))).not.toThrow();
    });

    it("offers the verdict tool by the name the prompt asks for", () => {
      expect(VERDICT_TOOL.toolId).toBe("submit_verdict");
      expect(
        pairPrompt("ask", { answer: "", pages: [], reads: [] }, {
          answer: "",
          pages: [],
          reads: [],
        }),
      ).toContain("calling submit_verdict");
    });
  });

  describe("pairPrompt", () => {
    it("carries the ask, both runs under neutral labels, and every criterion", () => {
      const prompt = pairPrompt(
        "Plan my week",
        { answer: "first answer", pages: [], reads: [] },
        {
          answer: "second answer",
          pages: [{ path: "Plan.md", content: "# The plan" }],
          reads: ["- calendar.read"],
        },
      );

      expect(prompt).toContain("The ask: Plan my week");
      expect(prompt).toMatch(/Run A[^]*first answer[^]*Run B[^]*second answer/);
      expect(prompt).toContain("--- Plan.md ---\n# The plan");
      for (const line of Object.values(RUBRIC)) expect(prompt).toContain(line);
      expect(prompt).not.toMatch(/\bdeep\b|\bdefault\b|\bquick\b/);
    });
  });

  describe("pairRuns", () => {
    it("pairs the i-th run of each shape per case and leaves extras and other shapes out", () => {
      const runs = [
        { case: "a", variant: "default", job: "d1" },
        { case: "a", variant: "deep", job: "p1" },
        { case: "a", variant: "default", job: "d2" },
        { case: "a", variant: "deep", job: "p2" },
        { case: "a", variant: "deep", job: "p3" },
        { case: "a", variant: "quick", job: "q1" },
        { case: "b", variant: "default", job: "d3" },
      ];

      expect(
        pairRuns(runs, "default", "deep").map((pair) =>
          `${pair.case}:${pair.first.job}-${pair.second.job}`
        ),
      ).toEqual(["a:d1-p1", "a:d2-p2"]);
    });
  });

  describe("median and spread", () => {
    it("takes the middle value, or the mean of the middle two", () => {
      expect(median([30, 10, 20])).toBe(20);
      expect(median([40, 10, 30, 20])).toBe(25);
      expect(spread([30, 10, 20])).toEqual({ min: 10, max: 30 });
    });

    it("refuses an empty list", () => {
      expect(() => median([])).toThrow();
      expect(() => spread([])).toThrow();
    });
  });

  describe("unblind", () => {
    it("reads A and B back to the shapes they were shown for", () => {
      const verdict = verdictOf(reply(2, 5, "B"));

      const shownFirst = unblind(verdict, true);
      expect(shownFirst.winner).toBe("second");
      expect(shownFirst.second.answers.score).toBe(5);

      const shownSecond = unblind(verdict, false);
      expect(shownSecond.winner).toBe("first");
      expect(shownSecond.first.answers.score).toBe(5);

      expect(unblind(verdictOf(reply(3, 3, "tie")), false).winner).toBe(
        "tie",
      );
    });
  });

  describe("materialOf", () => {
    const call = (id: string, name: string, args: unknown) => ({
      role: "assistant",
      toolCalls: [{
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      }],
    });
    const result = (id: string, content: string) => ({
      role: "tool",
      toolCallId: id,
      content,
    });
    const written = JSON.stringify({
      status: "executed",
      outcome: { ok: true, bodyBytes: 2 },
    });

    it("takes page.write as pages and every other call as a read with its result, across subagents", () => {
      const root = [
        { role: "user", content: "ask" },
        call("1", "web_fetch", { url: "https://example.org/a" }),
        result("1", "fetched   text"),
        call("2", "run_command", {
          command: "page.write",
          args: { path: "Research/A.md", content: "# A page" },
        }),
        result("2", written),
        call("3", "run_command", { command: "loom.compose", args: {} }),
        result("3", "composed"),
        call("4", "submit_result", { result: {} }),
      ];
      const subagent = [
        call("1", "loom_search", { query: "dentist" }),
        result("1", "two rows"),
      ];

      const material = materialOf("tile", [root, subagent]);

      expect(material.answer).toBe("tile");
      expect(material.pages).toEqual([
        { path: "Research/A.md", content: "# A page" },
      ]);
      expect(material.reads).toHaveLength(3);
      expect(material.reads[0]).toContain("web_fetch");
      expect(material.reads[0]).toContain("https://example.org/a");
      expect(material.reads[0]).toContain("→ fetched text");
      expect(material.reads[1]).toContain("loom.compose");
      expect(material.reads[2]).toContain("dentist");
      expect(material.reads[2]).toContain("two rows");
      expect(material.reads.join("\n")).not.toContain("submit_result");
    });

    it("shows a page.write that failed or got no answer as a call with its result, not a page", () => {
      const write = (id: string, path: string) =>
        call(id, "run_command", {
          command: "page.write",
          args: { path, content: `# ${path}` },
        });
      const material = materialOf("tile", [[
        write("1", "Refused.md"),
        result(
          "1",
          JSON.stringify({
            status: "executed",
            outcome: { ok: false, code: "version_conflict", bodyBytes: 9 },
          }),
        ),
        write("2", "Lost.md"),
        result(
          "2",
          JSON.stringify({
            status: "failed_to_deliver",
            code: "unavailable",
            landed: "unknown",
          }),
        ),
        write("3", "Unanswered.md"),
        write("4", "Written.md"),
        result("4", written),
      ]]);

      expect(material.pages).toEqual([
        { path: "Written.md", content: "# Written.md" },
      ]);
      expect(material.reads).toHaveLength(3);
      expect(material.reads[0]).toContain("version_conflict");
      expect(material.reads[1]).toContain("failed_to_deliver");
      expect(material.reads[2]).toContain("(no result)");
    });

    it("counts a host-supplied result with no call, such as opening research, as a read", () => {
      const material = materialOf("tile", [[
        { role: "user", content: "ask" },
        {
          role: "user",
          content: "Host opening research handoff: cells notify readers",
          toolResultProvenance: { source: "research" },
        },
        call("1", "web_fetch", { url: "https://example.org" }),
        { ...result("1", "page"), toolResultProvenance: { source: "web" } },
      ]]);

      expect(material.reads).toHaveLength(2);
      expect(material.reads[0]).toContain("host-supplied");
      expect(material.reads[0]).toContain("cells notify readers");
      expect(material.reads[1]).toContain("web_fetch");
    });

    it("clips a long page and stops listing reads past the limit", () => {
      const long = "x".repeat(LIMITS.page + 10);
      const reads = Array.from(
        { length: 100 },
        (_, index) => [
          call(`${index}`, "web_fetch", { url: `https://e.org/${index}` }),
          result(`${index}`, "y".repeat(LIMITS.readResult)),
        ],
      ).flat();
      const material = materialOf("", [[
        call("p", "run_command", {
          command: "page.write",
          args: { path: "P.md", content: long },
        }),
        result("p", written),
        ...reads,
      ]]);

      expect(material.pages[0].content).toHaveLength(
        LIMITS.page + " …[clipped]".length,
      );
      expect(material.reads.length).toBeLessThan(100);
      expect(material.reads.at(-1)).toBe("- …[further reads clipped]");
      expect(
        material.reads.filter((line) => line.includes("further reads")),
      ).toHaveLength(1);
    });

    it("refuses a transcript that is not a list", () => {
      expect(() => materialOf("", [{ role: "user" }])).toThrow("transcript");
    });
  });

  describe("summarise", () => {
    const scores = (score: number) => {
      const one: Score = { score, reason: "" };
      return {
        answers: one,
        substance: one,
        grounded: one,
        honest: one,
        fit: one,
      };
    };
    type Winner = "first" | "second" | "tie";
    const reading = (
      winner: Winner,
      first: number,
      second: number,
      firstWasA: boolean,
    ) => ({
      first: scores(first),
      second: scores(second),
      winner,
      reason: "",
      firstWasA,
    });

    /** A pair read in both orders, the second reading's winner `again`. */
    const pair = (
      winner: Winner,
      first: number,
      second: number,
      again: Winner = winner,
    ): JudgedPair => ({
      case: "a",
      firstJob: "d",
      secondJob: "p",
      verdicts: [
        reading(winner, first, second, true),
        reading(again, first, second, false),
      ],
      errors: [],
    });

    it("gives median tokens per shape, the pair record, and mean scores", () => {
      const runs = [
        { case: "a", variant: "default", totalTokens: 100 },
        { case: "a", variant: "default", totalTokens: 300 },
        { case: "a", variant: "default", totalTokens: 200 },
        { case: "a", variant: "deep", totalTokens: 400 },
        { case: "a", variant: "deep", totalTokens: 500 },
        { case: "b", variant: "default", totalTokens: 50 },
      ];
      const [summary, ...rest] = summarise(
        runs,
        [
          pair("second", 3, 5),
          pair("second", 3, 3),
          pair("first", 4, 3),
          pair("second", 3, 4, "first"),
          {
            case: "a",
            firstJob: "d",
            secondJob: "p",
            verdicts: [],
            errors: ["x", "x"],
          },
        ],
        "default",
        "deep",
      );

      expect(rest).toEqual([]);
      expect(summary.tokens.first).toEqual({
        median: 200,
        min: 100,
        max: 300,
        n: 3,
      });
      expect(summary.tokens.second.median).toBe(450);
      expect(summary.ratio).toBe(2.25);
      expect(summary.wins).toEqual({
        first: 1,
        second: 2,
        tie: 0,
        split: 1,
        failed: 1,
      });
      expect(summary.scores?.second.answers).toBe(3.75);
      expect(summary.better).toBe("second");

      const table = summaryTable([summary], "default", "deep");
      expect(table).toContain(
        "| a | 200 (100–300, n=3) | 450 (400–500, n=2) | 2.3 | 2 / 1 / 0 / 1 (1 failed) | 16.3 | 18.8 | answers +0.5 | deep |",
      );
    });

    it("calls a case even when wins and losses balance", () => {
      const runs = [
        { case: "a", variant: "default", totalTokens: 1 },
        { case: "a", variant: "deep", totalTokens: 2 },
      ];

      expect(
        summarise(
          runs,
          [pair("first", 4, 3), pair("second", 3, 4)],
          "default",
          "deep",
        )[0].better,
      ).toBe("even");
    });

    it("counts a pair read in only one order as failed, not as a win", () => {
      const runs = [
        { case: "a", variant: "default", totalTokens: 1 },
        { case: "a", variant: "deep", totalTokens: 2 },
      ];
      const halfRead: JudgedPair = {
        ...pair("second", 3, 5),
        verdicts: [reading("second", 3, 5, true)],
        errors: ["expected one submit_verdict call, got 0"],
      };

      expect(winnerOf(halfRead)).toBeUndefined();
      expect(winnerOf(pair("second", 3, 5))).toBe("second");
      expect(
        summarise(runs, [halfRead, pair("first", 4, 3)], "default", "deep")[0]
          .wins,
      ).toEqual({ first: 1, second: 0, tie: 0, split: 0, failed: 1 });
    });

    it("leaves scores out, rather than zero, when no pair was read", () => {
      const runs = [
        { case: "a", variant: "default", totalTokens: 1 },
        { case: "a", variant: "deep", totalTokens: 2 },
      ];
      const [summary] = summarise(
        runs,
        [{
          case: "a",
          firstJob: "d",
          secondJob: "p",
          verdicts: [],
          errors: ["x"],
        }],
        "default",
        "deep",
      );

      expect(summary.scores).toBeUndefined();
      expect(summaryTable([summary], "default", "deep")).toContain(
        "| 0 / 0 / 0 / 0 (1 failed) | - | - | - | even |",
      );
    });
  });
});

describe("selectRuns", () => {
  const runs = [
    { case: "a", variant: "default", state: "completed" },
    { case: "a", variant: "deep", state: "completed" },
    { case: "a", variant: "deep", state: "failed" },
    { case: "b", variant: "deep", state: "completed", measured: false },
  ];

  it("keeps completed, measured runs of the case asked for", () => {
    expect(selectRuns(runs, { first: "default", second: "deep" })).toEqual(
      runs.slice(0, 2),
    );
    expect(
      selectRuns(runs, { only: "a", first: "default", second: "deep" }),
    ).toEqual(runs.slice(0, 2));
  });

  it("refuses a case or shape no run has, rather than judging nothing", () => {
    expect(() =>
      selectRuns(runs, { only: "zzz", first: "default", second: "deep" })
    ).toThrow("--only zzz");
    expect(() => selectRuns(runs, { first: "defualt", second: "deep" }))
      .toThrow("--first defualt");
    expect(() => selectRuns(runs, { first: "default", second: "quick" }))
      .toThrow("--second quick");
  });

  it("refuses the same shape as --first and --second, which would pair a run with itself", () => {
    expect(() => selectRuns(runs, { first: "deep", second: "deep" }))
      .toThrow("--first and --second are both deep");
  });

  it("refuses shapes that never meet in one case, which would pair nothing", () => {
    const apart = [
      { case: "a", variant: "default", state: "completed" },
      { case: "b", variant: "deep", state: "completed" },
    ];
    expect(() => selectRuns(apart, { first: "default", second: "deep" }))
      .toThrow("no case has both --first default and --second deep");
  });
});

describe("judgePair", () => {
  const pair = {
    case: "a",
    first: { job: "d" },
    second: { job: "p" },
  };
  const material = { answer: "x", pages: [], reads: [] };
  const verdictReply = (winner: string): HarnessAssistantTranscriptMessage => ({
    role: "assistant",
    content: "",
    toolCalls: [{
      id: "c",
      type: "function",
      function: {
        name: "submit_verdict",
        arguments: JSON.stringify({
          A: side(3),
          B: side(4),
          winner,
          reason: "r",
        }),
      },
    }],
  });

  it("reads the pair in both orders and hands every reply over", async () => {
    const replies: unknown[] = [];
    const judged = await judgePair(pair, "ask", {
      material: () => Promise.resolve(material),
      turn: () => Promise.resolve(verdictReply("B")),
      onReply: (reply) => replies.push(reply),
      repliesFile: "r.json",
    });

    expect(judged.errors).toEqual([]);
    expect(judged.verdicts.map((v) => [v.firstWasA, v.winner])).toEqual([
      [true, "second"],
      [false, "first"],
    ]);
    expect(replies).toHaveLength(2);
  });

  it("records a run record that would not load as that pair's error", async () => {
    const judged = await judgePair(pair, "ask", {
      material: (run) =>
        run.job === "p"
          ? Promise.reject(new Error("no artifacts for p"))
          : Promise.resolve(material),
      turn: () => Promise.reject(new Error("must not be asked")),
      onReply: () => {},
      repliesFile: "r.json",
    });

    expect(judged.verdicts).toEqual([]);
    expect(judged.errors).toEqual([
      "could not read the runs: no artifacts for p",
    ]);
    expect(winnerOf(judged)).toBeUndefined();
  });

  it("records a case missing from the cases file as that pair's error", async () => {
    const judged = await judgePair(pair, undefined, {
      material: () => Promise.resolve(material),
      turn: () => Promise.resolve(verdictReply("A")),
      onReply: () => {},
      repliesFile: "r.json",
    });

    expect(judged.errors).toEqual(["no case a in the cases"]);
  });

  it("names the saved reply when a reply carries no verdict", async () => {
    const replies: unknown[] = [];
    const judged = await judgePair(pair, "ask", {
      material: () => Promise.resolve(material),
      turn: () => Promise.resolve({ role: "assistant", content: "B wins" }),
      onReply: (reply) => replies.push(reply),
      repliesFile: "r.json",
    });

    expect(judged.errors).toHaveLength(2);
    expect(judged.errors[0]).toContain("got 0");
    expect(judged.errors[0]).toContain("reply saved in r.json");
    expect(replies).toHaveLength(2);
  });
});

describe("defaultHarnessHome", () => {
  it("is CF_HARNESS_HOME when set, and the runs root sits under it", () => {
    const was = Deno.env.get("CF_HARNESS_HOME");
    Deno.env.set("CF_HARNESS_HOME", "/tmp/elsewhere");
    try {
      expect(defaultHarnessHome()).toBe("/tmp/elsewhere");
      expect(defaultRunsRoot()).toBe("/tmp/elsewhere/agent-runs/local");
    } finally {
      if (was === undefined) Deno.env.delete("CF_HARNESS_HOME");
      else Deno.env.set("CF_HARNESS_HOME", was);
    }
  });
});
