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

/** The report for `fixtureTree()`, told about `known`. */
function reportFor(known: {
  providerOptions?: string[];
  providerArguments?: string[];
  enumerated?: string[];
  allowedOptions?: string[];
  allowedPositionals?: string[];
}): SlotReport {
  return reportSlots(collectSlots(fixtureTree()), {
    providerOptions: new Set(known.providerOptions ?? []),
    providerArguments: new Set(known.providerArguments ?? []),
    enumerated: new Set(known.enumerated ?? []),
    allowedOptions: new Set(known.allowedOptions ?? []),
    allowedPositionals: new Set(known.allowedPositionals ?? []),
  });
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
        reportFor({ providerOptions: ["space", "select"] }).undecidedOptions,
      )
        .toEqual([]);
    });

    it("returns no finding for an option an enumerated set answers", () => {
      expect(
        reportFor({ providerOptions: ["space"], enumerated: ["select"] })
          .undecidedOptions,
      ).toEqual([]);
    });

    it("returns no finding for an option the allowlist records a reason for", () => {
      expect(
        reportFor({ providerOptions: ["space"], allowedOptions: ["select"] })
          .undecidedOptions,
      ).toEqual([]);
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
        reportFor({ providerOptions: ["log-file"], providerArguments: ["x:y"] })
          .unreachableProviders,
      ).toEqual(["--log-file", "x:y"]);
    });

    it("names an allowlist entry that matches no slot on the tree", () => {
      // A decision cannot outlive the thing it was about.
      expect(
        reportFor({ allowedOptions: ["gone"], allowedPositionals: ["gone:x"] })
          .staleAllowlist,
      ).toEqual(["--gone", "gone:x"]);
    });
  });

  describe("describeFailures()", () => {
    it("returns nothing when the report is empty", () => {
      expect(describeFailures(reportFor({
        providerOptions: ["space", "select"],
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
      for (const [key, reason] of [...NO_CANDIDATES, ...NO_OPTION_CANDIDATES]) {
        expect(reason.length, `${key} has no reason`).toBeGreaterThan(0);
      }
    });
  });
});
