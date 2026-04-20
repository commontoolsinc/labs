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
  cwd: string;
}

const cwdMarkerForOutput = (outputId: string): string =>
  `__CF_HARNESS_CWD__${outputId}__`;

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
    const cwdMarker = cwdMarkerForOutput(outputId);
    const result = await context.sandbox.runShell({
      command: [
        `__cf_harness_cwd_marker=${JSON.stringify(cwdMarker)}`,
        'trap \'__cf_harness_status=$?; trap - EXIT; printf "%s%s" "$__cf_harness_cwd_marker" "$(pwd)"; exit "$__cf_harness_status"\' EXIT',
        input.command,
      ].join("\n"),
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
