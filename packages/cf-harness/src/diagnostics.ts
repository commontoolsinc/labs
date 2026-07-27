import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { HarnessRunManifest } from "./contracts/run-manifest.ts";
import { ProcessTimeoutError } from "./sandbox/process-runner.ts";
import type {
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxRuntimeMountDescription,
  SandboxRuntimeMountKind,
} from "./sandbox/types.ts";
import type { HarnessPolicyEvent } from "./contracts/policy.ts";
import type { ToolOutputId } from "./contracts/tool-result.ts";
import type { BashToolInput, BashToolOutput } from "./tools/bash.ts";
import {
  BROWSER_HOST_COMMAND_DENIED_EXIT_CODE,
  BROWSER_HOST_COMMAND_DENIED_PREFIX,
} from "./tools/browser-host-command-policy.ts";
import type { DelegateTaskToolOutput } from "./contracts/subagent.ts";
import type { HarnessModelProviderId } from "./config.ts";
import type { ReadSkillResourceToolOutput } from "./tools/read-skill-resource.ts";
import { isWebFetchToolErrorOutput } from "./tools/web-fetch.ts";
import {
  isStructuredFileToolErrorOutput,
  type StructuredFileToolErrorCode,
} from "./tools/file-errors.ts";

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
  model?: {
    providerId: HarnessModelProviderId;
    authSource: "api-key" | "none" | "owner-bound-oauth";
  };
  cfc: HarnessCfcCapabilitySnapshot;
}

export type HarnessCfcAbsenceBehavior =
  | "not-required"
  | "observe-only"
  | "permissive-if-absent"
  | "fail-closed-if-absent";

export type HarnessCfcSubstrateStatus =
  | "not-required"
  | "manifest-present"
  | "not-attested"
  | "missing";

export type HarnessCfcMountStatus = "configured" | "not-configured";

export type HarnessFabricStatusProbeStatus =
  | "not-probed"
  | "missing"
  | "present"
  | "invalid";

export type HarnessFabricWriteGovernancePolicy =
  | "not-configured"
  | "host-read-only"
  | "host-writable-non-strict"
  | "host-writable-cfc-strict-attested"
  | "host-writable-cfc-strict-unattested";

export interface HarnessFabricWriteGovernanceSnapshot {
  policy: HarnessFabricWriteGovernancePolicy;
  statusProbe: HarnessFabricStatusProbeStatus;
  delegatedToCfc: boolean;
  attestedMode?: CfcEnforcementMode;
}

export interface HarnessCfcMountSnapshot {
  kind: SandboxRuntimeMountKind;
  status: HarnessCfcMountStatus;
  name?: string;
  hostPath?: string;
  sandboxPath: string;
  readOnly?: boolean;
  mode?: "readonly" | "writable";
  writeGovernance?: HarnessFabricWriteGovernanceSnapshot;
}

export interface HarnessCfcCapabilitySnapshot {
  enforcementMode: CfcEnforcementMode;
  absenceBehavior: HarnessCfcAbsenceBehavior;
  substrateStatus: HarnessCfcSubstrateStatus;
  runManifest: {
    present: boolean;
    type?: string;
    path?: string;
  };
  sandbox: SandboxRuntimeDescription;
  mounts: {
    workspace: HarnessCfcMountSnapshot;
    fabric: HarnessCfcMountSnapshot;
    hostBinds: readonly HarnessCfcMountSnapshot[];
  };
  protectedXattrs: {
    expectedSandboxVisible: false;
    sandboxVisibility: "not-probed";
  };
}

export type HarnessFailureKind =
  | "file_not_found"
  | "missing_binary"
  | "not_a_file"
  | "permission_denied"
  | "tool_not_allowed"
  | "workspace_path_confusion"
  | "timeout"
  | "sandbox_exec_mismatch"
  | "harness_error"
  | "unknown";

export type HarnessFailureSource =
  | "capability_snapshot"
  | "policy_snapshot"
  | "policy_trace"
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
export const FABRIC_STATUS_PROBE_SENTINEL =
  "__CF_HARNESS_FABRIC_STATUS_PROBE__";

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

const shellSingleQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const createFabricStatusProbeScript = (sandboxPath: string): string =>
  [
    `# ${FABRIC_STATUS_PROBE_SENTINEL}`,
    "set +e",
    `status_file=${shellSingleQuote(`${sandboxPath}/.status`)}`,
    'if [ -r "$status_file" ]; then',
    "  printf 'present\\t'",
    '  cat "$status_file"',
    "  printf '\\n'",
    "else",
    "  printf 'missing\\t\\n'",
    "fi",
  ].join("\n");

const isHarnessCapabilityCommand = (
  input: string,
): input is HarnessCapabilityCommand =>
  HARNESS_CAPABILITY_COMMANDS.includes(input as HarnessCapabilityCommand);

const createEmptyCapabilitySnapshot = (
  at: string,
  cfc: HarnessCfcCapabilitySnapshot,
): HarnessCapabilitySnapshot => ({
  type: "cf-harness.capability-snapshot",
  at,
  commands: Object.fromEntries(
    HARNESS_CAPABILITY_COMMANDS.map((command) => [command, { present: false }]),
  ) as Record<HarnessCapabilityCommand, HarnessCapabilityProbe>,
  cfc,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCfcEnforcementMode = (
  value: unknown,
): value is CfcEnforcementMode =>
  value === "disabled" || value === "observe" ||
  value === "enforce-explicit" || value === "enforce-strict";

const isFailedDelegateTaskOutput = (
  output: unknown,
): output is DelegateTaskToolOutput => {
  if (
    !isRecord(output) ||
    output.type !== "cf-harness.delegate-task-output" ||
    typeof output.outputId !== "string" ||
    !isRecord(output.subagent)
  ) {
    return false;
  }
  return output.subagent.status === "failed" &&
    typeof output.subagent.childRunId === "string" &&
    typeof output.subagent.summary === "string";
};

const parseCapabilityProbeOutput = (
  stdout: string,
  at: string,
  cfc: HarnessCfcCapabilitySnapshot,
): HarnessCapabilitySnapshot => {
  const snapshot = createEmptyCapabilitySnapshot(at, cfc);
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

const cfcAbsenceBehaviorForMode = (
  mode: CfcEnforcementMode,
): HarnessCfcAbsenceBehavior => {
  switch (mode) {
    case "disabled":
      return "not-required";
    case "observe":
      return "observe-only";
    case "enforce-explicit":
      return "permissive-if-absent";
    case "enforce-strict":
      return "fail-closed-if-absent";
  }
};

const cfcSubstrateStatusFor = (options: {
  mode: CfcEnforcementMode;
  runManifest?: HarnessRunManifest;
}): HarnessCfcSubstrateStatus => {
  if (options.mode === "disabled") {
    return "not-required";
  }
  if (options.runManifest !== undefined) {
    return "manifest-present";
  }
  return options.mode === "enforce-strict" ? "missing" : "not-attested";
};

const describeSandbox = (
  sandbox: SandboxRuntime,
  cwd: string,
): SandboxRuntimeDescription =>
  sandbox.describe?.() ?? {
    kind: sandbox.kind,
    defaultWorkingDirectory: sandbox.defaultWorkingDirectory(),
    cfc: {
      runtimeRequested: sandbox.kind === "docker-runsc-cfc",
      workspaceMountPath: cwd,
    },
  };

const findMountDescription = (
  mounts: readonly SandboxRuntimeMountDescription[] | undefined,
  kind: SandboxRuntimeMountKind,
): SandboxRuntimeMountDescription | undefined =>
  mounts?.find((mount) => mount.kind === kind);

const findMountDescriptions = (
  mounts: readonly SandboxRuntimeMountDescription[] | undefined,
  kind: SandboxRuntimeMountKind,
): readonly SandboxRuntimeMountDescription[] =>
  mounts?.filter((mount) => mount.kind === kind) ?? [];

const createCfcMountSnapshots = (
  sandboxDescription: SandboxRuntimeDescription,
  mode: CfcEnforcementMode,
): HarnessCfcCapabilitySnapshot["mounts"] => {
  const workspaceMount = findMountDescription(
    sandboxDescription.cfc?.mounts,
    "workspace",
  );
  const fabricMount = findMountDescription(
    sandboxDescription.cfc?.mounts,
    "fabric-fuse",
  );
  return {
    workspace: {
      kind: "workspace",
      status: "configured",
      ...(workspaceMount?.hostPath !== undefined
        ? { hostPath: workspaceMount.hostPath }
        : {}),
      sandboxPath: workspaceMount?.sandboxPath ??
        sandboxDescription.cfc?.workspaceMountPath ??
        sandboxDescription.defaultWorkingDirectory,
      readOnly: workspaceMount?.readOnly ?? false,
    },
    fabric: fabricMount
      ? {
        kind: "fabric-fuse",
        status: "configured",
        ...(fabricMount.hostPath !== undefined
          ? { hostPath: fabricMount.hostPath }
          : {}),
        sandboxPath: fabricMount.sandboxPath,
        readOnly: fabricMount.readOnly,
        writeGovernance: createFabricWriteGovernance({
          mode,
          readOnly: fabricMount.readOnly,
          statusProbe: "not-probed",
        }),
      }
      : {
        kind: "fabric-fuse",
        status: "not-configured",
        sandboxPath: "/fabric",
        writeGovernance: {
          policy: "not-configured",
          statusProbe: "not-probed",
          delegatedToCfc: false,
        },
      },
    hostBinds: findMountDescriptions(
      sandboxDescription.cfc?.mounts,
      "host-bind",
    ).map((mount) => ({
      kind: "host-bind" as const,
      status: "configured" as const,
      ...(mount.name !== undefined ? { name: mount.name } : {}),
      ...(mount.hostPath !== undefined ? { hostPath: mount.hostPath } : {}),
      sandboxPath: mount.sandboxPath,
      readOnly: mount.readOnly,
      mode: mount.readOnly ? "readonly" as const : "writable" as const,
    })),
  };
};

interface FabricStatusProbeResult {
  statusProbe: HarnessFabricStatusProbeStatus;
  attestedMode?: CfcEnforcementMode;
}

const parseFabricStatusProbeOutput = (
  stdout: string,
): FabricStatusProbeResult => {
  const trimmed = stdout.trimEnd();
  const separator = trimmed.indexOf("\t");
  const status = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const payload = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
  if (status === "missing") {
    return { statusProbe: "missing" };
  }
  if (status !== "present") {
    return { statusProbe: "invalid" };
  }
  try {
    const parsed = JSON.parse(payload);
    const cfc = isRecord(parsed) ? parsed.cfc : undefined;
    const mode = isRecord(cfc) ? cfc.mode : undefined;
    return {
      statusProbe: "present",
      ...(isCfcEnforcementMode(mode) ? { attestedMode: mode } : {}),
    };
  } catch {
    return { statusProbe: "invalid" };
  }
};

const createFabricWriteGovernance = (options: {
  mode: CfcEnforcementMode;
  readOnly: boolean;
  statusProbe: HarnessFabricStatusProbeStatus;
  attestedMode?: CfcEnforcementMode;
}): HarnessFabricWriteGovernanceSnapshot => {
  if (options.readOnly) {
    return {
      policy: "host-read-only",
      statusProbe: options.statusProbe,
      delegatedToCfc: false,
      ...(options.attestedMode !== undefined
        ? { attestedMode: options.attestedMode }
        : {}),
    };
  }

  if (options.mode !== "enforce-strict") {
    return {
      policy: "host-writable-non-strict",
      statusProbe: options.statusProbe,
      delegatedToCfc: false,
      ...(options.attestedMode !== undefined
        ? { attestedMode: options.attestedMode }
        : {}),
    };
  }

  const strictAttested = options.statusProbe === "present" &&
    options.attestedMode === "enforce-strict";
  return {
    policy: strictAttested
      ? "host-writable-cfc-strict-attested"
      : "host-writable-cfc-strict-unattested",
    statusProbe: options.statusProbe,
    delegatedToCfc: true,
    ...(options.attestedMode !== undefined
      ? { attestedMode: options.attestedMode }
      : {}),
  };
};

const createCfcCapabilitySnapshot = (
  sandbox: SandboxRuntime,
  cwd: string,
  options: CollectHarnessCapabilitySnapshotOptions,
): HarnessCfcCapabilitySnapshot => {
  const mode = options.cfcEnforcementMode ?? "enforce-explicit";
  const sandboxDescription = describeSandbox(sandbox, cwd);
  return {
    enforcementMode: mode,
    absenceBehavior: cfcAbsenceBehaviorForMode(mode),
    substrateStatus: cfcSubstrateStatusFor({
      mode,
      runManifest: options.runManifest,
    }),
    runManifest: {
      present: options.runManifest !== undefined,
      ...(options.runManifest !== undefined
        ? { type: options.runManifest.type }
        : {}),
      ...(options.runManifestPath !== undefined
        ? { path: options.runManifestPath }
        : {}),
    },
    sandbox: sandboxDescription,
    mounts: createCfcMountSnapshots(sandboxDescription, mode),
    protectedXattrs: {
      expectedSandboxVisible: false,
      sandboxVisibility: "not-probed",
    },
  };
};

export interface CollectHarnessCapabilitySnapshotOptions {
  cfcEnforcementMode?: CfcEnforcementMode;
  runManifest?: HarnessRunManifest;
  runManifestPath?: string;
  modelProvider?: HarnessModelProviderId;
  gatewayAuthMode?: "bearer" | "none";
}

export const collectHarnessCapabilitySnapshot = async (
  sandbox: SandboxRuntime,
  cwd: string,
  at = new Date().toISOString(),
  options: CollectHarnessCapabilitySnapshotOptions = {},
): Promise<HarnessCapabilitySnapshot> => {
  const cfc = createCfcCapabilitySnapshot(sandbox, cwd, options);
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
  const snapshot = parseCapabilityProbeOutput(result.stdout, at, cfc);
  if (options.modelProvider !== undefined) {
    snapshot.model = {
      providerId: options.modelProvider,
      authSource: options.modelProvider === "openai-codex"
        ? "owner-bound-oauth"
        : options.gatewayAuthMode === "none"
        ? "none"
        : "api-key",
    };
  }
  const fabricMount = snapshot.cfc.mounts.fabric;
  if (fabricMount.status === "configured") {
    const fabricStatus = await sandbox.runShell({
      command: createFabricStatusProbeScript(fabricMount.sandboxPath),
      cwd,
    });
    const statusProbe = fabricStatus.exitCode === 0
      ? parseFabricStatusProbeOutput(fabricStatus.stdout)
      : { statusProbe: "invalid" as const };
    fabricMount.writeGovernance = createFabricWriteGovernance({
      mode: snapshot.cfc.enforcementMode,
      readOnly: fabricMount.readOnly ?? false,
      ...statusProbe,
    });
  }
  return snapshot;
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
    return "a shell command was not found";
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
  toolId = "bash",
): HarnessFailureRecord | undefined => {
  if (
    toolId === "bash-no-sandbox" &&
    output.exitCode === BROWSER_HOST_COMMAND_DENIED_EXIT_CODE &&
    output.stderr.startsWith(BROWSER_HOST_COMMAND_DENIED_PREFIX)
  ) {
    return createHarnessFailureRecord({
      kind: "tool_not_allowed",
      source: "tool_output",
      detail: output.stderr,
      at,
      toolId,
      outputId: output.outputId as ToolOutputId,
      command: input.command,
      exitCode: output.exitCode,
    });
  }
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
    toolId,
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
        toolId,
      );
    case "bash-no-sandbox":
      return classifyBashToolFailure(
        input as BashToolInput,
        output as BashToolOutput,
        at,
        undefined,
        toolId,
      );
    case "read_file":
    case "view_image":
    case "edit_file":
    case "write_file":
      return classifyStructuredFileToolFailure(toolId, output, at);
    case "read_skill_resource":
      return classifySkillResourceToolFailure(output, at);
    case "web_fetch":
      return classifyWebFetchToolFailure(output, at);
    case "delegate_task": {
      if (isFailedDelegateTaskOutput(output)) {
        return createHarnessFailureRecord({
          kind: "harness_error",
          source: "tool_output",
          detail:
            `subagent ${output.subagent.childRunId} failed: ${output.subagent.summary}`,
          at,
          toolId,
          outputId: output.outputId as ToolOutputId,
        });
      }
      return undefined;
    }
    default:
      return undefined;
  }
};

const classifyWebFetchToolFailure = (
  output: unknown,
  at: string,
): HarnessFailureRecord | undefined => {
  if (!isWebFetchToolErrorOutput(output)) {
    return undefined;
  }
  return createHarnessFailureRecord({
    kind: output.code === "blocked_url" ? "tool_not_allowed" : "harness_error",
    source: "tool_output",
    detail: output.message,
    at,
    toolId: "web_fetch",
    outputId: output.outputId as ToolOutputId,
    ...(output.status !== undefined ? { exitCode: output.status } : {}),
  });
};

const isFailedSkillResourceOutput = (
  output: unknown,
): output is ReadSkillResourceToolOutput =>
  isRecord(output) &&
  output.type === "cf-harness.read-skill-resource-output" &&
  output.status === "error" &&
  typeof output.outputId === "string" &&
  isRecord(output.error) &&
  typeof output.error.message === "string";

const classifySkillResourceToolFailure = (
  output: unknown,
  at: string,
): HarnessFailureRecord | undefined => {
  if (!isFailedSkillResourceOutput(output)) {
    return undefined;
  }
  const error = output.error!;
  return createHarnessFailureRecord({
    kind: "harness_error",
    source: "tool_output",
    detail: error.message,
    at,
    toolId: "read_skill_resource",
    outputId: output.outputId as ToolOutputId,
  });
};

const fileFailureKindForCode = (
  code: StructuredFileToolErrorCode,
): HarnessFailureKind => {
  switch (code) {
    case "file_not_found":
      return "file_not_found";
    case "edit_conflict":
      return "harness_error";
    case "not_a_file":
      return "not_a_file";
    case "permission_denied":
      return "permission_denied";
    case "path_outside_workspace":
      return "workspace_path_confusion";
    case "unknown":
      return "unknown";
  }
};

const classifyStructuredFileToolFailure = (
  toolId: "read_file" | "view_image" | "write_file" | "edit_file",
  output: unknown,
  at: string,
): HarnessFailureRecord | undefined => {
  if (!isStructuredFileToolErrorOutput(output)) {
    return undefined;
  }
  return createHarnessFailureRecord({
    kind: fileFailureKindForCode(output.error.code),
    source: "tool_output",
    detail: output.error.message,
    at,
    toolId,
    outputId: output.outputId as ToolOutputId,
    ...(output.error.exitCode !== undefined
      ? { exitCode: output.error.exitCode }
      : {}),
  });
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
  if (
    normalized.includes("chat completion transport request failed") &&
    (normalized.includes("timed out") ||
      normalized.includes("timeout"))
  ) {
    return createHarnessFailureRecord({
      kind: "timeout",
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
  permission_denied: 35,
  missing_binary: 30,
  not_a_file: 25,
  file_not_found: 25,
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
