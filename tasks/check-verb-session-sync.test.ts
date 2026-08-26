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
  TOUR_PATH,
  WALKTHROUGH_PATH,
  walkthroughCommands,
} from "./check-verb-session-sync.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

describe("check-verb-session-sync", () => {
  let sh = "";
  let md = "";
  let tour = "";
  beforeAll(async () => {
    sh = await Deno.readTextFile(join(REPO_ROOT, DEMO_PATH));
    md = await Deno.readTextFile(join(REPO_ROOT, WALKTHROUGH_PATH));
    tour = await Deno.readTextFile(join(REPO_ROOT, TOUR_PATH));
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

    it("collects an act reference whatever its case", () => {
      expect(actReferences("Act 12, then act 13").map((r) => r.act))
        .toEqual([12, 13]);
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
      // The first "act 12" in the tour, wherever it sits, renumbered past the
      // demo's range. The tour carries the act narrative; the walkthrough
      // references acts too, and either would exercise this.
      const stale = tour.replace("act 12", "act 99");
      expect(stale).not.toEqual(tour);
      const found = findViolations(sh, stale, TOUR_PATH);
      expect(found.some((v) => v.includes("act 99"))).toBe(true);
    });

    it("catches a shape-table row paired with the wrong act", () => {
      // The verb shape table lives in the tour, beside the fixture it
      // describes.
      const mispaired = tour.replace("| act 9 |", "| act 3 |");
      expect(mispaired).not.toEqual(tour);
      expect(findViolations(sh, mispaired, TOUR_PATH).length)
        .toBeGreaterThanOrEqual(1);
    });

    it("checks a console transcript, not only a bash block", () => {
      const block = [
        "```console",
        "$ cf frobnicate --nothing-like-this",
        "```",
      ].join("\n");
      expect(findViolations(sh, block).length).toBe(1);
    });

    it("drops an -s space pair before matching a transcript command", () => {
      // A transcript shows the space it really ran against; the demo passes
      // its own. Without the drop these differ by two tokens and no command
      // in a transcript would ever match.
      const block = [
        "```console",
        "$ cf get -s demo $EPIC children --select @,title",
        "```",
      ].join("\n");
      expect(findViolations(sh, block)).toEqual([]);
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

    it("holds a document to the demo shPath names", async () => {
      // The pairing is the injectable unit: the same document is a violation
      // against the default demo and clean against the demo that runs it.
      const dir = await Deno.makeTempDir();
      try {
        const mdPath = `${dir}/tour.md`;
        const shPath = `${dir}/demo.sh`;
        await Deno.writeTextFile(
          mdPath,
          "```bash\ncf frobnicate --nothing-like-this\n```\n",
        );
        await Deno.writeTextFile(
          shPath,
          "#!/usr/bin/env bash\nrun cf frobnicate --nothing-like-this\n",
        );
        const lines: string[] = [];
        expect(await main({ mdPath, shPath, log: (l) => lines.push(l) }))
          .toBe(0);
        expect(await main({ mdPath, error: () => {} })).toBe(1);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("refuses a demo that names no document to check against it", async () => {
      // Silently ignoring it would leave the caller believing the run used
      // the demo they passed.
      await expect(main({ shPath: "/nowhere/demo.sh" })).rejects.toThrow(
        /pass both/,
      );
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
