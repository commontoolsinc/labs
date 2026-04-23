import { ProcessTimeoutError } from "./sandbox/process-runner.ts";
import type { SandboxRuntime } from "./sandbox/types.ts";
import type { HarnessPolicyEvent } from "./contracts/policy.ts";
import type { ToolOutputId } from "./contracts/tool-result.ts";
import type { BashToolInput, BashToolOutput } from "./tools/bash.ts";

export const HARNESS_CAPABILITY_COMMANDS = [
  "bash",
  "sh",
  "node",
  "deno",
  "python",
  "python3",
  "git",
] as const;

export type HarnessCapabilityCommand =
  typeof HARNESS_CAPABILITY_COMMANDS[number];

export interface HarnessCapabilityProbe {
  present: boolean;
  path?: string;
  version?: string;
}

export interface HarnessCapabilitySnapshot {
  type: "cf-harness.capability-snapshot";
  at: string;
  commands: Record<HarnessCapabilityCommand, HarnessCapabilityProbe>;
}

export type HarnessFailureKind =
  | "missing_binary"
  | "tool_not_allowed"
  | "workspace_path_confusion"
  | "timeout"
  | "sandbox_exec_mismatch"
  | "harness_error"
  | "unknown";

export type HarnessFailureSource =
  | "capability_snapshot"
  | "policy_event"
  | "tool_output"
  | "run_error";

export interface HarnessFailureRecord {
  type: "cf-harness.failure-record";
  kind: HarnessFailureKind;
  source: HarnessFailureSource;
  detail: string;
  at: string;
  toolId?: string;
  toolCallId?: string;
  outputId?: ToolOutputId;
  command?: string;
  commandName?: string;
  exitCode?: number;
}

export interface ClassifyHarnessRunErrorOptions {
  at: string;
  source?: HarnessFailureSource;
  toolId?: string;
  toolCallId?: string;
  outputId?: ToolOutputId;
  command?: string;
  commandName?: string;
}

export const CAPABILITY_PROBE_SENTINEL = "__CF_HARNESS_CAPABILITY_PROBE__";

const CAPABILITY_PROBE_SCRIPT = [
  `# ${CAPABILITY_PROBE_SENTINEL}`,
  "set +e",
  "probe() {",
  '  name="$1"',
  '  if command -v "$name" >/dev/null 2>&1; then',
  "    path=\"$(command -v \"$name\" 2>/dev/null | head -n 1 | tr '\\t' ' ')\"",
  "    version=\"$($name --version 2>/dev/null | head -n 1 | tr '\\t' ' ' || true)\"",
  '    printf "%s\\tpresent\\t%s\\t%s\\n" "$name" "$path" "$version"',
  "  else",
  '    printf "%s\\tmissing\\t\\t\\n" "$name"',
  "  fi",
  "}",
  ...HARNESS_CAPABILITY_COMMANDS.map((command) => `probe ${command}`),
].join("\n");

const isHarnessCapabilityCommand = (
  input: string,
): input is HarnessCapabilityCommand =>
  HARNESS_CAPABILITY_COMMANDS.includes(input as HarnessCapabilityCommand);

const createEmptyCapabilitySnapshot = (
  at: string,
): HarnessCapabilitySnapshot => ({
  type: "cf-harness.capability-snapshot",
  at,
  commands: Object.fromEntries(
    HARNESS_CAPABILITY_COMMANDS.map((command) => [command, { present: false }]),
  ) as Record<HarnessCapabilityCommand, HarnessCapabilityProbe>,
});

const parseCapabilityProbeOutput = (
  stdout: string,
  at: string,
): HarnessCapabilitySnapshot => {
  const snapshot = createEmptyCapabilitySnapshot(at);
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const [command, status, path = "", version = ""] = line.split("\t");
    if (!isHarnessCapabilityCommand(command)) {
      continue;
    }
    snapshot.commands[command] = status === "present"
      ? {
        present: true,
        ...(path !== "" ? { path } : {}),
        ...(version !== "" ? { version } : {}),
      }
      : { present: false };
  }
  return snapshot;
};

export const collectHarnessCapabilitySnapshot = async (
  sandbox: SandboxRuntime,
  cwd: string,
  at = new Date().toISOString(),
): Promise<HarnessCapabilitySnapshot> => {
  const result = await sandbox.runShell({
    command: CAPABILITY_PROBE_SCRIPT,
    cwd,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `capability probe failed with exit ${result.exitCode}: ${
        result.stderr || result.stdout || "no error detail"
      }`,
    );
  }
  return parseCapabilityProbeOutput(result.stdout, at);
};

export const createHarnessFailureRecord = (
  input: Omit<HarnessFailureRecord, "type">,
): HarnessFailureRecord => ({
  type: "cf-harness.failure-record",
  ...input,
});

export const classifyHarnessPolicyEventFailure = (
  event: HarnessPolicyEvent,
): HarnessFailureRecord | undefined =>
  event.severity === "denied"
    ? createHarnessFailureRecord({
      kind: "tool_not_allowed",
      source: "policy_event",
      detail: event.detail,
      at: event.at,
      toolId: event.toolId,
      ...(event.toolCallId !== undefined
        ? { toolCallId: event.toolCallId }
        : {}),
    })
    : undefined;

const MISSING_COMMAND_PATTERNS = [
  "command not found",
  "not found",
  "not recognized",
  "no such file or directory",
];

const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "{",
  "}",
]);

const extractLeadingCommandName = (command: string): string | undefined => {
  for (const rawLine of command.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const tokens = line.split(/\s+/).filter((token) => token.length > 0);
    let index = 0;
    while (
      index < tokens.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)
    ) {
      index += 1;
    }
    let token = tokens[index];
    if (token === undefined || SHELL_KEYWORDS.has(token)) {
      continue;
    }
    if (token === "exec") {
      token = tokens[index + 1];
    }
    if (token === undefined) {
      return undefined;
    }
    return token.replace(/^['"]|['"]$/g, "");
  }
  return undefined;
};

const MISSING_COMMAND_CAPTURE_PATTERNS = [
  /(?:^|:\s*)["']?([^"' \t:]+)["']?:\s*command not found$/i,
  /(?:^|:\s*)["']?([^"' \t:]+)["']?:\s*not found$/i,
  /(?:^|:\s*)["']?([^"' \t:]+)["']?:\s*no such file or directory$/i,
  /["']?([^"' \t]+)["']?\s+is not recognized as an internal or external command\b/i,
];

const extractMissingCommandNameFromText = (
  text: string,
): string | undefined => {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    for (const pattern of MISSING_COMMAND_CAPTURE_PATTERNS) {
      const match = line.match(pattern);
      const commandName = match?.[1]?.trim();
      if (commandName !== undefined && commandName !== "") {
        return commandName;
      }
    }
  }
  return undefined;
};

const capabilityCommandForName = (
  input: string | undefined,
): HarnessCapabilityCommand | undefined =>
  input !== undefined && isHarnessCapabilityCommand(input) ? input : undefined;

const detailForMissingBinary = (
  commandName: string | undefined,
  capabilitySnapshot?: HarnessCapabilitySnapshot,
): string => {
  if (commandName === undefined) {
    return "a shell command was not found in the sandbox";
  }
  const capabilityCommand = capabilityCommandForName(commandName);
  const probe = capabilityCommand === undefined
    ? undefined
    : capabilitySnapshot?.commands[capabilityCommand];
  const aliasHint = commandName === "python" &&
      capabilitySnapshot?.commands.python3.present === true
    ? " python3 is available."
    : commandName === "python3" &&
        capabilitySnapshot?.commands.python.present === true
    ? " python is available."
    : "";
  return probe?.present === false
    ? `${commandName} is not available in the sandbox.${aliasHint}`
    : `${commandName} was not found while executing a shell command.${aliasHint}`;
};

export const classifyBashToolFailure = (
  input: BashToolInput,
  output: BashToolOutput,
  at: string,
  capabilitySnapshot?: HarnessCapabilitySnapshot,
): HarnessFailureRecord | undefined => {
  if (output.exitCode !== 127) {
    return undefined;
  }
  const combinedOutput = `${output.stdout}\n${output.stderr}`.toLowerCase();
  if (
    !MISSING_COMMAND_PATTERNS.some((pattern) =>
      combinedOutput.includes(pattern)
    )
  ) {
    return undefined;
  }
  const commandName =
    extractMissingCommandNameFromText(`${output.stderr}\n${output.stdout}`) ??
      extractLeadingCommandName(input.command);
  return createHarnessFailureRecord({
    kind: "missing_binary",
    source: "tool_output",
    detail: detailForMissingBinary(commandName, capabilitySnapshot),
    at,
    toolId: "bash",
    outputId: output.outputId as ToolOutputId,
    command: input.command,
    ...(commandName !== undefined ? { commandName } : {}),
    exitCode: output.exitCode,
  });
};

export const classifyBuiltinToolFailure = (
  toolId: string,
  input: unknown,
  output: unknown,
  at: string,
  capabilitySnapshot?: HarnessCapabilitySnapshot,
): HarnessFailureRecord | undefined => {
  switch (toolId) {
    case "bash":
      return classifyBashToolFailure(
        input as BashToolInput,
        output as BashToolOutput,
        at,
        capabilitySnapshot,
      );
    default:
      return undefined;
  }
};

export const classifyHarnessRunError = (
  error: unknown,
  options: ClassifyHarnessRunErrorOptions,
): HarnessFailureRecord => {
  if (error instanceof ProcessTimeoutError) {
    return createHarnessFailureRecord({
      kind: "timeout",
      source: options.source ?? "run_error",
      detail: error.message,
      at: options.at,
      ...(options.toolId !== undefined ? { toolId: options.toolId } : {}),
      ...(options.toolCallId !== undefined
        ? { toolCallId: options.toolCallId }
        : {}),
      ...(options.outputId !== undefined ? { outputId: options.outputId } : {}),
      ...(options.command !== undefined ? { command: options.command } : {}),
      ...(options.commandName !== undefined
        ? { commandName: options.commandName }
        : {}),
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("path escapes workspace root")) {
    return createHarnessFailureRecord({
      kind: "workspace_path_confusion",
      source: options.source ?? "run_error",
      detail: message,
      at: options.at,
      ...(options.toolId !== undefined ? { toolId: options.toolId } : {}),
      ...(options.toolCallId !== undefined
        ? { toolCallId: options.toolCallId }
        : {}),
      ...(options.outputId !== undefined ? { outputId: options.outputId } : {}),
      ...(options.command !== undefined ? { command: options.command } : {}),
      ...(options.commandName !== undefined
        ? { commandName: options.commandName }
        : {}),
    });
  }
  const kind = normalized.includes("unknown builtin tool") ||
      normalized.includes("did not return an outputid") ||
      normalized.includes("failed to parse tool arguments") ||
      normalized.includes("chat completion response did not include a message")
    ? "harness_error"
    : "unknown";
  return createHarnessFailureRecord({
    kind,
    source: options.source ?? "run_error",
    detail: message,
    at: options.at,
    ...(options.toolId !== undefined ? { toolId: options.toolId } : {}),
    ...(options.toolCallId !== undefined
      ? { toolCallId: options.toolCallId }
      : {}),
    ...(options.outputId !== undefined ? { outputId: options.outputId } : {}),
    ...(options.command !== undefined ? { command: options.command } : {}),
    ...(options.commandName !== undefined
      ? { commandName: options.commandName }
      : {}),
  });
};

const FAILURE_PRIORITY: Record<HarnessFailureKind, number> = {
  tool_not_allowed: 60,
  timeout: 50,
  workspace_path_confusion: 40,
  missing_binary: 30,
  sandbox_exec_mismatch: 20,
  harness_error: 10,
  unknown: 0,
};

export const selectPrimaryHarnessFailure = (
  failures: readonly HarnessFailureRecord[],
): HarnessFailureRecord | undefined => {
  let best: HarnessFailureRecord | undefined;
  for (const failure of failures) {
    if (
      best === undefined ||
      FAILURE_PRIORITY[failure.kind] > FAILURE_PRIORITY[best.kind]
    ) {
      best = failure;
    }
  }
  return best;
};
