import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  HARNESS_SUBAGENT_PROFILES,
  type HarnessSubagentProfile,
} from "../../src/contracts/subagent.ts";
import { delegateTaskTool } from "../../src/tools/delegate-task.ts";

const offered = (subagentProfiles?: readonly HarnessSubagentProfile[]) => {
  const descriptor = delegateTaskTool.descriptorForRuntime?.(
    { kind: "runsc-cfc", defaultWorkingDirectory: "/workspace" },
    {
      cfcEnforcementMode: "observe",
      ...(subagentProfiles !== undefined ? { subagentProfiles } : {}),
    },
  ) ?? delegateTaskTool.descriptor;
  const profile = ((descriptor.inputSchema as { properties: unknown })
    .properties as Record<
      string,
      { enum?: string[]; description?: string }
    >).profile;
  return { enum: profile.enum, description: profile.description ?? "" };
};

describe("delegate-task", () => {
  it("offers only the subagent profiles the run allows", () => {
    expect(offered(["default", "pattern-author", "browser"]).enum).toEqual([
      "default",
      "browser",
      "pattern-author",
    ]);
  });

  it("describes pattern-author only to a run that may delegate to it", () => {
    expect(offered(["default", "pattern-author"]).description).toContain(
      '"pattern-author"',
    );
    expect(offered(["default"]).description).not.toContain("pattern-author");
  });

  it("offers every profile to a run that names none", () => {
    expect(offered().enum).toEqual([...HARNESS_SUBAGENT_PROFILES]);
    expect(offered([]).enum).toEqual([...HARNESS_SUBAGENT_PROFILES]);
  });

  it("does not send running an indexed pattern through pattern-author", () => {
    expect(offered().description).not.toContain("Authoring or running");
  });
});
