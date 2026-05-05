import type { JSONSchema } from "@commonfabric/api";
import type { CfcSandboxResult } from "@commonfabric/runner/cfc";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import {
  BASH_COMMAND_DENIED_EXIT_CODE,
  BASH_COMMAND_DENIED_PREFIX,
  validateBashCurlCommand,
} from "./bash-curl-policy.ts";
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
  cfcResult?: CfcSandboxResult;
}

const CWD_MARKER_PREFIX = "__CF_HARNESS_CWD__";

const observedCfcStdout = (
  cfcResult: CfcSandboxResult | undefined,
): string | undefined =>
  cfcResult?.stdout.policy === "observed"
    ? cfcResult.stdout.segments.map((segment) => segment.text).join("")
    : undefined;

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
      cfcResult: { type: "object" },
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
    const curlPolicy = validateBashCurlCommand(input.command);
    if (!curlPolicy.allowed) {
      context.setCurrentDir(commandCwd);
      return {
        outputId,
        stdout: "",
        stderr: `${BASH_COMMAND_DENIED_PREFIX}: ${
          curlPolicy.reason ?? "curl is not allowed"
        }`,
        exitCode: BASH_COMMAND_DENIED_EXIT_CODE,
        cwd: commandCwd,
      };
    }
    const cwdMarker = cwdMarkerForOutput(CWD_MARKER_PREFIX, outputId);
    const command = commandWithFinalWorkingDirectoryMarker(
      input.command,
      cwdMarker,
    );
    const result = await context.sandbox.runShell({
      command,
      cwd: commandCwd,
      timeoutMs: input.timeoutMs,
      cfcInvocationContext: await context.createCfcInvocationContext({
        toolId: "bash",
        toolOutputId: outputId,
        operation: "shell",
        cwd: commandCwd,
        command,
      }),
    });
    const mayTrustCwdMarker = context.cfcEnforcementMode === "disabled" ||
      context.cfcEnforcementMode === "observe";
    const cwdSourceStdout = mayTrustCwdMarker
      ? result.stdout
      : observedCfcStdout(result.cfcResult);
    const parsedCwd = cwdSourceStdout !== undefined
      ? extractFinalWorkingDirectory(cwdSourceStdout, cwdMarker)
      : undefined;
    const outputStdout = mayTrustCwdMarker && parsedCwd !== undefined
      ? parsedCwd.stdout
      : result.stdout;
    const isAllowedCurrentDir = parsedCwd?.cwd !== undefined &&
      (context.sandbox.isPathWithinAllowedRoots?.(parsedCwd.cwd) ??
        context.sandbox.isPathWithinWorkspace(parsedCwd.cwd));
    const nextCurrentDir = parsedCwd?.cwd !== undefined &&
        isAllowedCurrentDir
      ? parsedCwd.cwd
      : commandCwd;
    context.setCurrentDir(nextCurrentDir);
    return {
      outputId,
      stdout: outputStdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      cwd: nextCurrentDir,
      ...(result.cfcResult !== undefined
        ? { cfcResult: result.cfcResult }
        : {}),
    };
  },
};
