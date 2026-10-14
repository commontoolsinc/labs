import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  buildCfHarnessBaseSystemPrompt,
  buildCfHarnessOperatorSystemPrompt,
} from "../src/cli.ts";
import { PIECE_TARGETING_GUIDANCE } from "../src/piece-targeting.ts";
import { REVISION_VERIFICATION_GUIDANCE } from "../src/revision-verification.ts";
import { orientContextMessages } from "../src/session-assembly.ts";
import { WEAVER_COMMAND_GUIDANCE } from "../src/tools/weaver-action.ts";
import { finishTaskTool } from "../src/tools/finish-task.ts";

describe("orientation", () => {
  it("tells the parent which explicit selections skip opening research", () => {
    const prompt = buildCfHarnessBaseSystemPrompt({ patternIndex: true });
    expect(prompt).toContain(
      "attached patternRefs or explicit pattern:<space>/<slug>, cf:pattern:<id>, or skill:<id> markers",
    );
    expect(prompt).toContain(
      "Prose such as 'use the named skill X' remains open unless X uses a marker",
    );
  });

  it("gives the parent a shared inspection path for calendar and document requests before asking for the source", () => {
    const prompt = buildCfHarnessBaseSystemPrompt({ patternIndex: true });
    expect(prompt).toContain(
      "inspect unresolved relevant handles with describe_handle before asking the user to connect or attach that source",
    );
    expect(prompt).toContain("A grant's name is a lead, not its contents");
    expect(prompt).toContain("not given does not mean absent");
    expect(prompt).toContain(
      "The parent can run an indexed pattern with run_pattern",
    );
    expect(finishTaskTool.descriptor.description).toContain(
      "any applicable bounded discovery route over the granted scope",
    );
  });

  it("tells a run with no pattern index neither to search one nor to run an indexed pattern, and keeps the rest of finding", () => {
    const withIndex = buildCfHarnessBaseSystemPrompt({ patternIndex: true });
    const prompt = buildCfHarnessBaseSystemPrompt({ patternIndex: false });
    expect(withIndex).toContain("Search the pattern index");
    expect(prompt).not.toContain("pattern index");
    expect(prompt).not.toContain("indexed pattern");
    expect(prompt).toContain("not given does not mean absent");
    expect(prompt).toContain("Private research inspects candidates");
    expect(prompt).toContain("resolve_piece first for a slug");
  });

  it("checks the send path before asking for a recipient in the landlord-email rehearsal", () => {
    const prompt = buildCfHarnessBaseSystemPrompt({ patternIndex: true });
    expect(prompt).toContain(
      "Before asking for a recipient or other execution detail, establish that an available tool, skill, or pattern can perform the action with the held authority",
    );
    expect(prompt).toContain(
      "If sending is unavailable, say so immediately and offer a draft",
    );
    expect(finishTaskTool.descriptor.description).toContain(
      "rather than asking for an address as though that enables sending",
    );
  });

  it("keeps discovery scoped and a release refusal out of the question path", () => {
    const prompt = buildCfHarnessBaseSystemPrompt({ patternIndex: true });
    expect(prompt).toContain("resolve_piece first for a slug");
    expect(prompt).toContain("zero registry reads for an unnamed target");
    expect(prompt).toContain("at most one lookup for a display name");
    expect(prompt).toContain(
      "Explicit requests to list or analyze the space are not missing-target lookups",
    );
    expect(prompt).toContain(
      "An unavailable, refused, or pending read stays unknown",
    );
    expect(prompt).toContain(
      "Inspect run_pattern outputConcerns and the declared error branch",
    );
    expect(prompt).toContain(
      "describe only the successfully applied change, say the result could not be inspected",
    );
    expect(finishTaskTool.descriptor.description).toContain(
      "Never ask for a nonexistent permission to release results",
    );
  });

  describe("with task tags", () => {
    it("gives a respond task none of the handle, research, or delegation guidance", () => {
      const prompt = buildCfHarnessBaseSystemPrompt({
        patternIndex: true,
        tags: new Set(["respond"]),
      });

      expect(prompt).not.toContain("describe_handle");
      expect(prompt).not.toContain("opening research");
      expect(prompt).not.toContain("Search the pattern index");
      expect(prompt).not.toContain("When you delegate");
      expect(prompt).toContain("Orient to the user's goal");
      expect(prompt.length).toBeLessThan(
        buildCfHarnessBaseSystemPrompt({ patternIndex: true }).length,
      );
    });

    it("narrows the operator prompt by the task's tags", () => {
      const config = { workspace: "/workspace", focusRoot: "/workspace" };

      expect(buildCfHarnessOperatorSystemPrompt({
        ...config,
        taskTags: new Set(["respond"]),
      })).not.toContain("When you delegate");
      expect(buildCfHarnessOperatorSystemPrompt(config))
        .toContain("When you delegate");
    });

    it("gives a pieces task the handle guidance and not the opening-research rule", () => {
      const prompt = buildCfHarnessBaseSystemPrompt({
        patternIndex: true,
        tags: new Set(["pieces"]),
      });

      expect(prompt).toContain(
        "inspect unresolved relevant handles with describe_handle",
      );
      expect(prompt).not.toContain("opening research");
    });

    it("gives a find task the instruction to inspect held handles and grants", () => {
      const prompt = buildCfHarnessBaseSystemPrompt({
        patternIndex: true,
        tags: new Set(["find"]),
      });

      expect(prompt).toContain("A grant's name is a lead, not its contents");
      expect(prompt).not.toContain("When you delegate");
    });

    it("gives a pieces task the delegation guidance", () => {
      expect(
        buildCfHarnessBaseSystemPrompt({
          patternIndex: true,
          tags: new Set(["pieces"]),
        }),
      ).toContain("When you delegate");
    });

    it("gives an author task the opening-research rule, index search, and delegation", () => {
      const prompt = buildCfHarnessBaseSystemPrompt({
        patternIndex: true,
        tags: new Set(["author"]),
      });

      expect(prompt).toContain("attached patternRefs or explicit");
      expect(prompt).toContain("Search the pattern index");
      expect(prompt).toContain("When you delegate");
    });

    it("keeps the Weaver's commands for a find task and withholds them from a respond task", () => {
      const messages = ["input cells", WEAVER_COMMAND_GUIDANCE];

      expect(orientContextMessages(messages, new Set(["find"])))
        .toEqual(messages);
      expect(orientContextMessages(messages, new Set(["respond"])))
        .toEqual(["input cells"]);
    });

    it("withholds piece targeting and revision verification from a respond task's context", () => {
      const messages = [
        "input cells",
        PIECE_TARGETING_GUIDANCE,
        REVISION_VERIFICATION_GUIDANCE,
      ];

      expect(orientContextMessages(messages, new Set(["respond"])))
        .toEqual(["input cells"]);
      expect(orientContextMessages(messages, new Set(["pieces"])))
        .toEqual(messages);
    });
  });
});
