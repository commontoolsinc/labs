import type {
  DelegateTaskToolInput,
  DelegateTaskToolOutput,
  HarnessSubagentProfile,
} from "../contracts/subagent.ts";
import { HARNESS_SUBAGENT_PROFILES } from "../contracts/subagent.ts";
import type { HarnessToolDefinition } from "./types.ts";
import { createUnimplementedToolError } from "./types.ts";

export const delegateTaskTool: HarnessToolDefinition<
  DelegateTaskToolInput,
  DelegateTaskToolOutput
> = {
  descriptor: {
    toolId: "delegate_task",
    title: "Delegate Task",
    description:
      "Run one focused subagent with a fresh context and return only its structured summary and retained run references.",
    effectClass: "side-effect",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["goal"],
      properties: {
        goal: {
          type: "string",
          description:
            'Specific task for the child run. Include all context the child needs; it will not see the parent transcript. Delegate one buildable piece at a time: a "pattern-author" child that is asked for one small component returns a working result reference, where one asked for a whole application spends its turns on a compile loop that does not converge. Name the words the capability should be findable under, so a later delegation can search the pattern index for the same component instead of asking for it again.',
        },
        profile: {
          type: "string",
          enum: [
            ...HARNESS_SUBAGENT_PROFILES,
          ] satisfies HarnessSubagentProfile[],
          description:
            'Named subagent profile to spawn. Defaults to the harness default profile. Authoring or running a Common Fabric pattern goes through "pattern-author": it is the one profile preloaded with the pattern authoring skills, which neither the default profile nor the parent run carries — authoring anywhere else means guessing the pattern API. A "pattern-author" child runs what it wrote and answers with a reference to the result cell, never with source: you get something to assign_slug or wire into a run_pattern input, and you never compile anything yourself.',
        },
        context: {
          type: "string",
          description:
            "Optional supporting context, paths, constraints, or expected output for the child run.",
        },
        maxModelTurns: {
          type: "integer",
          minimum: 1,
          maximum: 64,
          description:
            "Optional child model-turn cap. Defaults to the harness subagent cap.",
        },
        returnSchema: {
          anyOf: [
            { type: "boolean" },
            { type: "object", additionalProperties: true },
          ],
          description:
            'Optional JSON Schema for a structured child return. When provided, the child must return only JSON matching this schema; open-ended strings are linkified before the parent sees them. Some profiles declare their own return contract and refuse a schema here — "pattern-author" is one — because the shape of what they hand back is the point of the profile.',
        },
        skillHandle: {
          type: "string",
          description:
            "Optional handle (cfh:a:… token) naming a cell whose string value is skill text for the child. The text is materialized on the trusted host side and injected into the child's context; this run never sees it.",
        },
      },
    },
    tags: ["subagent", "orchestration"],
  },
  invoke() {
    throw createUnimplementedToolError(
      "delegate_task is orchestrated by the prompt loop",
    );
  },
};
