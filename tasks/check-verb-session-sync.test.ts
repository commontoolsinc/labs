/**
 * These pin the walkthrough↔demo sync check to the three drift classes it
 * exists to catch, each of which shipped at least once: a composed command
 * the demo never runs (one was wrong from the day it was written and
 * survived four editing passes), an act reference gone stale under
 * renumbering (twice), and a shape-table row pairing a verb with an act that
 * no longer shows it.
 *
 * The real files are checked too, so the gate's green on this repository is
 * itself a pinned fact — and so is the check's grip: each class is asserted
 * by injecting one violation into the real walkthrough and watching it
 * surface.
 */

import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  actReferences,
  commandMatches,
  DEMO_PATH,
  demoActs,
  demoCommands,
  findViolations,
  joinContinuations,
  main,
  tokenize,
  WALKTHROUGH_PATH,
  walkthroughCommands,
} from "./check-verb-session-sync.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

describe("check-verb-session-sync", () => {
  let sh = "";
  let md = "";
  beforeAll(async () => {
    sh = await Deno.readTextFile(join(REPO_ROOT, DEMO_PATH));
    md = await Deno.readTextFile(join(REPO_ROOT, WALKTHROUGH_PATH));
  });

  describe("tokenize", () => {
    it("keeps a quoted span as one token without its quotes", () => {
      expect(
        tokenize(`cf call --select 'item@' addItem -- --title "Login rewrite"`),
      )
        .toEqual([
          "cf",
          "call",
          "--select",
          "item@",
          "addItem",
          "--",
          "--title",
          "Login rewrite",
        ]);
    });
  });

  describe("joinContinuations", () => {
    it("folds a backslash-continued line into its successor", () => {
      expect(joinContinuations("a \\\nb\nc")).toEqual(["a  b", "c"]);
    });

    it("keeps a continuation the text ends on", () => {
      expect(joinContinuations("a \\")).toEqual(["a  "]);
    });
  });

  describe("demoCommands", () => {
    it("extracts a command out of an assignment's substitution", () => {
      expect(demoCommands(`X=$(cf piece get --piece a title | jq -r .)`))
        .toEqual([["cf", "piece", "get", "--piece", "a", "title"]]);
    });
  });

  describe("commandMatches", () => {
    it("returns true across variable and placeholder tokens", () => {
      expect(commandMatches(
        tokenize(`cf call "$EPIC" blockOn -- --on "$OTHER"`),
        tokenize(`cf call <cookies-address> blockOn -- --on <csrf-address>`),
      )).toBe(true);
    });

    it("returns false for a differing literal token", () => {
      expect(commandMatches(
        tokenize("cf get --piece board items"),
        tokenize("cf get --piece board title"),
      )).toBe(false);
    });

    it("returns false when the token counts differ", () => {
      expect(commandMatches(
        tokenize("cf get --piece board"),
        tokenize("cf get --piece board items"),
      )).toBe(false);
    });
  });

  describe("extraction from the real files", () => {
    it("collects a double-digit command count from the demo", () => {
      expect(demoCommands(sh).length).toBeGreaterThanOrEqual(10);
    });

    it("collects walkthrough commands and act references", () => {
      expect(walkthroughCommands(md).length).toBeGreaterThanOrEqual(5);
      expect(actReferences(md).length).toBeGreaterThanOrEqual(5);
    });

    it("maps every demo act number to a nonempty section", () => {
      const acts = demoActs(sh);
      expect(acts.size).toBeGreaterThanOrEqual(13);
      for (const body of acts.values()) expect(body.length).toBeGreaterThan(0);
    });
  });

  describe("findViolations", () => {
    it("returns nothing for the repository's own files", () => {
      expect(findViolations(sh, md)).toEqual([]);
    });

    it("catches a composed command the demo does not run", () => {
      // The historical case: read options drifting behind the `--`, where
      // they become the verb's arguments and the command stops working.
      const broken = md.replace(
        "cf call --piece board --select 'item@' addItem -- \\",
        "cf call --piece board addItem -- --select 'item@' \\",
      );
      expect(broken).not.toEqual(md);
      const found = findViolations(sh, broken);
      expect(found.length).toBeGreaterThanOrEqual(1);
      expect(found[0]).toContain("a command the demo does not run");
    });

    it("catches an act reference the demo does not have", () => {
      // The first "act 12" in the walkthrough, wherever it sits, renumbered
      // past the demo's range.
      const stale = md.replace("act 12", "act 99");
      expect(stale).not.toEqual(md);
      const found = findViolations(sh, stale);
      expect(found.some((v) => v.includes("act 99"))).toBe(true);
    });

    it("catches a shape-table row paired with the wrong act", () => {
      const mispaired = md.replace("| act 9 |", "| act 3 |");
      expect(mispaired).not.toEqual(md);
      expect(findViolations(sh, mispaired).length).toBeGreaterThanOrEqual(1);
    });

    it("lets an exempted line differ from every demo command", () => {
      const block = [
        "```bash",
        "# not in the demo — synthetic case for this test",
        "cf frobnicate --nothing-like-this",
        "```",
      ].join("\n");
      expect(findViolations(sh, block)).toEqual([]);
    });

    it("returns 0 through main() for the repository's own files", async () => {
      const lines: string[] = [];
      expect(await main({ log: (l) => lines.push(l) })).toBe(0);
      expect(lines.length).toBe(1);
    });

    it("returns 1 through main() when the walkthrough composes", async () => {
      const mdPath = await Deno.makeTempFile({ suffix: ".md" });
      try {
        await Deno.writeTextFile(
          mdPath,
          "```bash\ncf frobnicate --nothing-like-this\n```\n",
        );
        const errors: string[] = [];
        expect(await main({ mdPath, error: (l) => errors.push(l) })).toBe(1);
        expect(errors.length).toBeGreaterThanOrEqual(2);
      } finally {
        await Deno.remove(mdPath);
      }
    });

    it("does not let a reasonless marker exempt anything", () => {
      const block = [
        "```bash",
        "# not in the demo",
        "cf frobnicate --nothing-like-this",
        "```",
      ].join("\n");
      expect(findViolations(sh, block).length).toBe(1);
    });

    it("still flags the line after an exemption is spent", () => {
      const block = [
        "```bash",
        "# not in the demo — covers only the next line",
        "cf frobnicate --nothing-like-this",
        "cf also-not-a-command",
        "```",
      ].join("\n");
      expect(findViolations(sh, block).length).toBe(1);
    });
  });
});
