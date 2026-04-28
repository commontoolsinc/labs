import type {
  DelegateTaskToolInput,
  DelegateTaskToolOutput,
} from "../contracts/subagent.ts";
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
        context: {
          type: "string",
          description:
            "Optional supporting context, paths, constraints, or expected output for the child run.",
        },
        maxModelTurns: {
          type: "integer",
          minimum: 1,
          maximum: 16,
          description:
            "Optional child model-turn cap. Defaults to the harness subagent cap.",
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
