/**
 * Unit tests for `callFromCommand`, the `cf call` action. Every input is an
 * ordinary argument — the command's own arguments, the line past `cf call`,
 * and the words past `--` included — so each case drives the whole action over
 * a stub dispatcher, and what the assertions turn on is what the action built
 * from the argv: the arguments it handed the callable, the target it resolved,
 * the projection it read past the marker, the wait control it derived, the
 * phases it announced, and the outcome it rendered. No runtime, no socket, and
 * no server stands behind any of it.
 *
 * The bound on that: the two failure exits end the process, so the cases here
 * are the ones that return or that raise a `ValidationError`, which
 * `exitPieceCallFailure` rethrows for Cliffy's usage rendering rather than
 * exiting on.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { ValidationError } from "@cliffy/command";

import {
  callFromCommand,
  type PieceCallCLIOptions,
  type PieceCallCommandDependencies,
} from "../commands/piece.ts";
import type {
  ExecutedPieceCallable,
  executePieceCallable,
  PieceCallableDependencies,
  PieceConfig,
} from "../lib/piece.ts";
import { captureStderr } from "./utils.ts";

const SPACE = "did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk";
const PIECE = "fid1:call-from-command-piece";

/** A target written in the canonical reference form a positional takes. */
const ADDRESS = "/of:fid1:baedreiabcdefghijklmnopqrstuvwxyz0123456789";

/** What {@link ADDRESS} names once the reference form is stripped off it. */
const ADDRESSED_PIECE = "of:fid1:baedreiabcdefghijklmnopqrstuvwxyz0123456789";

/** A callable whose own name is written in the shape a reference takes. */
const ROOTED_CALLABLE = "/archive";

/** The pair `--invocation` and `--invocation-session` name. */
const INVOCATION = "inv:call-from-command";
const SESSION = "ses:call-from-command";

/**
 * The flags every case starts from: a reachable-looking target and a named
 * invocation, so the identity a case asserts on is the one it wrote rather
 * than a minted one.
 */
const options: PieceCallCLIOptions = {
  apiUrl: "http://localhost:8000",
  identity: "/nonexistent/keyfile",
  space: SPACE,
  cell: PIECE,
  invocation: INVOCATION,
  invocationSession: SESSION,
};

/** One dispatch the action asked the stub for. */
interface Dispatch {
  config: PieceConfig;
  callableName: string;
  rawArgs: string[];
  deps: PieceCallableDependencies;
}

/**
 * A dispatcher that records what it was asked for and hands back `outcome`.
 * `phases` are announced through the observer the action supplied, in order,
 * before it returns.
 */
function stubExecutor(
  dispatches: Dispatch[],
  outcome: Partial<ExecutedPieceCallable> = {},
  phases: readonly ("dispatched" | "committed")[] = [],
): typeof executePieceCallable {
  return (config, callableName, rawArgs, deps = {}) => {
    dispatches.push({ config, callableName, rawArgs, deps });
    for (const phase of phases) deps.onPhase?.(phase);
    return Promise.resolve(
      {
        parsed: { usedJsonInput: false },
        resolved: {},
        ...outcome,
      } as ExecutedPieceCallable,
    );
  };
}

/** A dispatcher that fails with `error` rather than recording anything. */
function failingExecutor(error: unknown): typeof executePieceCallable {
  return () => Promise.reject(error);
}

/**
 * Sinks for a case whose subject is the dispatch rather than the output, so
 * the confirmation and its next steps stay out of the test transcript.
 */
const discard: PieceCallCommandDependencies = {
  render: () => {},
  hint: () => {},
};

/** Collects what the action wrote to stdout and to the hint stream. */
function sinks(): {
  deps: PieceCallCommandDependencies;
  rendered: string[];
  hinted: string[];
} {
  const rendered: string[] = [];
  const hinted: string[] = [];
  return {
    deps: {
      render: (value: unknown) => {
        rendered.push(String(value));
      },
      hint: (message: string) => {
        hinted.push(message);
      },
    },
    rendered,
    hinted,
  };
}

describe("callFromCommand()", () => {
  describe("the callable's section", () => {
    it("hands the words the verb opened the section for to the callable", async () => {
      const dispatches: Dispatch[] = [];
      await callFromCommand(
        options,
        "call",
        "search",
        ["--query", "milk"],
        ["--cell", PIECE, "search", "--query", "milk"],
        [],
        { ...discard, executePieceCallable: stubExecutor(dispatches) },
      );
      expect(dispatches.length).toBe(1);
      expect(dispatches[0].callableName).toBe("search");
      expect(dispatches[0].rawArgs).toEqual(["--query", "milk"]);
    });

    it("takes a lone positional payload as the callable's JSON input", async () => {
      // `--json` on the callable's side is also what tells the command its
      // stdout is machine-read, so it rides the piece config as well.
      const dispatches: Dispatch[] = [];
      await callFromCommand(
        options,
        "call",
        "addItem",
        ['{"title":"Milk"}'],
        ["--cell", PIECE, "addItem", '{"title":"Milk"}'],
        [],
        { ...discard, executePieceCallable: stubExecutor(dispatches) },
      );
      expect(dispatches[0].rawArgs).toEqual(["--json", '{"title":"Milk"}']);
      expect(dispatches[0].config.jsonOutput).toBe(true);
    });

    it("puts a marker-routed `--help` where the callable's parser reads it", async () => {
      const dispatches: Dispatch[] = [];
      const { deps, rendered } = sinks();
      await callFromCommand(
        options,
        "call",
        "addItem",
        [],
        ["--cell", PIECE, "addItem", "--", "--help"],
        ["--help"],
        {
          ...deps,
          executePieceCallable: stubExecutor(dispatches, {
            helpText: "usage",
          }),
        },
      );
      expect(dispatches[0].rawArgs).toEqual(["--help"]);
      expect(rendered).toEqual(["usage"]);
    });
  });

  describe("the read step's section", () => {
    it("shapes the result with a projection written past the marker", async () => {
      const dispatches: Dispatch[] = [];
      await callFromCommand(
        options,
        "call",
        "addItem",
        [],
        ["--cell", PIECE, "addItem", "--", "--select", "title"],
        ["--select", "title"],
        { ...discard, executePieceCallable: stubExecutor(dispatches) },
      );
      expect(dispatches[0].deps.selection?.projection?.source).toBe("title");
      expect(dispatches[0].deps.selection?.projection?.flag).toBe("--select");
    });

    it("throws for a projection written before the verb, and dispatches nothing", async () => {
      // The refusal reprints the caller's own line, so it needs the raw
      // arguments rather than the parsed flags: a parsed value has lost which
      // of the two spellings they wrote it in.
      const dispatches: Dispatch[] = [];
      await expect(
        callFromCommand(
          { ...options, select: "topic.title" },
          "call",
          "addTopic",
          [],
          ["--cell", PIECE, "--select", "topic.title", "addTopic"],
          [],
          { executePieceCallable: stubExecutor(dispatches) },
        ),
      ).rejects.toThrow(
        `write:    cf call --cell ${PIECE} addTopic -- --select topic.title`,
      );
      expect(dispatches).toEqual([]);
    });

    it("throws for a word past the marker that names no read option", async () => {
      const dispatches: Dispatch[] = [];
      await expect(
        callFromCommand(
          options,
          "call",
          "search",
          [],
          ["--cell", PIECE, "search", "--", "--query", "milk"],
          ["--query", "milk"],
          { executePieceCallable: stubExecutor(dispatches) },
        ),
      ).rejects.toThrow(/"--query" is not a read option/);
      expect(dispatches).toEqual([]);
    });

    it("throws for a projection past the marker beside `--no-wait`, and dispatches nothing", async () => {
      // A projection is answered from the receipt a detached exit never
      // reads, and it arrives from past the marker rather than on the
      // options object, so the wait control has to be resolved against both.
      const dispatches: Dispatch[] = [];
      await expect(
        callFromCommand(
          { ...options, wait: false },
          "call",
          "addTopic",
          [],
          ["--cell", PIECE, "--no-wait", "addTopic", "--", "--select", "t"],
          ["--select", "t"],
          { executePieceCallable: stubExecutor(dispatches) },
        ),
      ).rejects.toThrow(/receipt readback that --no-wait skips/);
      expect(dispatches).toEqual([]);
    });
  });

  describe("the readback flags", () => {
    it("asks the dispatch for the link annotation under `--show-links`", async () => {
      const dispatches: Dispatch[] = [];
      await callFromCommand(
        { ...options, showLinks: true },
        "call",
        "addItem",
        [],
        ["--cell", PIECE, "--show-links", "addItem"],
        [],
        { ...discard, executePieceCallable: stubExecutor(dispatches) },
      );
      expect(dispatches[0].deps.showLinks).toBe(true);
    });
  });

  describe("the target", () => {
    it("dispatches against the piece the flags name", async () => {
      const dispatches: Dispatch[] = [];
      await callFromCommand(
        options,
        "call",
        "addItem",
        [],
        ["--cell", PIECE, "addItem"],
        [],
        { ...discard, executePieceCallable: stubExecutor(dispatches) },
      );
      expect(dispatches[0].config.piece).toBe(PIECE);
      expect(dispatches[0].config.space).toBe(SPACE);
    });

    it("takes a leading canonical address as the target, with the callable behind it", async () => {
      const dispatches: Dispatch[] = [];
      const { cell: _cell, ...addressed } = options;
      await callFromCommand(
        addressed,
        "call",
        ADDRESS,
        ["addItem"],
        [ADDRESS, "addItem"],
        [],
        { ...discard, executePieceCallable: stubExecutor(dispatches) },
      );
      expect(dispatches[0].config.piece).toBe(ADDRESSED_PIECE);
      expect(dispatches[0].callableName).toBe("addItem");
    });

    it("takes a rooted positional as the callable name when the flag names the target", async () => {
      // Nothing reserves the shape of a callable name, so a verb may be
      // called `/archive`. Writing the flag is the only spelling that
      // reaches one: it names the target, leaving the positional to be read
      // as the name.
      const dispatches: Dispatch[] = [];
      await callFromCommand(
        options,
        "call",
        ROOTED_CALLABLE,
        [],
        ["--cell", PIECE, ROOTED_CALLABLE],
        [],
        { ...discard, executePieceCallable: stubExecutor(dispatches) },
      );
      expect(dispatches[0].config.piece).toBe(PIECE);
      expect(dispatches[0].callableName).toBe(ROOTED_CALLABLE);
    });
  });

  describe("the invocation", () => {
    it("carries the invocation pair the flags named into the dispatch", async () => {
      const dispatches: Dispatch[] = [];
      await callFromCommand(
        options,
        "call",
        "addItem",
        [],
        ["--cell", PIECE, "addItem"],
        [],
        { ...discard, executePieceCallable: stubExecutor(dispatches) },
      );
      expect(dispatches[0].deps.invocation).toEqual({
        id: INVOCATION,
        session: SESSION,
      });
    });

    it("names the mount in the help-page prefix the callable renders", async () => {
      // A mount no `cf` command answers to, so the prefix can carry it only
      // by reading the parameter. The one production spelling is `call`,
      // which an implementation ignoring the parameter would print too.

      const dispatches: Dispatch[] = [];
      await callFromCommand(
        options,
        "summon",
        "addItem",
        ["--help"],
        ["--cell", PIECE, "addItem", "--help"],
        [],
        {
          ...discard,
          executePieceCallable: stubExecutor(dispatches, { helpText: "usage" }),
        },
      );
      expect(dispatches[0].deps.helpCommandPrefix).toBe(
        "cf summon ... addItem",
      );
    });
  });

  describe("the wait control", () => {
    it("skips the receipt readback under `--no-wait`", async () => {
      const dispatches: Dispatch[] = [];
      await callFromCommand(
        { ...options, wait: false },
        "call",
        "addItem",
        [],
        ["--cell", PIECE, "--no-wait", "addItem"],
        [],
        {
          ...discard,
          executePieceCallable: stubExecutor(dispatches, {
            invocation: { id: INVOCATION, status: "committed" },
          }),
        },
      );
      expect(dispatches[0].deps.skipReadback).toBe(true);
    });

    it("throws for `--await` beside `--no-wait`, and dispatches nothing", async () => {
      const dispatches: Dispatch[] = [];
      await expect(
        callFromCommand(
          { ...options, await: true, wait: false },
          "call",
          "addItem",
          [],
          ["--cell", PIECE, "--await", "--no-wait", "addItem"],
          [],
          { executePieceCallable: stubExecutor(dispatches) },
        ),
      ).rejects.toThrow(/--await and --no-wait contradict each other/);
      expect(dispatches).toEqual([]);
    });
  });

  describe("the outcome", () => {
    it("writes a settled handler's Invocation JSON with the next steps beside it", async () => {
      const dispatches: Dispatch[] = [];
      const { deps, rendered, hinted } = sinks();
      await callFromCommand(
        options,
        "call",
        "addItem",
        [],
        ["--cell", PIECE, "addItem"],
        [],
        {
          ...deps,
          executePieceCallable: stubExecutor(dispatches, {
            invocation: {
              id: INVOCATION,
              status: "settled",
              result: { title: "Milk" },
            },
          }),
        },
      );
      expect(JSON.parse(rendered[0])).toEqual({
        invocation: INVOCATION,
        status: "settled",
        result: { title: "Milk" },
      });
      expect(hinted[0]).toContain(`cf get --cell ${PIECE}`);
    });

    it("reports the detached call's recovery beside the receipt it published", async () => {
      const dispatches: Dispatch[] = [];
      const { deps, rendered, hinted } = sinks();
      await callFromCommand(
        { ...options, wait: false },
        "call",
        "addItem",
        [],
        ["--cell", PIECE, "--no-wait", "addItem"],
        [],
        {
          ...deps,
          executePieceCallable: stubExecutor(dispatches, {
            invocation: {
              id: INVOCATION,
              status: "committed",
              receipt: "/of:receipt-1",
            },
          }),
        },
      );
      expect(JSON.parse(rendered[0]).status).toBe("committed");
      expect(hinted[0]).toContain("/of:receipt-1");
      expect(hinted[0]).toContain(`CF_INVOCATION_SESSION=${SESSION} cf call`);
    });

    it("writes a tool's output and nothing else to stdout", async () => {
      const dispatches: Dispatch[] = [];
      const { deps, rendered } = sinks();
      await callFromCommand(
        options,
        "call",
        "search",
        [],
        ["--cell", PIECE, "search"],
        [],
        {
          ...deps,
          executePieceCallable: stubExecutor(dispatches, {
            outputText: '{"found":1}',
          }),
        },
      );
      expect(rendered).toEqual(['{"found":1}']);
    });

    it("throws a dispatch's usage failure out to Cliffy rather than exiting", async () => {
      await expect(
        callFromCommand(
          options,
          "call",
          "addItem",
          [],
          ["--cell", PIECE, "addItem"],
          [],
          {
            executePieceCallable: failingExecutor(
              new ValidationError("no such callable"),
            ),
          },
        ),
      ).rejects.toThrow(/no such callable/);
    });
  });

  describe("the phase report", () => {
    it("announces the invocation pair on stderr as the dispatch happens", async () => {
      // The id and the session are what a caller whose process dies past
      // this line retries with, so both are announced before any network
      // work rather than reported with the outcome.
      const dispatches: Dispatch[] = [];
      const lines = await captureStderr(() =>
        callFromCommand(
          options,
          "call",
          "addItem",
          [],
          ["--cell", PIECE, "addItem"],
          [],
          {
            ...discard,
            executePieceCallable: stubExecutor(dispatches, {}, [
              "dispatched",
              "committed",
            ]),
          },
        )
      );
      expect(lines).toContain(`invocation: ${INVOCATION}`);
      expect(lines).toContain(`session: ${SESSION}`);
    });

    it("streams one span per phase transition under `--verbose`", async () => {
      const dispatches: Dispatch[] = [];
      const lines = await captureStderr(() =>
        callFromCommand(
          { ...options, verbose: true },
          "call",
          "addItem",
          [],
          ["--cell", PIECE, "--verbose", "addItem"],
          [],
          {
            ...discard,
            executePieceCallable: stubExecutor(dispatches, {}, [
              "dispatched",
              "committed",
            ]),
          },
        )
      );
      const spans = lines.filter((line) => line.startsWith("timing: "))
        .map((line) => line.replace(/ [\d.]+ms$/, ""));
      expect(spans).toEqual([
        "timing: initial_sync → dispatched",
        "timing: dispatched → committed",
        "timing: committed → settled",
      ]);
    });

    it("writes no span without `--verbose`", async () => {
      const dispatches: Dispatch[] = [];
      const lines = await captureStderr(() =>
        callFromCommand(
          options,
          "call",
          "addItem",
          [],
          ["--cell", PIECE, "addItem"],
          [],
          {
            ...discard,
            executePieceCallable: stubExecutor(dispatches, {}, ["dispatched"]),
          },
        )
      );
      expect(lines.filter((line) => line.startsWith("timing: "))).toEqual([]);
    });
  });
});
