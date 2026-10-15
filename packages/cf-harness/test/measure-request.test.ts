/** The per-tag first-request measurement, over a recorded run. */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { measureRequest } from "../scripts/measure-request.ts";

/** What a recorded loom carry run leaves that the measurement reads. */
const writeRecordedRun = (dir: string): void => {
  Deno.writeTextFileSync(
    join(dir, "policy-snapshot.json"),
    JSON.stringify({
      parentTools: {
        allowedToolIds: [
          "run_pattern",
          "describe_handle",
          "run_command",
          "loom_search",
          "submit_result",
        ],
      },
      subagents: { allowedProfiles: ["default", "pattern-author"] },
    }),
  );
  Deno.writeTextFileSync(
    join(dir, "transcript.json"),
    JSON.stringify([
      {
        role: "system",
        content: [
          "You are cf-harness.",
          "Result schema (JSON):",
          JSON.stringify({ type: "object" }),
          "",
          "Additional instructions:",
          "Answer in one line.",
        ].join("\n"),
      },
      { role: "user", content: "Granted references for this run: none." },
      { role: "user", content: "count to 100" },
      { role: "assistant", content: "" },
    ]),
  );
};

describe("measure-request", () => {
  let dir: string;

  beforeEach(() => {
    dir = Deno.makeTempDirSync();
    writeRecordedRun(dir);
  });

  afterEach(() => {
    Deno.removeSync(dir, { recursive: true });
  });

  it("returns one row per tag over the recorded run's granted tools", async () => {
    const { toolCount, rows } = await measureRequest(dir);
    expect(toolCount).toBe(5);
    expect(rows.map((row) => row.tag)).toEqual([
      "respond",
      "find",
      "act",
      "pieces",
      "author",
      "fallback",
    ]);
  });

  it("returns the same tools bytes for every tag", async () => {
    const { rows } = await measureRequest(dir);
    expect(new Set(rows.map((row) => row.toolsBytes)).size).toBe(1);
  });

  it("measures a recorded run whose system prompt has no result schema or additional instructions", async () => {
    Deno.writeTextFileSync(
      join(dir, "transcript.json"),
      JSON.stringify([
        { role: "system", content: "You are cf-harness." },
        { role: "user", content: "count to 100" },
        { role: "assistant", content: "" },
      ]),
    );
    const { rows } = await measureRequest(dir);
    expect(rows).toHaveLength(6);
  });

  it("returns more input bytes for an author task than for a reply, and the most with no tags", async () => {
    const { rows } = await measureRequest(dir);
    const inputOf = (tag: string) =>
      rows.find((row) => row.tag === tag)!.inputBytes;
    expect(inputOf("author")).toBeGreaterThan(inputOf("respond"));
    expect(inputOf("fallback")).toBeGreaterThanOrEqual(inputOf("author"));
  });
});
