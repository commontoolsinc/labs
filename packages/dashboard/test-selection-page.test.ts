/**
 * Covers the page behind the two selection tiles: what it says about a
 * manifest, and what it says when there is not one.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type Manifest,
  sampleEntry,
  sampleManifest,
} from "@commonfabric/test-support/records";

import {
  FLAKY_SECTION_ID,
  testSelectionPage,
} from "./test-selection-page.ts";
import {
  FLAKE_EXCLUSION_FALLBACK,
  FLAKE_WINDOW_FALLBACK_DAYS,
  LANE_BUDGET_FALLBACK_SECONDS,
} from "./test-selection-manifest.ts";

const NOW = Date.parse("2026-08-20T04:00:00.000Z");

/** A manifest whose one test was held back for the reason given. */
function heldBack(
  reason: "flaky" | "main-red",
  fields: Partial<Manifest> = {},
): Manifest {
  const entry = sampleEntry({ k: "unit", s: "memory", n: "space > writes" }, {
    flakeRate: 0.42,
  });
  return sampleManifest({
    entries: [entry],
    withheld: [{ test: entry.test, suite: entry.suite, reason }],
    ...fields,
  });
}

describe("test-selection-page", () => {
  describe("testSelectionPage()", () => {
    it("says so when the publisher has written no manifest", () => {
      const page = testSelectionPage(undefined, NOW);
      expect(page).toContain("No selection manifest has been published yet.");
      expect(page).not.toContain("<table>");
    });

    it("names a flaky test in full, beside the rate it was measured at", () => {
      const page = testSelectionPage(heldBack("flaky"), NOW);
      expect(page).toContain("space &gt; writes");
      expect(page).toContain("42.0%");
      expect(page).toContain(`id="${FLAKY_SECTION_ID}"`);
    });

    it("says the flake share counts failures rather than runs", () => {
      // 100% is a share of one test's failures, so it says nothing about
      // how often that test fails. A page showing the figure has to say so.
      const page = testSelectionPage(heldBack("flaky"), NOW);
      expect(page).toContain("counts failures rather than runs");
      expect(page).toContain("failed once and flaked once reads 100%");
    });

    it("takes the flake window and threshold from the manifest's own dials", () => {
      const page = testSelectionPage(
        heldBack("flaky", {
          dials: { FLAKE_WINDOW_DAYS: 30, FLAKE_EXCLUSION_RATE: 0.2 },
        }),
        NOW,
      );
      expect(page).toContain("over the last 30 days");
      expect(page).toContain("Past 20.0% a test is held back");
    });

    it("falls back to the published policy when the dials name neither", () => {
      const page = testSelectionPage(heldBack("flaky"), NOW);
      expect(page).toContain(`over the last ${FLAKE_WINDOW_FALLBACK_DAYS} days`);
      expect(page).toContain(
        `Past ${(FLAKE_EXCLUSION_FALLBACK * 100).toFixed(1)}% a test`,
      );
    });

    it("orders held-back tests by the rate that held them back", () => {
      const worst = sampleEntry({ k: "unit", s: "memory", n: "worst" }, {
        flakeRate: 0.9,
      });
      const mild = sampleEntry({ k: "unit", s: "memory", n: "mild" }, {
        flakeRate: 0.1,
      });
      const page = testSelectionPage(
        sampleManifest({
          entries: [mild, worst],
          withheld: [mild, worst].map((entry) => ({
            test: entry.test,
            suite: entry.suite,
            reason: "flaky" as const,
          })),
        }),
        NOW,
      );
      const worstAt = page.indexOf(">worst<");
      const mildAt = page.indexOf(">mild<");
      expect(worstAt).toBeGreaterThan(-1);
      expect(mildAt).toBeGreaterThan(-1);
      expect(worstAt).toBeLessThan(mildAt);
    });

    it("names a test held back while main is red, without a rate", () => {
      const page = testSelectionPage(heldBack("main-red"), NOW);
      expect(page).toContain("Held back while main is red · 1");
      expect(page).toContain("<tr><td>unit</td>");
      expect(page).not.toContain("42.0%");
    });

    it("leaves out a section nothing was held back for", () => {
      const page = testSelectionPage(heldBack("flaky"), NOW);
      expect(page).not.toContain("Held back while main is red");
      expect(page).not.toContain("Too long for any lane");
    });

    it("names the tests that are too long for any lane", () => {
      const huge = sampleEntry({ k: "integration", s: "cli", n: "acl.sh" }, {
        cost: 900,
      });
      const page = testSelectionPage(
        sampleManifest({
          unschedulable: [{ test: huge.test, suite: huge.suite, cost: 900 }],
        }),
        NOW,
      );
      expect(page).toContain("Too long for any lane · 1");
      expect(page).toContain("900s");
      expect(page).toContain("acl.sh");
    });

    it("marks the lane whose projected work is past its budget", () => {
      const page = testSelectionPage(
        sampleManifest({
          lanes: [
            { lane: 1, projectedSeconds: 10, batches: [] },
            {
              lane: 2,
              projectedSeconds: LANE_BUDGET_FALLBACK_SECONDS + 20,
              batches: [],
            },
          ],
        }),
        NOW,
      );
      expect(page).toContain(`<div class="lane"><b>Lane 1</b>`);
      expect(page).toContain(`<div class="lane over"><b>Lane 2</b>`);
    });

    it("holds a lane's bar at its budget rather than past the track", () => {
      const page = testSelectionPage(
        sampleManifest({
          lanes: [{
            lane: 1,
            projectedSeconds: LANE_BUDGET_FALLBACK_SECONDS * 4,
            batches: [],
          }],
        }),
        NOW,
      );
      expect(page).toContain(`width:100.0%`);
    });

    it("says the packing assumes a pull request that made nothing mandatory", () => {
      // A real lane re-packs against its own diff, so the figures here are
      // the floor rather than what any one pull request runs.
      const page = testSelectionPage(
        sampleManifest({
          lanes: [{ lane: 1, projectedSeconds: 10, batches: [] }],
        }),
        NOW,
      );
      expect(page).toContain("packs these with nothing mandatory");
    });

    it("counts the tests each lane holds", () => {
      const page = testSelectionPage(
        sampleManifest({
          lanes: [{
            lane: 1,
            projectedSeconds: 10,
            batches: [
              { suite: "workspace-unit", identities: ["a", "b"] },
              { suite: "workspace-browser", identities: ["c"] },
            ],
          }],
        }),
        NOW,
      );
      expect(page).toContain("3 tests");
    });

    it("says how long ago the manifest was generated", () => {
      const ago = (generatedAt: string) =>
        testSelectionPage(sampleManifest({ generatedAt }), NOW)
          .match(/, (\S+) ago/)?.[1];
      expect(ago("2026-08-20T03:48:00.000Z")).toBe("12m");
      expect(ago("2026-08-19T04:00:00.000Z")).toBe("24h");
      expect(ago("2026-08-13T04:00:00.000Z")).toBe("7d");
    });

    it("leaves a gap for a test the manifest no longer scores", () => {
      // A test can be held back and yet be missing from the entries: an
      // incremental manifest carries only what ran inside its window. Its
      // rate still occupies its column, so the kind stays under "kind".
      const scored = sampleEntry({ k: "unit", s: "memory", n: "scored" }, {
        flakeRate: 0.5,
      });
      const page = testSelectionPage(
        sampleManifest({
          entries: [scored],
          withheld: [scored, { test: { k: "browser", s: "shell", n: "gone" } }]
            .map((entry) => ({
              test: entry.test,
              suite: "workspace-unit",
              reason: "flaky" as const,
            })),
        }),
        NOW,
      );
      expect(page).toContain(
        `<tr><td class="measure">50.0%</td><td>unit</td>`,
      );
      expect(page).toContain(`<tr><td class="measure">—</td><td>browser</td>`);
    });

    it("escapes a test name carrying markup", () => {
      const nasty = sampleEntry(
        { k: "unit", s: "memory", n: `<script>alert("x")</script>`, v: "a>b" },
        { flakeRate: 0.5 },
      );
      const page = testSelectionPage(
        sampleManifest({
          entries: [nasty],
          withheld: [{
            test: nasty.test,
            suite: nasty.suite,
            reason: "flaky",
          }],
        }),
        NOW,
      );
      expect(page).not.toContain("<script>alert");
      expect(page).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
      expect(page).toContain("(a&gt;b)");
    });
  });
});
