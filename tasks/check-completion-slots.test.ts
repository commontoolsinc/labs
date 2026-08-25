import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Command } from "@cliffy/command";
import {
  collectSlots,
  describeFailures,
  main,
  NO_CANDIDATES,
  NO_OPTION_CANDIDATES,
  reportSlots,
  type SlotReport,
} from "./check-completion-slots.ts";

/** A small tree in the shape the CLI's own is: nested commands, each with its
 * own options and positionals. */
function fixtureTree() {
  return new Command()
    .name("cf")
    .option("--space <space:string>", "a space")
    .option("--quiet", "no value, so not a slot")
    .command("piece", new Command().description("piece things"))
    .command(
      "get",
      new Command()
        .description("read")
        .option("--select <fields:string>", "a projection")
        .arguments("<path:string>"),
    );
}

/**
 * One option name meaning two things on two commands, as `--from` does: a
 * snapshot file on `space clone` and a sequence number on `inspect diff`.
 */
function twoMeaningsTree() {
  return new Command()
    .name("cf")
    .command(
      "clone",
      new Command().description("copy a space")
        .option("--from <file:string>", "a snapshot file"),
    )
    .command(
      "diff",
      new Command().description("compare two revisions")
        .option("--from <n:number>", "a sequence number"),
    );
}

/** The report for a tree, told about `known`. */
function reportFor(known: {
  /** Option name -> the commands its provider answers on, `null` for all. */
  providerOptions?: Record<string, readonly string[] | null>;
  providerArguments?: string[];
  enumerated?: string[];
  allowedOptions?: string[];
  allowedPositionals?: string[];
  // deno-lint-ignore no-explicit-any
}, tree: Command<any> = fixtureTree()): SlotReport {
  return reportSlots(collectSlots(tree), {
    providerOptions: new Map(Object.entries(known.providerOptions ?? {})),
    providerArguments: new Set(known.providerArguments ?? []),
    enumerated: new Set(known.enumerated ?? []),
    allowedOptions: new Set(known.allowedOptions ?? []),
    allowedPositionals: new Set(known.allowedPositionals ?? []),
  });
}

/** `providerOptions` for names whose provider answers on every command. */
function everywhere(...names: string[]): Record<string, null> {
  return Object.fromEntries(names.map((name) => [name, null]));
}

describe("check-completion-slots", () => {
  describe("collectSlots()", () => {
    it("names a value-taking option by its long name and where it was found", () => {
      const { options } = collectSlots(fixtureTree());
      expect(options.get("space")).toEqual(["<root>"]);
      expect(options.get("select")).toEqual(["get"]);
    });

    it("returns no entry for an option that takes no value", () => {
      // A flag has nothing to complete, so it is not a slot.
      expect(collectSlots(fixtureTree()).options.has("quiet")).toBe(false);
    });

    it("keys a positional by its command path and argument name", () => {
      expect(collectSlots(fixtureTree()).positionals).toEqual([
        { key: "get:path", where: "get" },
      ]);
    });
  });

  describe("reportSlots()", () => {
    it("names an option with no provider, no enumerated set and no allowance", () => {
      const report = reportFor({});
      expect(report.undecidedOptions).toEqual([
        "--select  (get)",
        "--space  (<root>)",
      ]);
    });

    it("returns no finding for an option a provider answers", () => {
      expect(
        reportFor({ providerOptions: everywhere("space", "select") })
          .undecidedOptions,
      )
        .toEqual([]);
    });

    it("returns no finding for an option an enumerated set answers", () => {
      expect(
        reportFor({
          providerOptions: everywhere("space"),
          enumerated: ["select"],
        })
          .undecidedOptions,
      ).toEqual([]);
    });

    it("returns no finding for an option the allowlist records a reason for", () => {
      expect(
        reportFor({
          providerOptions: everywhere("space"),
          allowedOptions: ["select"],
        })
          .undecidedOptions,
      ).toEqual([]);
    });

    it("names the commands a scoped provider does not answer on", () => {
      // A provider restricted to one command answers nothing on the other, so
      // the slot there is as silent as one with no entry at all.
      expect(
        reportFor({ providerOptions: { from: ["clone"] } }, twoMeaningsTree())
          .undecidedOptions,
      ).toEqual(["--from  (diff)"]);
    });

    it("takes no bare allowance for an option a provider answers somewhere", () => {
      // `--from` has candidates on `clone`, so a bare allowance saying it has
      // none is false wherever it is read; the other command needs its own.
      const bare = reportFor(
        { providerOptions: { from: ["clone"] }, allowedOptions: ["from"] },
        twoMeaningsTree(),
      );
      expect(bare.undecidedOptions).toEqual(["--from  (diff)"]);
      expect(bare.staleAllowlist).toEqual(["--from"]);

      const scoped = reportFor(
        { providerOptions: { from: ["clone"] }, allowedOptions: ["diff:from"] },
        twoMeaningsTree(),
      );
      expect(scoped.undecidedOptions).toEqual([]);
      expect(scoped.staleAllowlist).toEqual([]);
    });

    it("names a positional with no provider and no allowance", () => {
      expect(reportFor({}).undecidedPositionals).toEqual(["get:path"]);
      expect(
        reportFor({ providerArguments: ["get:path"] }).undecidedPositionals,
      )
        .toEqual([]);
      expect(
        reportFor({ allowedPositionals: ["get:path"] }).undecidedPositionals,
      )
        .toEqual([]);
    });

    it("names a provider entry that matches no slot on the tree", () => {
      // The same subtraction the other way: this is what found `log-file` and
      // `state-path`, which belonged to commands declaring no Cliffy options.
      expect(
        reportFor({
          providerOptions: everywhere("log-file"),
          providerArguments: ["x:y"],
        })
          .unreachableProviders,
      ).toEqual(["--log-file", "x:y"]);
    });

    it("names a command a scoped provider claims and the tree does not", () => {
      // A scope naming a command that never declared the option is the same
      // dead entry, one level down.
      expect(
        reportFor(
          { providerOptions: { from: ["clone", "pull"] } },
          twoMeaningsTree(),
        ).unreachableProviders,
      ).toEqual(["--from  (pull)"]);
    });

    it("names an allowlist entry that decides no slot", () => {
      // A decision cannot outlive the thing it was about.
      expect(
        reportFor({ allowedOptions: ["gone"], allowedPositionals: ["gone:x"] })
          .staleAllowlist,
      ).toEqual(["--gone", "gone:x"]);
    });

    it("names an allowance for a slot a provider already answers", () => {
      // Two records of one decision, disagreeing: the provider offers
      // candidates the allowance says are not there.
      expect(
        reportFor({
          providerOptions: everywhere("select"),
          allowedOptions: ["get:select"],
        }).staleAllowlist,
      ).toEqual(["--select  (get)"]);
    });
  });

  describe("describeFailures()", () => {
    it("returns nothing when the report is empty", () => {
      expect(describeFailures(reportFor({
        providerOptions: everywhere("space", "select"),
        providerArguments: ["get:path"],
      }))).toEqual([]);
    });

    it("names the table to edit for each kind of finding", () => {
      const text = describeFailures(reportFor({})).join("\n");
      expect(text).toContain("NO_OPTION_CANDIDATES");
      expect(text).toContain("NO_CANDIDATES");
    });
  });

  describe("main()", () => {
    it("returns 0 for the CLI's own command tree", () => {
      // The gate itself. Every slot the CLI declares is answered by a provider,
      // by an enumerated set, or by an allowlist entry carrying its reason.
      expect(main()).toBe(0);
    });

    it("records a reason for every allowance, so none is a bare exemption", () => {
      // Trimmed, because a blank reason and a spaces-only one exempt a slot
      // just as silently.
      for (const [key, reason] of [...NO_CANDIDATES, ...NO_OPTION_CANDIDATES]) {
        expect(reason.trim().length, `${key} has no reason`).toBeGreaterThan(0);
      }
    });
  });
});
