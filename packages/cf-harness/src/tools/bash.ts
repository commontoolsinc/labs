import type { JSONSchema } from "@commonfabric/api";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface BashToolInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface BashToolOutput {
  outputId: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export const bashToolDescriptor: HarnessToolDescriptor = {
  toolId: "bash",
  title: "Bash",
  description:
    "Run a shell command inside the target VM. Use this for navigation, search, and command-driven workflows.",
  effectClass: "side-effect",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeoutMs: { type: "number", minimum: 0 },
    },
    required: ["command"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    type: "object",
    properties: {
      outputId: { type: "string" },
      stdout: { type: "string" },
      stderr: { type: "string" },
      exitCode: { type: "number" },
    },
    required: ["outputId", "stdout", "stderr", "exitCode"],
    additionalProperties: false,
  } satisfies JSONSchema,
  tags: ["shell", "vm", "command"],
};

export const bashTool: HarnessToolDefinition<BashToolInput, BashToolOutput> = {
  descriptor: bashToolDescriptor,
  async invoke(context, input) {
    const result = await context.sandbox.runShell({
      command: input.command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
    });
    return {
      outputId: context.nextOutputId("bash"),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  },
};
