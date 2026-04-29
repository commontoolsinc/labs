import type { JSONSchema } from "@commonfabric/api";
import { join, normalize } from "@std/path";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { BashToolInput, BashToolOutput } from "./bash.ts";
import {
  BROWSER_HOST_COMMAND_DENIED_EXIT_CODE,
  BROWSER_HOST_COMMAND_DENIED_PREFIX,
  validateBrowserHostCommand,
} from "./browser-host-command-policy.ts";
import type { HarnessToolContext, HarnessToolDefinition } from "./types.ts";

const DEFAULT_HOST_TIMEOUT_MS = 30_000;
const MAX_HOST_TIMEOUT_MS = 120_000;
const MAX_HOST_OUTPUT_CHARS = 20_000;

export const bashNoSandboxToolDescriptor: HarnessToolDescriptor = {
  toolId: "bash-no-sandbox",
  title: "Bash (No Sandbox)",
  description:
    "PROVISIONAL BROWSER HOST COMMAND TOOL. Runs policy-restricted commands outside the sandbox on the host workspace. Intended only for the browser subagent profile, especially invoking agent-browser; do not use for normal repository work.",
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
    const policyResult = validateBrowserHostCommand(input.command);
    if (!policyResult.allowed) {
      context.setCurrentDir(commandCwd);
      return {
        outputId,
        stdout: "",
        stderr: `${BROWSER_HOST_COMMAND_DENIED_PREFIX}: ${policyResult.reason}`,
        exitCode: BROWSER_HOST_COMMAND_DENIED_EXIT_CODE,
        cwd: commandCwd,
      };
    }
    const hostCwd = context.resolveHostPath(commandCwd);
    const plan = policyResult.plan;
    if (plan === undefined || plan.argv.length === 0) {
      context.setCurrentDir(commandCwd);
      return {
        outputId,
        stdout: "",
        stderr:
          `${BROWSER_HOST_COMMAND_DENIED_PREFIX}: command did not produce an execution plan`,
        exitCode: BROWSER_HOST_COMMAND_DENIED_EXIT_CODE,
        cwd: commandCwd,
      };
    }
    const hostPathFailure = await validateHostWorkspacePaths(
      context,
      hostCwd,
      plan.workspacePathArgs,
    );
    if (hostPathFailure !== undefined) {
      context.setCurrentDir(commandCwd);
      return {
        outputId,
        stdout: "",
        stderr: `${BROWSER_HOST_COMMAND_DENIED_PREFIX}: ${hostPathFailure}`,
        exitCode: BROWSER_HOST_COMMAND_DENIED_EXIT_CODE,
        cwd: commandCwd,
      };
    }
    const result = await context.hostProcessRunner.run({
      command: plan.argv[0]!,
      args: [...plan.argv.slice(1)],
      cwd: hostCwd,
      timeoutMs: resolveHostTimeoutMs(input.timeoutMs),
    });
    context.setCurrentDir(commandCwd);
    return {
      outputId,
      stdout: truncateHostOutput(result.stdout, "stdout"),
      stderr: truncateHostOutput(result.stderr, "stderr"),
      exitCode: result.exitCode,
      cwd: commandCwd,
    };
  },
};

const resolveHostTimeoutMs = (timeoutMs: number | undefined): number => {
  if (timeoutMs === undefined) {
    return DEFAULT_HOST_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(timeoutMs), 0), MAX_HOST_TIMEOUT_MS);
};

const truncateHostOutput = (output: string, label: string): string => {
  if (output.length <= MAX_HOST_OUTPUT_CHARS) {
    return output;
  }
  const omitted = output.length - MAX_HOST_OUTPUT_CHARS;
  return `${
    output.slice(0, MAX_HOST_OUTPUT_CHARS)
  }\n[cf-harness truncated ${label}: ${omitted} chars omitted]`;
};

const validateHostWorkspacePaths = async (
  context: HarnessToolContext,
  hostCwd: string,
  workspacePathArgs: readonly string[],
): Promise<string | undefined> => {
  if (!(await context.isHostPathWithinWorkspace(hostCwd))) {
    return `cwd ${hostCwd} must resolve within the workspace`;
  }
  for (const pathArg of workspacePathArgs) {
    const hostPath = normalize(join(hostCwd, pathArg));
    if (!(await context.isHostPathWithinWorkspace(hostPath))) {
      return `path ${pathArg} must resolve within the workspace`;
    }
  }
  return undefined;
};
