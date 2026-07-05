import { describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";

import { CFC_TRANSFORMER_STAGE_NAMES } from "../src/cf-pipeline.ts";

// The current-behavior spec (descriptive: code wins on conflict) restates a
// small number of enumerable facts whose canonical source is a constant in
// this package. Those restatements are the highest-rot content in the spec
// (see docs/development/skill-authoring.md: "make load-bearing facts
// testable"). This suite pins the restatements to their sources so drift
// fails CI instead of misleading the next reader.
const SPEC_URL = new URL(
  "../../../docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md",
  import.meta.url,
);

/** Extract the body of a `## N. Title` section, up to the next `## ` heading. */
function extractSection(specText: string, headingPrefix: string): string {
  const lines = specText.split("\n");
  const start = lines.findIndex((line) => line.startsWith(headingPrefix));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** Parse `N. \`Name\`` ordered-list entries from a section body. */
function parseBacktickedOrderedList(sectionBody: string): string[] {
  const entries: string[] = [];
  for (const line of sectionBody.split("\n")) {
    const match = line.match(/^\d+\.\s+`([A-Za-z0-9_]+)`\s*$/);
    if (match) entries.push(match[1]!);
  }
  return entries;
}

describe("current-behavior spec stays in sync with canonical constants", () => {
  it("§3 pipeline order matches CFC_TRANSFORMER_STAGE_NAMES", async () => {
    const specText = await Deno.readTextFile(SPEC_URL);
    const section = extractSection(specText, "## 3. Pipeline Order");
    const specStages = parseBacktickedOrderedList(section);

    assertEquals(
      specStages,
      [...CFC_TRANSFORMER_STAGE_NAMES],
      [
        "docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md §3",
        "no longer matches CFC_TRANSFORMER_STAGE_SPECS (src/cf-pipeline.ts).",
        "The spec is descriptive: update its §3 ordered list to the constant's",
        "current names and order, and describe the behavioral reason for the",
        "change in the surrounding prose.",
      ].join("\n"),
    );
  });
});
