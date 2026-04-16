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
import { CfHarnessEngine } from "./engine.ts";
import {
  CfHarnessPromptLoop,
  type CreateHarnessPromptLoopOptions,
  type HarnessPromptLoopResult,
} from "./prompt-loop.ts";

const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_MAX_MODEL_TURNS = 8;
const DEFAULT_ARTIFACT_DIRNAME = ".cf-harness-artifacts";

export interface CfHarnessCliConfig {
  workspace: string;
  focusRoot?: string;
  promptSlotRole: PromptSlotRole;
  prompt?: string;
  resumeRun?: string;
  systemPrompt?: string;
  model?: string;
  gatewayBaseUrl: string;
  gatewayAuthMode: HarnessGatewayAuthMode;
  artifactRoot: string;
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
  --prompt-slot-role <role>     direct-command | context | quote (default: direct-command)
  --prompt <text>               Prompt text to run
  --prompt-file <path>          Read prompt text from a file
  --resume-run <path>           Resume from a run root or run-state.json path
  --system-prompt <text>        Optional system prompt
  --model <name>                Model name (default: ${DEFAULT_MODEL})
  --gateway-base-url <url>      OpenAI-compatible gateway URL
  --gateway-auth-mode <mode>    bearer | none (default: bearer)
  --artifact-root <path>        Host-side artifact directory
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

const parsePromptSlotRole = (
  input: string | undefined,
): PromptSlotRole | undefined =>
  input !== undefined &&
    (PROMPT_SLOT_ROLES as readonly string[]).includes(input)
    ? input as PromptSlotRole
    : undefined;

const resolvePrompt = async (
  args: ReturnType<typeof parseArgs>,
  readTextFile: (path: string) => Promise<string>,
): Promise<string | undefined> => {
  const promptFlag = typeof args.prompt === "string" ? args.prompt : undefined;
  const promptFile = typeof args["prompt-file"] === "string"
    ? args["prompt-file"]
    : undefined;
  const resumeRun = typeof args["resume-run"] === "string"
    ? args["resume-run"]
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
      "prompt-slot-role",
      "prompt",
      "prompt-file",
      "system-prompt",
      "resume-run",
      "model",
      "gateway-base-url",
      "gateway-auth-mode",
      "artifact-root",
      "cfc-enforcement-mode",
      "max-model-turns",
    ],
    boolean: ["help", "print-transcript"],
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
    ? resolve(args["resume-run"])
    : undefined;
  const artifactRoot = resolve(
    typeof args["artifact-root"] === "string"
      ? args["artifact-root"]
      : resumeRun !== undefined
      ? dirname(resolveHarnessRunPaths(resumeRun).runRoot)
      : join(workspace, DEFAULT_ARTIFACT_DIRNAME),
  );
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
  const prompt = await resolvePrompt(args, readTextFile);
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

export const formatCfHarnessCliResult = (
  result: HarnessPromptLoopResult,
): string => {
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
    if (parsed.gatewayAuthMode === "bearer" && parsed.apiKey === undefined) {
      throw new Error(
        "no API key configured; set CF_HARNESS_API_KEY or OPENAI_API_KEY",
      );
    }
    let result: HarnessPromptLoopResult;
    const promptSlotBinding = createCliPromptSlotBinding({
      kernelName: "cf-harness",
      role: parsed.promptSlotRole,
      subject: parsed.resumeRun ?? parsed.workspace,
    });
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
      });
      result = await loop.runPrompt({
        prompt: parsed.prompt!,
        systemPrompt: buildCfHarnessOperatorSystemPrompt(parsed),
        model: parsed.model,
        maxModelTurns: parsed.maxModelTurns,
        promptSlotBinding,
      });
    }
    io.stdout(formatCfHarnessCliResult(result));
    if (parsed.printTranscript) {
      io.stdout(`${JSON.stringify(result.transcript, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};
