import type { JSONSchema } from "@commonfabric/api";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { BashToolInput, BashToolOutput } from "./bash.ts";
import type { HarnessToolDefinition } from "./types.ts";

const cwdMarkerForOutput = (outputId: string): string =>
  `__CF_HARNESS_HOST_CWD__${outputId}__`;

const extractFinalWorkingDirectory = (
  stdout: string,
  marker: string,
): { stdout: string; cwd?: string } => {
  const markerIndex = stdout.lastIndexOf(marker);
  if (markerIndex === -1) {
    return { stdout };
  }
  return {
    stdout: stdout.slice(0, markerIndex),
    cwd: stdout.slice(markerIndex + marker.length),
  };
};

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
    const cwdMarker = cwdMarkerForOutput(outputId);
    const result = await context.hostProcessRunner.run({
      command: "bash",
      args: [
        "-lc",
        [
          `__cf_harness_cwd_marker=${JSON.stringify(cwdMarker)}`,
          'trap \'__cf_harness_status=$?; trap - EXIT; printf "%s%s" "$__cf_harness_cwd_marker" "$(pwd)"; exit "$__cf_harness_status"\' EXIT',
          input.command,
        ].join("\n"),
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
