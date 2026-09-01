import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { consolePolicyReport } from "../../console/policy.ts";
import { DEFAULT_HARNESS_CHAT_POLICY } from "../../src/contracts/interactive-chat.ts";

const INPUT = {
  policy: DEFAULT_HARNESS_CHAT_POLICY,
  fabricSpace: "measurement",
  artifactRoot: "/console/runs",
};

describe("consolePolicyReport()", () => {
  it("returns the tools and profiles the policy names", async () => {
    const report = await consolePolicyReport(INPUT);

    expect(report.allowedToolIds).toEqual([
      ...DEFAULT_HARNESS_CHAT_POLICY.allowedToolIds,
    ]);
    expect(report.allowedSubagentProfiles).toEqual([
      ...DEFAULT_HARNESS_CHAT_POLICY.allowedSubagentProfiles,
    ]);
    expect(report.fabricSpace).toBe("measurement");
    expect(report.artifactRoot).toBe("/console/runs");
  });

  it("returns `null` for the prompt and the store a server was not given", async () => {
    const report = await consolePolicyReport(INPUT);

    expect(report.systemPromptSha256).toBeNull();
    expect(report.sessionDbPath).toBeNull();
  });

  it("returns the prompt's SHA-256 and never its text", async () => {
    const report = await consolePolicyReport({
      ...INPUT,
      systemPrompt: "abc",
      sessionDbPath: "/console/sessions.sqlite",
    });

    expect(report.systemPromptSha256).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(JSON.stringify(report)).not.toContain("abc");
    expect(report.sessionDbPath).toBe("/console/sessions.sqlite");
  });

  it("returns different digests for prompts differing by one character", async () => {
    const one = await consolePolicyReport({ ...INPUT, systemPrompt: "abc" });
    const other = await consolePolicyReport({ ...INPUT, systemPrompt: "abd" });

    expect(one.systemPromptSha256).not.toBe(other.systemPromptSha256);
  });
});
