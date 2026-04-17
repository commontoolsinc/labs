import { parseArgs } from "@std/cli/parse-args";
import { dirname, join, resolve } from "@std/path";
import { type CfcEnforcementMode } from "@commonfabric/runner/cfc";
import {
  DEFAULT_GATEWAY_BASE_URL,
  type HarnessGatewayAuthMode,
  parseCfcEnforcementMode,
  parseHarnessGatewayAuthMode,
} from "./config.ts";
import {
  readHarnessRunArtifacts,
  resolveHarnessRunPaths,
} from "./artifacts.ts";
import {
  createCliPromptSlotBinding,
  type PromptSlotRole,
} from "./contracts/prompt-slot.ts";
import type { BuiltinToolId } from "./contracts/tool-descriptor.ts";
import type {
  HarnessTranscriptEvent,
  HarnessTranscriptMessage,
} from "./contracts/transcript.ts";
import { CfHarnessEngine } from "./engine.ts";
import {
  CfHarnessPromptLoop,
  type CreateHarnessPromptLoopOptions,
  type HarnessPromptLoopResult,
} from "./prompt-loop.ts";

const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_MAX_MODEL_TURNS = 8;
const DEFAULT_ARTIFACT_DIRNAME = ".cf-harness-artifacts";
const CLI_OUTPUT_MODES = ["operator", "batch"] as const;

export type CfHarnessCliOutputMode = (typeof CLI_OUTPUT_MODES)[number];

export interface CfHarnessCliConfig {
  workspace: string;
  focusRoot?: string;
  allowedToolIds?: readonly BuiltinToolId[];
  outputMode: CfHarnessCliOutputMode;
  streamEvents: boolean;
  promptSlotRole: PromptSlotRole;
  prompt?: string;
  resumeRun?: string;
  systemPrompt?: string;
  model?: string;
  gatewayBaseUrl: string;
  gatewayAuthMode: HarnessGatewayAuthMode;
  artifactRoot: string;
  resultJsonPath?: string;
  cfcEnforcementModeOverride?: CfcEnforcementMode;
  maxModelTurns: number;
  printTranscript: boolean;
  apiKey?: string;
  apiKeySource?: "CF_HARNESS_API_KEY" | "OPENAI_API_KEY";
}

export interface CfHarnessCliIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface RunCfHarnessCliDependencies {
  cwd?: string;
  env?: Record<string, string | undefined>;
  io?: CfHarnessCliIO;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: (path: string, text: string) => Promise<void>;
  readRunArtifacts?: typeof readHarnessRunArtifacts;
  createPromptLoop?: (
    options: CreateHarnessPromptLoopOptions,
  ) => Pick<CfHarnessPromptLoop, "runPrompt" | "runTranscript">;
}

const defaultCliIo = (): CfHarnessCliIO => ({
  stdout: (text) => Deno.stdout.writeSync(new TextEncoder().encode(text)),
  stderr: (text) => Deno.stderr.writeSync(new TextEncoder().encode(text)),
});

const usage = `Usage: deno run -A src/main.ts [options] [prompt text]

Options:
  --workspace <path>            Workspace host path (defaults to current directory)
  --focus-root <path>           Narrow exploration to a workspace subpath when possible
  --allow-tool <tool>           Restrict available tools (repeatable: bash | read_file | write_file)
  --output-mode <mode>          operator | batch (default: operator)
  --stream-events               Print transcript events as they happen
  --prompt-slot-role <role>     direct-command | context | quote (default: direct-command)
  --prompt <text>               Prompt text to run
  --prompt-file <path>          Read prompt text from a file
  --resume-run <path>           Resume from a run root or run-state.json path
  --system-prompt <text>        Optional system prompt
  --model <name>                Model name (default: ${DEFAULT_MODEL})
  --gateway-base-url <url>      OpenAI-compatible gateway URL
  --gateway-auth-mode <mode>    bearer | none (default: bearer)
  --artifact-root <path>        Host-side artifact directory
  --result-json-path <path>     Optional structured result sidecar path
  --cfc-enforcement-mode <mode> disabled | observe | enforce-explicit | enforce-strict
  --max-model-turns <n>         Maximum model turns before aborting
  --print-transcript            Print the final transcript JSON after the response
  --help                        Show this help text

Environment:
  CF_HARNESS_API_KEY            Preferred API key for the OpenAI-compatible gateway
  OPENAI_API_KEY                Fallback API key if CF_HARNESS_API_KEY is unset
`;

const parsePositiveInteger = (
  input: string | undefined,
  flagName: string,
): number => {
  if (input === undefined) {
    return DEFAULT_MAX_MODEL_TURNS;
  }
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
};

const PROMPT_SLOT_ROLES = ["direct-command", "context", "quote"] as const;
const BUILTIN_TOOL_IDS = ["bash", "read_file", "write_file"] as const;

const parsePromptSlotRole = (
  input: string | undefined,
): PromptSlotRole | undefined =>
  input !== undefined &&
    (PROMPT_SLOT_ROLES as readonly string[]).includes(input)
    ? input as PromptSlotRole
    : undefined;

const parseCliOutputMode = (
  input: string | undefined,
): CfHarnessCliOutputMode | undefined =>
  input !== undefined &&
    (CLI_OUTPUT_MODES as readonly string[]).includes(input)
    ? input as CfHarnessCliOutputMode
    : undefined;

const parseBuiltinToolId = (
  input: string,
): BuiltinToolId | undefined =>
  (BUILTIN_TOOL_IDS as readonly string[]).includes(input)
    ? input as BuiltinToolId
    : undefined;

const parseBuiltinToolIds = (
  input: string | readonly string[] | undefined,
): readonly BuiltinToolId[] | undefined => {
  if (input === undefined) {
    return undefined;
  }
  const values = Array.isArray(input) ? input : [input];
  const parsed = values.map((value) => parseBuiltinToolId(value));
  if (parsed.some((value) => value === undefined)) {
    throw new Error(
      "allowed tools must be one or more of bash, read_file, write_file",
    );
  }
  return [...new Set(parsed)] as readonly BuiltinToolId[];
};

const resolvePrompt = async (
  args: ReturnType<typeof parseArgs>,
  cwd: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<string | undefined> => {
  const promptFlag = typeof args.prompt === "string" ? args.prompt : undefined;
  const promptFile = typeof args["prompt-file"] === "string"
    ? resolve(cwd, args["prompt-file"])
    : undefined;
  const resumeRun = typeof args["resume-run"] === "string"
    ? resolve(cwd, args["resume-run"])
    : undefined;
  const positionalPrompt = args._.length > 0
    ? args._.map(String).join(" ").trim()
    : undefined;
  const promptSources = [
    resumeRun !== undefined ? "resume-run" : undefined,
    promptFlag !== undefined ? "prompt" : undefined,
    promptFile !== undefined ? "prompt-file" : undefined,
    positionalPrompt !== undefined && positionalPrompt.length > 0
      ? "positional"
      : undefined,
  ].filter((value): value is string => value !== undefined);
  if (promptSources.length === 0) {
    throw new Error(
      "a prompt is required via --prompt, --prompt-file, positional text, or --resume-run",
    );
  }
  if (promptSources.length > 1) {
    throw new Error(
      "provide input using only one of --prompt, --prompt-file, positional text, or --resume-run",
    );
  }
  if (resumeRun !== undefined) {
    return undefined;
  }
  if (promptFlag !== undefined) {
    return promptFlag;
  }
  if (promptFile !== undefined) {
    return await readTextFile(promptFile);
  }
  return positionalPrompt!;
};

export const parseCfHarnessCliArgs = async (
  argv: readonly string[],
  deps: Pick<RunCfHarnessCliDependencies, "cwd" | "env" | "readTextFile"> = {},
): Promise<CfHarnessCliConfig | { help: true }> => {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const args = parseArgs([...normalizedArgv], {
    string: [
      "workspace",
      "focus-root",
      "allow-tool",
      "output-mode",
      "prompt-slot-role",
      "prompt",
      "prompt-file",
      "system-prompt",
      "resume-run",
      "model",
      "gateway-base-url",
      "gateway-auth-mode",
      "artifact-root",
      "result-json-path",
      "cfc-enforcement-mode",
      "max-model-turns",
    ],
    boolean: ["help", "print-transcript", "stream-events"],
    collect: ["allow-tool"],
    alias: {
      h: "help",
    },
    default: {
      "print-transcript": false,
    },
  });

  if (args.help) {
    return { help: true };
  }

  const cwd = resolve(deps.cwd ?? Deno.cwd());
  const workspace = resolve(
    typeof args.workspace === "string" ? args.workspace : cwd,
  );
  const focusRoot = typeof args["focus-root"] === "string"
    ? resolve(workspace, args["focus-root"])
    : undefined;
  const allowedToolIds = parseBuiltinToolIds(
    args["allow-tool"] as string | readonly string[] | undefined,
  );
  const outputMode = parseCliOutputMode(
    typeof args["output-mode"] === "string" ? args["output-mode"] : undefined,
  );
  if (
    args["output-mode"] !== undefined &&
    outputMode === undefined
  ) {
    throw new Error("output mode must be one of operator, batch");
  }
  const promptSlotRole = parsePromptSlotRole(
    typeof args["prompt-slot-role"] === "string"
      ? args["prompt-slot-role"]
      : undefined,
  );
  if (
    args["prompt-slot-role"] !== undefined &&
    promptSlotRole === undefined
  ) {
    throw new Error(
      "prompt slot role must be one of direct-command, context, quote",
    );
  }
  const resumeRun = typeof args["resume-run"] === "string"
    ? resolve(cwd, args["resume-run"])
    : undefined;
  const artifactRoot = resolve(
    typeof args["artifact-root"] === "string"
      ? args["artifact-root"]
      : resumeRun !== undefined
      ? dirname(resolveHarnessRunPaths(resumeRun).runRoot)
      : join(workspace, DEFAULT_ARTIFACT_DIRNAME),
  );
  const resultJsonPath = typeof args["result-json-path"] === "string"
    ? resolve(cwd, args["result-json-path"])
    : undefined;
  const gatewayBaseUrl = typeof args["gateway-base-url"] === "string"
    ? args["gateway-base-url"]
    : DEFAULT_GATEWAY_BASE_URL;
  const parsedGatewayAuthMode = parseHarnessGatewayAuthMode(
    typeof args["gateway-auth-mode"] === "string"
      ? args["gateway-auth-mode"]
      : undefined,
  );
  if (
    args["gateway-auth-mode"] !== undefined &&
    parsedGatewayAuthMode === undefined
  ) {
    throw new Error("gateway auth mode must be one of bearer, none");
  }
  const gatewayAuthMode = parsedGatewayAuthMode ?? "bearer";
  const cfcEnforcementModeOverride = parseCfcEnforcementMode(
    typeof args["cfc-enforcement-mode"] === "string"
      ? args["cfc-enforcement-mode"]
      : undefined,
  );
  if (
    args["cfc-enforcement-mode"] !== undefined &&
    cfcEnforcementModeOverride === undefined
  ) {
    throw new Error(
      "cfc enforcement mode must be one of disabled, observe, enforce-explicit, enforce-strict",
    );
  }
  const readTextFile = deps.readTextFile ?? Deno.readTextFile;
  const prompt = await resolvePrompt(args, cwd, readTextFile);
  const env = deps.env ??
    {
      CF_HARNESS_API_KEY: Deno.env.get("CF_HARNESS_API_KEY"),
      OPENAI_API_KEY: Deno.env.get("OPENAI_API_KEY"),
    };
  const apiKey = env.CF_HARNESS_API_KEY ?? env.OPENAI_API_KEY;
  const apiKeySource = env.CF_HARNESS_API_KEY !== undefined
    ? "CF_HARNESS_API_KEY"
    : env.OPENAI_API_KEY !== undefined
    ? "OPENAI_API_KEY"
    : undefined;
  return {
    workspace,
    ...(focusRoot !== undefined ? { focusRoot } : {}),
    ...(allowedToolIds !== undefined ? { allowedToolIds } : {}),
    outputMode: outputMode ?? "operator",
    streamEvents: Boolean(args["stream-events"]),
    promptSlotRole: promptSlotRole ?? "direct-command",
    ...(prompt !== undefined ? { prompt } : {}),
    ...(resumeRun !== undefined ? { resumeRun } : {}),
    ...(typeof args["system-prompt"] === "string"
      ? { systemPrompt: args["system-prompt"] }
      : {}),
    ...(typeof args.model === "string"
      ? { model: args.model }
      : resumeRun === undefined
      ? { model: DEFAULT_MODEL }
      : {}),
    gatewayBaseUrl,
    gatewayAuthMode,
    artifactRoot,
    ...(resultJsonPath !== undefined ? { resultJsonPath } : {}),
    ...(cfcEnforcementModeOverride !== undefined
      ? { cfcEnforcementModeOverride }
      : {}),
    maxModelTurns: parsePositiveInteger(
      typeof args["max-model-turns"] === "string"
        ? args["max-model-turns"]
        : undefined,
      "--max-model-turns",
    ),
    printTranscript: Boolean(args["print-transcript"]),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(apiKeySource !== undefined ? { apiKeySource } : {}),
  };
};

export const formatCfHarnessCliUsage = (): string => usage;

const toWorkspaceSandboxPath = (
  workspaceHostPath: string,
  hostPath?: string,
): string => {
  if (hostPath === undefined) {
    return "/workspace";
  }
  const relativePath = hostPath.startsWith(`${workspaceHostPath}/`)
    ? hostPath.slice(workspaceHostPath.length + 1)
    : hostPath === workspaceHostPath
    ? ""
    : undefined;
  if (relativePath === undefined) {
    return "/workspace";
  }
  return relativePath.length > 0 ? `/workspace/${relativePath}` : "/workspace";
};

export const buildCfHarnessOperatorSystemPrompt = (
  config: Pick<CfHarnessCliConfig, "workspace" | "focusRoot" | "systemPrompt">,
): string => {
  const focusRoot = toWorkspaceSandboxPath(config.workspace, config.focusRoot);
  const lines = [
    "Operator guidance for cf-harness runs:",
    `- Prefer exploration within ${focusRoot}.`,
    "- Start from README files and the package manifest before reading source files.",
    "- Use bash only for narrow discovery; avoid broad workspace scans when a focused path is available.",
    "- Read source files only when needed to answer the prompt accurately.",
    "- Stop once you have enough evidence to answer.",
  ];
  if (config.systemPrompt !== undefined) {
    lines.push("", "Additional instructions:", config.systemPrompt);
  }
  return lines.join("\n");
};

export const resolveCfHarnessCliSystemPrompt = (
  config: Pick<
    CfHarnessCliConfig,
    "workspace" | "focusRoot" | "systemPrompt" | "outputMode"
  >,
): string | undefined =>
  config.outputMode === "batch"
    ? config.systemPrompt
    : buildCfHarnessOperatorSystemPrompt(config);

export interface CfHarnessBatchResult {
  response: string;
  duration_ms: number;
  num_turns: number;
  permission_denials: string[];
  run_id: string;
  status: string;
  model: string;
  artifact_root?: string;
  transcript_path?: string;
}

export const createCfHarnessBatchResult = (
  result: HarnessPromptLoopResult,
  durationMs: number,
): CfHarnessBatchResult => ({
  response: result.finalAssistantText,
  duration_ms: durationMs,
  num_turns: result.modelTurns,
  permission_denials: result.runState.policyEvents
    .filter((event) => event.severity === "denied")
    .map((event) => event.detail),
  run_id: result.runState.runId,
  status: result.runState.status,
  model: result.model,
  ...(result.runState.artifactRoot !== undefined
    ? { artifact_root: result.runState.artifactRoot }
    : {}),
  ...(result.runState.transcriptPath !== undefined
    ? { transcript_path: result.runState.transcriptPath }
    : {}),
});

const summarizeToolResult = (content: string): string => {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.detail === "string") {
      return parsed.detail;
    }
    if (typeof parsed.outputId === "string") {
      return `outputId=${parsed.outputId}`;
    }
  } catch {
    // fall through
  }
  const singleLine = content.replace(/\s+/g, " ").trim();
  return singleLine.length > 180
    ? `${singleLine.slice(0, 177)}...`
    : singleLine;
};

const summarizeToolCallArguments = (
  toolName: string,
  rawArguments: string,
): string | undefined => {
  try {
    const parsed = JSON.parse(rawArguments) as Record<string, unknown>;
    switch (toolName) {
      case "bash":
        return typeof parsed.command === "string"
          ? `command=${JSON.stringify(parsed.command)}`
          : undefined;
      case "read_file":
        return typeof parsed.path === "string"
          ? `path=${JSON.stringify(parsed.path)}`
          : undefined;
      case "write_file": {
        const path = typeof parsed.path === "string"
          ? `path=${JSON.stringify(parsed.path)}`
          : undefined;
        const mode = typeof parsed.mode === "string"
          ? `mode=${JSON.stringify(parsed.mode)}`
          : undefined;
        return [path, mode].filter((value): value is string =>
          value !== undefined
        )
          .join(" ");
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
};

export const formatCfHarnessTranscriptEvent = (
  event: HarnessTranscriptEvent,
): string | undefined => {
  const message: HarnessTranscriptMessage = event.message;
  switch (message.role) {
    case "system":
      return undefined;
    case "user":
      return `user: ${message.content}\n`;
    case "assistant":
      if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
        const tools = message.toolCalls.map((toolCall) => {
          const detail = summarizeToolCallArguments(
            toolCall.function.name,
            toolCall.function.arguments,
          );
          return detail !== undefined && detail.length > 0
            ? `${toolCall.function.name}(${detail})`
            : toolCall.function.name;
        })
          .join(", ");
        const prefix = `assistant -> tools: ${tools}`;
        return message.content.trim().length > 0
          ? `${prefix}\nassistant: ${message.content}\n`
          : `${prefix}\n`;
      }
      return message.content.trim().length > 0
        ? `assistant: ${message.content}\n`
        : undefined;
    case "tool":
      return `tool ${message.toolName}: ${
        summarizeToolResult(message.content)
      }\n`;
  }
};

export const formatCfHarnessCliResult = (
  result: HarnessPromptLoopResult,
  outputMode: CfHarnessCliOutputMode = "operator",
): string => {
  if (outputMode === "batch") {
    return `${result.finalAssistantText}\n`;
  }
  const lines = [
    result.finalAssistantText,
    "",
    `runId: ${result.runState.runId}`,
    `status: ${result.runState.status}`,
    `modelTurns: ${result.modelTurns}`,
  ];
  if (result.runState.artifactRoot !== undefined) {
    lines.push(`artifactRoot: ${result.runState.artifactRoot}`);
  }
  if (result.runState.transcriptPath !== undefined) {
    lines.push(`transcriptPath: ${result.runState.transcriptPath}`);
  }
  if (result.runState.policyEvents.length > 0) {
    lines.push(`policyEvents: ${result.runState.policyEvents.length}`);
    for (const event of result.runState.policyEvents) {
      lines.push(
        `- ${event.severity} ${event.toolId}: ${event.detail}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
};

export const runCfHarnessCli = async (
  argv: readonly string[],
  deps: RunCfHarnessCliDependencies = {},
): Promise<number> => {
  const io = deps.io ?? defaultCliIo();
  try {
    const parsed = await parseCfHarnessCliArgs(argv, deps);
    if ("help" in parsed) {
      io.stdout(formatCfHarnessCliUsage());
      return 0;
    }
    const createPromptLoop = deps.createPromptLoop ??
      ((options: CreateHarnessPromptLoopOptions) =>
        new CfHarnessPromptLoop(options));
    const writeTextFile = deps.writeTextFile ?? Deno.writeTextFile;
    if (parsed.gatewayAuthMode === "bearer" && parsed.apiKey === undefined) {
      throw new Error(
        "no API key configured; set CF_HARNESS_API_KEY or OPENAI_API_KEY",
      );
    }
    const startedAt = Date.now();
    let result: HarnessPromptLoopResult;
    const promptSlotBinding = createCliPromptSlotBinding({
      kernelName: "cf-harness",
      role: parsed.promptSlotRole,
      subject: parsed.resumeRun ?? parsed.workspace,
    });
    const onTranscriptEvent = parsed.streamEvents
      ? async (event: HarnessTranscriptEvent) => {
        const formatted = formatCfHarnessTranscriptEvent(event);
        if (formatted !== undefined) {
          io.stdout(formatted);
        }
      }
      : undefined;
    if (parsed.resumeRun !== undefined) {
      const readRunArtifacts = deps.readRunArtifacts ?? readHarnessRunArtifacts;
      const artifacts = await readRunArtifacts(parsed.resumeRun);
      const loop = createPromptLoop({
        engine: new CfHarnessEngine({
          runState: artifacts.runState,
          artifactRoot: parsed.artifactRoot,
          workspaceHostPath: parsed.workspace,
          model: parsed.model ?? artifacts.runState.model,
          gatewayBaseUrl: parsed.gatewayBaseUrl,
          gatewayAuthMode: parsed.gatewayAuthMode,
          cfcEnforcementModeOverride: parsed.cfcEnforcementModeOverride,
        }),
        apiKey: parsed.apiKey,
        apiKeySource: parsed.apiKeySource,
        maxModelTurns: parsed.maxModelTurns,
        ...(parsed.allowedToolIds !== undefined
          ? { allowedToolIds: parsed.allowedToolIds }
          : {}),
      });
      if (artifacts.transcript === undefined) {
        throw new Error(
          `resume run is missing transcript data: ${parsed.resumeRun}`,
        );
      }
      result = await loop.runTranscript({
        transcript: artifacts.transcript,
        model: parsed.model ?? artifacts.runState.model,
        maxModelTurns: parsed.maxModelTurns,
        promptSlotBinding,
        onTranscriptEvent,
      });
    } else {
      const loop = createPromptLoop({
        workspaceHostPath: parsed.workspace,
        artifactRoot: parsed.artifactRoot,
        model: parsed.model,
        gatewayBaseUrl: parsed.gatewayBaseUrl,
        gatewayAuthMode: parsed.gatewayAuthMode,
        apiKey: parsed.apiKey,
        apiKeySource: parsed.apiKeySource,
        cfcEnforcementModeOverride: parsed.cfcEnforcementModeOverride,
        maxModelTurns: parsed.maxModelTurns,
        ...(parsed.allowedToolIds !== undefined
          ? { allowedToolIds: parsed.allowedToolIds }
          : {}),
      });
      result = await loop.runPrompt({
        prompt: parsed.prompt!,
        systemPrompt: resolveCfHarnessCliSystemPrompt(parsed),
        model: parsed.model,
        maxModelTurns: parsed.maxModelTurns,
        promptSlotBinding,
        onTranscriptEvent,
      });
    }
    const durationMs = Date.now() - startedAt;
    if (parsed.resultJsonPath !== undefined) {
      await writeTextFile(
        parsed.resultJsonPath,
        `${
          JSON.stringify(
            createCfHarnessBatchResult(result, durationMs),
            null,
            2,
          )
        }\n`,
      );
    }
    io.stdout(formatCfHarnessCliResult(result, parsed.outputMode));
    if (parsed.printTranscript) {
      io.stdout(`${JSON.stringify(result.transcript, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};
