/**
 * The prompt a `pattern-author` child opens with: the environment map that
 * names its levers, the rule closing its reference set, and the composition
 * bullets the measurement dial withholds.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  BROWSER_SUBAGENT_PROFILE_CONFIG,
  PATTERN_AUTHOR_SUBAGENT_PROFILE_CONFIG,
} from "../src/contracts/subagent.ts";
import { buildSubagentSystemPrompt } from "../src/prompt-loop.ts";

/** The `pattern-author` prompt as a run assembles it. */
const patternAuthorPrompt = (compositionGuidance = true): string =>
  buildSubagentSystemPrompt(
    "/workspace",
    PATTERN_AUTHOR_SUBAGENT_PROFILE_CONFIG,
    { structuredReturn: true, compositionGuidance },
  );

describe("buildSubagentSystemPrompt()", () => {
  describe("the `pattern-author` environment map", () => {
    // Each case pins one lever or one rule of the map. A child that cannot
    // read the map off its prompt searches the corpus for the same thing
    // every run, which is what the map is there to stop.

    it("names each of the four levers and the tool that reaches it", () => {
      const prompt = patternAuthorPrompt();

      for (
        const lever of [
          "search_patterns reads the index",
          "run_pattern compiles and runs source or a published part into the space",
          "describe_handle says what a reference is",
          "query_docs returns the passages of the corpus",
        ]
      ) {
        expect(prompt).toContain(lever);
      }
    });

    it("states that the granted references are the run's only data sources", () => {
      expect(patternAuthorPrompt()).toContain(
        "The references you were granted are the only data sources this run has",
      );
    });

    it("returns the failure branch for an input the run holds no reference for", () => {
      expect(patternAuthorPrompt()).toContain(
        "return the failure branch naming the input you are missing",
      );
    });

    it("states that the piece registry is a catalog rather than a data source", () => {
      expect(patternAuthorPrompt()).toContain(
        "The piece registry in particular is a catalog of what this space has published, not a data source",
      );
    });

    it("states that a withheld result leaves `resultRef` naming it", () => {
      expect(patternAuthorPrompt()).toContain(
        "come back withheld with `resultRef` still naming it",
      );
    });

    it("names the count that tells an empty source from a wrong predicate", () => {
      const prompt = patternAuthorPrompt();

      expect(prompt).toContain(
        "Run the same read without the predicate you are least sure of",
      );
      expect(prompt).toContain("`count(*)`, which returns one row");
    });

    it("names both spellings a reference is wired in under", () => {
      expect(patternAuthorPrompt()).toContain(
        "the whole `cfh:a:` token, or the `/of:` link it stands for",
      );
    });
  });

  describe("the composition bullets", () => {
    it("states how a part's declared input is satisfied", () => {
      expect(patternAuthorPrompt()).toContain(
        "A part's declared input is satisfied by declaring the same input on your own pattern and forwarding it",
      );
    });

    it("points at the corpus document that works one composition through", () => {
      expect(patternAuthorPrompt()).toContain(
        "docs/common/patterns/composing-published-parts.md",
      );
    });

    it("withholds them under `compositionGuidance: false`", () => {
      const withheld = patternAuthorPrompt(false);

      expect(withheld).not.toContain("cf:pattern:");
      expect(withheld).not.toContain(
        "A part's declared input is satisfied by declaring the same input on your own pattern and forwarding it",
      );
    });

    it("keeps the granted-reference rule under `compositionGuidance: false`", () => {
      // The dial withholds the case for composing rather than the map of
      // what the run holds, so a measurement arm that turns it off still
      // reads a run's reference set as closed.

      expect(patternAuthorPrompt(false)).toContain(
        "The references you were granted are the only data sources this run has",
      );
    });
  });

  describe("another profile's prompt", () => {
    it("carries none of the `pattern-author` map", () => {
      const browser = buildSubagentSystemPrompt(
        "/workspace",
        BROWSER_SUBAGENT_PROFILE_CONFIG,
        { structuredReturn: true, compositionGuidance: true },
      );

      expect(browser).not.toContain("search_patterns reads the index");
      expect(browser).not.toContain(
        "The references you were granted are the only data sources this run has",
      );
    });
  });
});
