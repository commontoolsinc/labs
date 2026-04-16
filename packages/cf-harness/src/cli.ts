import { parseArgs } from "@std/cli/parse-args";
import { join, resolve } from "@std/path";
import { type CfcEnforcementMode } from "@commonfabric/runner/cfc";
import { DEFAULT_GATEWAY_BASE_URL, parseCfcEnforcementMode } from "./config.ts";
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
  prompt: string;
  systemPrompt?: string;
  model: string;
  gatewayBaseUrl: string;
  artifactRoot: string;
  cfcEnforcementModeOverride?: CfcEnforcementMode;
  maxModelTurns: number;
  printTranscript: boolean;
  apiKey?: string;
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
  createPromptLoop?: (
    options: CreateHarnessPromptLoopOptions,
  ) => Pick<CfHarnessPromptLoop, "runPrompt">;
}

const defaultCliIo = (): CfHarnessCliIO => ({
  stdout: (text) => Deno.stdout.writeSync(new TextEncoder().encode(text)),
  stderr: (text) => Deno.stderr.writeSync(new TextEncoder().encode(text)),
});

const usage = `Usage: deno run -A src/main.ts [options] [prompt text]

Options:
  --workspace <path>            Workspace host path (defaults to current directory)
  --prompt <text>               Prompt text to run
  --prompt-file <path>          Read prompt text from a file
  --system-prompt <text>        Optional system prompt
  --model <name>                Model name (default: ${DEFAULT_MODEL})
  --gateway-base-url <url>      OpenAI-compatible gateway URL
  --artifact-root <path>        Host-side artifact directory
  --cfc-enforcement-mode <mode> disabled | observe | enforce-explicit | enforce-strict
  --max-model-turns <n>         Maximum model turns before aborting
  --print-transcript            Print the final transcript JSON after the response
  --help                        Show this help text
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

const resolvePrompt = async (
  args: ReturnType<typeof parseArgs>,
  readTextFile: (path: string) => Promise<string>,
): Promise<string> => {
  const promptFlag = typeof args.prompt === "string" ? args.prompt : undefined;
  const promptFile = typeof args["prompt-file"] === "string"
    ? args["prompt-file"]
    : undefined;
  const positionalPrompt = args._.length > 0
    ? args._.map(String).join(" ").trim()
    : undefined;
  const promptSources = [
    promptFlag !== undefined ? "prompt" : undefined,
    promptFile !== undefined ? "prompt-file" : undefined,
    positionalPrompt !== undefined && positionalPrompt.length > 0
      ? "positional"
      : undefined,
  ].filter((value): value is string => value !== undefined);
  if (promptSources.length === 0) {
    throw new Error(
      "a prompt is required via --prompt, --prompt-file, or positional text",
    );
  }
  if (promptSources.length > 1) {
    throw new Error(
      "provide prompt input using only one of --prompt, --prompt-file, or positional text",
    );
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
  const args = parseArgs([...argv], {
    string: [
      "workspace",
      "prompt",
      "prompt-file",
      "system-prompt",
      "model",
      "gateway-base-url",
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
  const artifactRoot = resolve(
    typeof args["artifact-root"] === "string"
      ? args["artifact-root"]
      : join(workspace, DEFAULT_ARTIFACT_DIRNAME),
  );
  const gatewayBaseUrl = typeof args["gateway-base-url"] === "string"
    ? args["gateway-base-url"]
    : DEFAULT_GATEWAY_BASE_URL;
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
  return {
    workspace,
    prompt,
    ...(typeof args["system-prompt"] === "string"
      ? { systemPrompt: args["system-prompt"] }
      : {}),
    model: typeof args.model === "string" ? args.model : DEFAULT_MODEL,
    gatewayBaseUrl,
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
    ...(env.CF_HARNESS_API_KEY ?? env.OPENAI_API_KEY
      ? { apiKey: env.CF_HARNESS_API_KEY ?? env.OPENAI_API_KEY }
      : {}),
  };
};

export const formatCfHarnessCliUsage = (): string => usage;

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
    const loop = createPromptLoop({
      workspaceHostPath: parsed.workspace,
      artifactRoot: parsed.artifactRoot,
      model: parsed.model,
      gatewayBaseUrl: parsed.gatewayBaseUrl,
      apiKey: parsed.apiKey,
      cfcEnforcementModeOverride: parsed.cfcEnforcementModeOverride,
      maxModelTurns: parsed.maxModelTurns,
    });
    const result = await loop.runPrompt({
      prompt: parsed.prompt,
      ...(parsed.systemPrompt !== undefined
        ? { systemPrompt: parsed.systemPrompt }
        : {}),
      model: parsed.model,
      maxModelTurns: parsed.maxModelTurns,
    });
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
