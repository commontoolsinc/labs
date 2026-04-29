import type { JSONSchema } from "@commonfabric/api";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { BashToolInput, BashToolOutput } from "./bash.ts";
import {
  commandWithFinalWorkingDirectoryMarker,
  cwdMarkerForOutput,
  extractFinalWorkingDirectory,
} from "./shell-cwd.ts";
import type { HarnessToolDefinition } from "./types.ts";

const CWD_MARKER_PREFIX = "__CF_HARNESS_HOST_CWD__";

export const bashNoSandboxToolDescriptor: HarnessToolDescriptor = {
  toolId: "bash-no-sandbox",
  title: "Bash (No Sandbox)",
  description:
    "PROVISIONAL HOST SHELL. Runs a bash command outside the sandbox on the host workspace. Intended only for the browser subagent profile, especially invoking agent-browser; do not use for normal repository work.",
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
  tags: ["shell", "host", "no-sandbox", "browser"],
};

export const bashNoSandboxTool: HarnessToolDefinition<
  BashToolInput,
  BashToolOutput
> = {
  descriptor: bashNoSandboxToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("bash-no-sandbox");
    const commandCwd = input.cwd !== undefined
      ? context.resolvePath(input.cwd)
      : context.currentDir;
    const hostCwd = context.resolveHostPath(commandCwd);
    const cwdMarker = cwdMarkerForOutput(CWD_MARKER_PREFIX, outputId);
    const result = await context.hostProcessRunner.run({
      command: "bash",
      args: [
        "-lc",
        commandWithFinalWorkingDirectoryMarker(input.command, cwdMarker),
      ],
      cwd: hostCwd,
      timeoutMs: input.timeoutMs,
    });
    const parsedResult = extractFinalWorkingDirectory(result.stdout, cwdMarker);
    const nextCurrentDir = parsedResult.cwd === undefined
      ? commandCwd
      : context.hostPathToWorkspacePath(parsedResult.cwd) ?? commandCwd;
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
