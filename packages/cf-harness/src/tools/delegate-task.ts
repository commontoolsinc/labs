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
            "Specific task for the child run. Include all context the child needs; it will not see the parent transcript.",
        },
        profile: {
          type: "string",
          enum: [
            ...HARNESS_SUBAGENT_PROFILES,
          ] satisfies HarnessSubagentProfile[],
          description:
            "Named subagent profile to spawn. Defaults to the harness default profile.",
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
            "Optional JSON Schema for a structured child return. When provided, the child must return only JSON matching this schema; open-ended strings are linkified before the parent sees them.",
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
