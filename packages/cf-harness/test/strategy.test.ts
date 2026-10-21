import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { buildCfHarnessBaseSystemPrompt } from "../src/cli.ts";
import type {
  HarnessTaskDomain,
  HarnessTaskTag,
} from "../src/task-classification.ts";
import type { HarnessRunDepth } from "../src/contracts/run-depth.ts";

const prompt = (
  depth: HarnessRunDepth,
  domains: HarnessTaskDomain[],
  tags: HarnessTaskTag[] = ["find"],
) =>
  buildCfHarnessBaseSystemPrompt({
    patternIndex: true,
    tags: new Set(tags),
    domains: new Set(domains),
    depth,
    allowedToolIds: ["submit_result"],
  });

describe("strategy", () => {
  it("leaves a standard run's prompt as it is at every domain", () => {
    for (const domains of [[], ["personal"], ["web"], ["fabric"]] as const) {
      expect(prompt("standard", [...domains])).toBe(
        buildCfHarnessBaseSystemPrompt({
          patternIndex: true,
          tags: new Set<HarnessTaskTag>(["find"]),
          allowedToolIds: ["submit_result"],
        }),
      );
    }
  });

  it("tells a quick run to stop after a lookup or two and say what it did not check", () => {
    const quick = prompt("quick", ["personal"]);

    expect(quick).toContain("one or two lookups");
    expect(quick).not.toContain("Search every source");
    expect(quick).not.toContain("Before you finish");
  });

  it("tells a deep run in the person's data to exhaust their sources, and one on the web to read several", () => {
    const personal = prompt("deep", ["personal"]);
    const web = prompt("deep", ["web"]);

    expect(personal).toContain("Search every source of the person's own data");
    expect(personal).not.toContain("several independent sources");
    expect(web).toContain("several independent sources");
    expect(web).not.toContain("Search every source of the person's own data");
  });

  it("holds every deep run to a bar for what it leaves and a read of its result", () => {
    const general = prompt("deep", []);

    expect(general).toContain("worth opening on its own");
    expect(general).toContain("Before you finish, read your result");
    expect(general).not.toContain("one or two lookups");
  });
});
