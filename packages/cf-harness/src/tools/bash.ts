import type { JSONSchema } from "@commonfabric/api";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import {
  commandWithFinalWorkingDirectoryMarker,
  cwdMarkerForOutput,
  extractFinalWorkingDirectory,
} from "./shell-cwd.ts";
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
  cwd: string;
}

const CWD_MARKER_PREFIX = "__CF_HARNESS_CWD__";

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
      cwd: { type: "string" },
    },
    required: ["outputId", "stdout", "stderr", "exitCode", "cwd"],
    additionalProperties: false,
  } satisfies JSONSchema,
  tags: ["shell", "vm", "command"],
};

export const bashTool: HarnessToolDefinition<BashToolInput, BashToolOutput> = {
  descriptor: bashToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("bash");
    const commandCwd = input.cwd !== undefined
      ? context.resolvePath(input.cwd)
      : context.currentDir;
    const cwdMarker = cwdMarkerForOutput(CWD_MARKER_PREFIX, outputId);
    const result = await context.sandbox.runShell({
      command: commandWithFinalWorkingDirectoryMarker(
        input.command,
        cwdMarker,
      ),
      cwd: commandCwd,
      timeoutMs: input.timeoutMs,
    });
    const parsedResult = extractFinalWorkingDirectory(result.stdout, cwdMarker);
    const nextCurrentDir = parsedResult.cwd !== undefined &&
        context.sandbox.isPathWithinWorkspace(parsedResult.cwd)
      ? parsedResult.cwd
      : commandCwd;
    context.setCurrentDir(nextCurrentDir);
    return {
      outputId,
      stdout: parsedResult.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      cwd: nextCurrentDir,
    };
  },
};
