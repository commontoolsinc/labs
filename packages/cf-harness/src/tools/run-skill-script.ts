import type { JSONSchema } from "@commonfabric/api";
import type { CfcLabelView, CfcSandboxResult } from "@commonfabric/runner/cfc";
import { basename, isAbsolute, relative } from "@std/path";
import type {
  HarnessSkillDiagnostic,
  HarnessSkillRecord,
  HarnessSkillResourceRecord,
  HarnessSkillScriptExecution,
  HarnessSkillScriptExecutionErrorCode,
  HarnessSkillScriptExecutionTarget,
  HarnessSkillScriptRuntime,
} from "../contracts/skill.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import { validateBrowserAccessLeaseFreshness } from "../contracts/browser-access.ts";
import {
  isSkillScriptAllowlisted,
  normalizeSkillScriptPath,
} from "../skills/scripts.ts";
import { normalizeCdpOrigin } from "./browser-host-command-policy.ts";
import { createClearedHostProcessEnv } from "./host-process-env.ts";
import type { HarnessToolDefinition } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

export interface RunSkillScriptToolInput {
  skill: string;
  path: string;
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  // Trusted harness/test plumbing for invocation input labels. This is omitted
  // from the public tool schema so model-authored tool calls do not mint labels.
  cfcInputLabels?: CfcLabelView;
}

export interface RunSkillScriptToolError {
  code: HarnessSkillScriptExecutionErrorCode;
  message: string;
}

export interface RunSkillScriptToolOutput {
  type: "cf-harness.run-skill-script-output";
  outputId: string;
  skill: string;
  path: string;
  status: "executed" | "error";
  executionTarget?: HarnessSkillScriptExecutionTarget;
  runtime?: HarnessSkillScriptRuntime;
  argv?: readonly string[];
  args?: readonly string[];
  cwd?: string;
  sandboxResourcePath?: string;
  registryDigest?: string;
  observedDigest?: string;
  digestMatchesRegistry?: boolean;
  registrySizeBytes?: number;
  observedSizeBytes?: number;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  cfcResult?: CfcSandboxResult;
  diagnostics: HarnessSkillDiagnostic[];
  error?: RunSkillScriptToolError;
}

export const isRunSkillScriptToolSuccessOutput = (
  output: unknown,
): output is RunSkillScriptToolOutput =>
  typeof output === "object" &&
  output !== null &&
  "type" in output &&
  output.type === "cf-harness.run-skill-script-output" &&
  "status" in output &&
  output.status === "executed";

export const runSkillScriptToolDescriptor: HarnessToolDescriptor = {
  toolId: "run_skill_script",
  title: "Run Skill Script",
  description:
    "Run an exact allowlisted script bundled under scripts/ in an explicitly configured cf-harness skill. The script must belong to an activated skill and match the run-start skill registry digest.",
  effectClass: "side-effect",
  inputSchema: {
    type: "object",
    properties: {
      skill: { type: "string" },
      path: {
        type: "string",
        description:
          "Path relative to the skill directory, under scripts/, such as scripts/check.ts.",
      },
      args: {
        type: "array",
        items: { type: "string" },
      },
      cwd: {
        type: "string",
        description:
          "Optional working directory inside the workspace. Defaults to the workspace root.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 0,
        maximum: MAX_TIMEOUT_MS,
      },
    },
    required: ["skill", "path"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    type: "object",
    properties: {
      type: { type: "string", const: "cf-harness.run-skill-script-output" },
      outputId: { type: "string" },
      skill: { type: "string" },
      path: { type: "string" },
      status: { type: "string", enum: ["executed", "error"] },
      executionTarget: { type: "string", enum: ["sandbox", "host"] },
      runtime: { type: "string", enum: ["deno", "shebang", "unknown"] },
      argv: { type: "array", items: { type: "string" } },
      args: { type: "array", items: { type: "string" } },
      cwd: { type: "string" },
      sandboxResourcePath: { type: "string" },
      registryDigest: { type: "string" },
      observedDigest: { type: "string" },
      digestMatchesRegistry: { type: "boolean" },
      registrySizeBytes: { type: "integer", minimum: 0 },
      observedSizeBytes: { type: "integer", minimum: 0 },
      stdout: { type: "string" },
      stderr: { type: "string" },
      exitCode: { type: "number" },
      cfcResult: { type: "object" },
      diagnostics: { type: "array", items: { type: "object" } },
      error: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
        },
        required: ["code", "message"],
        additionalProperties: false,
      },
    },
    required: [
      "type",
      "outputId",
      "skill",
      "path",
      "status",
      "diagnostics",
    ],
    additionalProperties: false,
  } satisfies JSONSchema,
  tags: ["skill", "script", "command"],
};

const isPathWithinRoot = (root: string, path: string): boolean => {
  const relativePath = relative(root, path);
  return relativePath === "" ||
    (!relativePath.startsWith("..") && relativePath !== ".." &&
      !isAbsolute(relativePath));
};

const sha256Digest = async (content: Uint8Array): Promise<string> => {
  const digestInput = content.buffer.slice(
    content.byteOffset,
    content.byteOffset + content.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return `sha256:${
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
};

const findSkill = (
  skills: readonly HarnessSkillRecord[],
  name: string,
): HarnessSkillRecord | undefined =>
  skills.find((skill) => skill.name === name);

const findResource = (
  skill: HarnessSkillRecord,
  path: string,
): HarnessSkillResourceRecord | undefined =>
  skill.resources.find((resource) => resource.path === path);

const normalizeArgs = (args: readonly string[] | undefined): string[] => {
  if (args === undefined) {
    return [];
  }
  if (!Array.isArray(args)) {
    throw new Error("run_skill_script args must be an array of strings");
  }
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new Error("run_skill_script args must be an array of strings");
    }
    if (arg.includes("\0")) {
      throw new Error("run_skill_script args must not contain null bytes");
    }
  }
  return [...args];
};

const normalizeTimeoutMs = (timeoutMs: number | undefined): number => {
  const resolved = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 0 ||
    resolved > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `run_skill_script timeoutMs must be an integer from 0 to ${MAX_TIMEOUT_MS}`,
    );
  }
  return resolved;
};

const findCdpArg = (
  args: readonly string[],
): { value?: string; error?: string } => {
  let value: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg !== "--cdp" && !arg.startsWith("--cdp=")) {
      continue;
    }
    if (value !== undefined) {
      return {
        error: "host agent-browser skill scripts may supply --cdp only once",
      };
    }
    if (arg === "--cdp") {
      value = args[index + 1];
      index += 1;
    } else {
      value = arg.slice("--cdp=".length);
    }
    if (value === undefined || value === "") {
      return {
        error: "host agent-browser skill scripts require a --cdp value",
      };
    }
  }
  return { value };
};

const validateHostAgentBrowserScriptArgs = (
  args: readonly string[],
  expectedCdpUrl: string | undefined,
  browserAccessExpiresAt: string | undefined,
): string | undefined => {
  const expiryError = validateBrowserAccessLeaseFreshness(
    browserAccessExpiresAt,
  );
  if (expiryError !== undefined) {
    return expiryError;
  }
  const expectedCdpOrigin = normalizeCdpOrigin(expectedCdpUrl);
  if (expectedCdpOrigin === undefined) {
    return "host agent-browser skill scripts require a Browser Access lease endpoint";
  }
  const cdpArg = findCdpArg(args);
  if (cdpArg.error !== undefined) {
    return cdpArg.error;
  }
  if (cdpArg.value === undefined) {
    return "host agent-browser skill scripts must pass --cdp explicitly";
  }
  return normalizeCdpOrigin(cdpArg.value) === expectedCdpOrigin
    ? undefined
    : "host agent-browser skill script --cdp must match the Browser Access lease endpoint";
};

const splitShebangWords = (shebang: string): string[] =>
  shebang.replace(/^#!/, "").trim().split(/\s+/).filter((word) =>
    word.length > 0
  );

const isDenoWord = (word: string): boolean =>
  basename(word).toLowerCase() === "deno";

const isBashWord = (word: string): boolean =>
  basename(word).toLowerCase() === "bash";

const commandWordsFromShebang = (shebang: string): string[] => {
  const words = splitShebangWords(shebang);
  if (words.length >= 3 && basename(words[0] ?? "").toLowerCase() === "env") {
    return words[1] === "-S" ? words.slice(2) : words.slice(1);
  }
  if (words.length >= 2 && basename(words[0] ?? "").toLowerCase() === "env") {
    return words.slice(1);
  }
  return words;
};

const denoRunFlagsFromShebang = (shebang: string | undefined): string[] => {
  if (shebang === undefined) {
    return [];
  }
  const commandWords = commandWordsFromShebang(shebang);
  const denoIndex = commandWords.findIndex(isDenoWord);
  if (denoIndex < 0 || commandWords[denoIndex + 1] !== "run") {
    return [];
  }
  const flags: string[] = [];
  for (const word of commandWords.slice(denoIndex + 2)) {
    if (!word.startsWith("-")) {
      break;
    }
    flags.push(word);
  }
  return flags;
};

interface ScriptExecution {
  runtime: HarnessSkillScriptRuntime;
  argv: string[];
  stdinText?: string;
}

type ScriptExecutionPlan =
  | { ok: true; execution: ScriptExecution }
  | { ok: false; error: RunSkillScriptToolError };

const decodeUtf8Script = (content: Uint8Array): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return undefined;
  }
};

interface SourceToken {
  kind: "word" | "string" | "punct";
  value: string;
}

const isIdentifierStart = (character: string): boolean =>
  /[A-Za-z_$]/.test(character);

const isIdentifierContinue = (character: string): boolean =>
  /[A-Za-z0-9_$]/.test(character);

const readStringToken = (
  source: string,
  start: number,
  quote: string,
): { value: string; end: number } => {
  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === "\\") {
      const escaped = source[index + 1];
      if (escaped !== undefined) {
        value += escaped;
        index += 1;
      }
      continue;
    }
    if (character === quote) {
      return { value, end: index + 1 };
    }
    value += character;
  }
  return { value, end: source.length };
};

const tokenizeModuleSource = (source: string): SourceToken[] => {
  const tokens: SourceToken[] = [];
  for (let index = 0; index < source.length;) {
    const character = source[index] ?? "";
    const next = source[index + 1];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        index += 1;
      }
      index = Math.min(index + 2, source.length);
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const stringToken = readStringToken(source, index, character);
      tokens.push({ kind: "string", value: stringToken.value });
      index = stringToken.end;
      continue;
    }
    if (isIdentifierStart(character)) {
      let end = index + 1;
      while (
        end < source.length && isIdentifierContinue(source[end] ?? "")
      ) {
        end += 1;
      }
      tokens.push({ kind: "word", value: source.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ kind: "punct", value: character });
    index += 1;
  }
  return tokens;
};

const isRelativeModuleSpecifier = (specifier: string): boolean =>
  specifier === "." ||
  specifier === ".." ||
  specifier.startsWith("./") ||
  specifier.startsWith("../");

const isRelativePathSpecifier = (specifier: string): boolean =>
  specifier === "." ||
  specifier === ".." ||
  specifier.startsWith("./") ||
  specifier.startsWith("../");

const findRelativeFromSpecifier = (
  tokens: readonly SourceToken[],
  start: number,
): string | undefined => {
  const maxEnd = Math.min(tokens.length, start + 128);
  for (let index = start; index < maxEnd; index += 1) {
    const token = tokens[index];
    if (token?.kind === "punct" && token.value === ";") {
      return undefined;
    }
    if (
      token?.kind === "word" &&
      (token.value === "import" || token.value === "export") &&
      index > start
    ) {
      return undefined;
    }
    if (token?.kind === "word" && token.value === "from") {
      const specifier = tokens[index + 1];
      if (
        specifier?.kind === "string" &&
        isRelativeModuleSpecifier(specifier.value)
      ) {
        return specifier.value;
      }
    }
  }
  return undefined;
};

const findRelativeModuleSpecifier = (source: string): string | undefined => {
  const tokens = tokenizeModuleSource(source);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind !== "word") {
      continue;
    }
    if (token.value === "import") {
      const next = tokens[index + 1];
      if (
        next?.kind === "string" && isRelativeModuleSpecifier(next.value)
      ) {
        return next.value;
      }
      if (next?.kind === "punct" && next.value === "(") {
        const specifier = tokens[index + 2];
        if (
          specifier?.kind === "string" &&
          isRelativeModuleSpecifier(specifier.value)
        ) {
          return specifier.value;
        }
        continue;
      }
      if (next?.kind === "punct" && next.value === ".") {
        continue;
      }
      const fromSpecifier = findRelativeFromSpecifier(tokens, index + 1);
      if (fromSpecifier !== undefined) {
        return fromSpecifier;
      }
      continue;
    }
    if (token.value === "export") {
      const fromSpecifier = findRelativeFromSpecifier(tokens, index + 1);
      if (fromSpecifier !== undefined) {
        return fromSpecifier;
      }
    }
  }
  return undefined;
};

const stripUnquotedShellComment = (line: string): string => {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (character === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if ((character === '"' || character === "'") && quote === undefined) {
      quote = character;
      continue;
    }
    if (character === quote) {
      quote = undefined;
      continue;
    }
    if (character === "#" && quote === undefined) {
      return line.slice(0, index);
    }
  }
  return line;
};

const unquoteShellToken = (token: string): string =>
  token.replace(/^(['"])(.*)\1$/, "$2");

const findRelativeShellSourceSpecifier = (
  source: string,
): string | undefined => {
  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripUnquotedShellComment(rawLine).trim();
    if (line.length === 0) {
      continue;
    }
    const match = /^(?:source|\.)\s+([^;&|<>()\s]+)/.exec(line);
    const specifier = match === null
      ? undefined
      : unquoteShellToken(match[1] ?? "");
    if (
      specifier !== undefined && isRelativePathSpecifier(specifier)
    ) {
      return specifier;
    }
  }
  return undefined;
};

const bashExecutionForShebang = (
  shebang: string | undefined,
  args: readonly string[],
  stdinText: string,
): ScriptExecution | undefined => {
  if (shebang === undefined) {
    return undefined;
  }
  const commandWords = commandWordsFromShebang(shebang);
  if (!isBashWord(commandWords[0] ?? "")) {
    return undefined;
  }
  if (commandWords.length > 1) {
    return undefined;
  }
  return {
    runtime: "shebang",
    argv: ["bash", "-s", "--", ...args],
    stdinText,
  };
};

const executionForScript = (
  resource: HarnessSkillResourceRecord,
  args: readonly string[],
  content: Uint8Array,
): ScriptExecutionPlan => {
  const runtime = resource.script?.runtime ?? "unknown";
  if (runtime === "deno") {
    const stdinText = decodeUtf8Script(content);
    if (stdinText === undefined) {
      return {
        ok: false,
        error: {
          code: "unsupported_runtime",
          message:
            `Deno skill script is not valid UTF-8 text: ${resource.path}`,
        },
      };
    }
    const relativeSpecifier = findRelativeModuleSpecifier(stdinText);
    if (relativeSpecifier !== undefined) {
      return {
        ok: false,
        error: {
          code: "unsupported_runtime",
          message:
            `Deno skill scripts must be standalone in v1; relative module specifier ${
              JSON.stringify(relativeSpecifier)
            } is not supported by run_skill_script.`,
        },
      };
    }
    return {
      ok: true,
      execution: {
        runtime,
        argv: [
          "deno",
          "run",
          ...denoRunFlagsFromShebang(resource.script?.shebang),
          "-",
          ...args,
        ],
        stdinText,
      },
    };
  }
  if (runtime === "shebang") {
    const stdinText = decodeUtf8Script(content);
    if (stdinText === undefined) {
      return {
        ok: false,
        error: {
          code: "unsupported_runtime",
          message:
            `Bash skill script is not valid UTF-8 text: ${resource.path}`,
        },
      };
    }
    const bashExecution = bashExecutionForShebang(
      resource.script?.shebang,
      args,
      stdinText,
    );
    if (bashExecution === undefined) {
      return {
        ok: false,
        error: {
          code: "unsupported_runtime",
          message:
            `unsupported skill script runtime for ${resource.path}: only Deno scripts and Bash shebang scripts without interpreter flags are supported in v1`,
        },
      };
    }
    const relativeSourceSpecifier = findRelativeShellSourceSpecifier(
      stdinText,
    );
    if (relativeSourceSpecifier !== undefined) {
      return {
        ok: false,
        error: {
          code: "unsupported_runtime",
          message:
            `Bash skill scripts must be standalone in v1; relative source specifier ${
              JSON.stringify(relativeSourceSpecifier)
            } is not supported by run_skill_script.`,
        },
      };
    }
    return { ok: true, execution: bashExecution };
  }
  return {
    ok: false,
    error: {
      code: "unsupported_runtime",
      message: `unsupported skill script runtime for ${resource.path}: ${
        resource.script?.runtime ?? "unknown"
      }`,
    },
  };
};

const baseOutput = (
  options: {
    outputId: string;
    skill: string;
    path: string;
    status: RunSkillScriptToolOutput["status"];
    executionTarget?: HarnessSkillScriptExecutionTarget;
    diagnostics?: HarnessSkillDiagnostic[];
  },
): RunSkillScriptToolOutput => ({
  type: "cf-harness.run-skill-script-output",
  outputId: options.outputId,
  skill: options.skill,
  path: options.path,
  status: options.status,
  ...(options.executionTarget !== undefined
    ? { executionTarget: options.executionTarget }
    : {}),
  diagnostics: options.diagnostics ?? [],
});

const errorOutput = (
  options: {
    outputId: string;
    skill: string;
    path: string;
    code: HarnessSkillScriptExecutionErrorCode;
    message: string;
    executionTarget?: HarnessSkillScriptExecutionTarget;
    diagnostics?: HarnessSkillDiagnostic[];
    resource?: HarnessSkillResourceRecord;
    observedDigest?: string;
    observedSizeBytes?: number;
  },
): RunSkillScriptToolOutput => ({
  ...baseOutput({
    outputId: options.outputId,
    skill: options.skill,
    path: options.path,
    status: "error",
    executionTarget: options.executionTarget,
    diagnostics: options.diagnostics,
  }),
  ...(options.resource !== undefined
    ? {
      runtime: options.resource.script?.runtime,
      sandboxResourcePath: options.resource.sandboxResourcePath,
      registryDigest: options.resource.digest,
      registrySizeBytes: options.resource.sizeBytes,
    }
    : {}),
  ...(options.observedDigest !== undefined
    ? { observedDigest: options.observedDigest }
    : {}),
  ...(options.observedSizeBytes !== undefined
    ? { observedSizeBytes: options.observedSizeBytes }
    : {}),
  ...(options.observedDigest !== undefined && options.resource !== undefined
    ? {
      digestMatchesRegistry: options.observedDigest === options.resource.digest,
    }
    : {}),
  error: {
    code: options.code,
    message: options.message,
  },
});

const buildExecutionRecord = (
  options: {
    output: RunSkillScriptToolOutput;
    runId: string;
    executedAt: string;
    resourcePath?: string;
  },
): HarnessSkillScriptExecution => ({
  type: "cf-harness.skill-script-execution",
  outputId: options.output.outputId,
  runId: options.runId,
  skillName: options.output.skill,
  path: options.output.path,
  status: options.output.status,
  executedAt: options.executedAt,
  ...(options.output.executionTarget !== undefined
    ? { executionTarget: options.output.executionTarget }
    : {}),
  ...(options.output.runtime !== undefined
    ? { runtime: options.output.runtime }
    : {}),
  ...(options.output.argv !== undefined ? { argv: options.output.argv } : {}),
  ...(options.output.args !== undefined ? { args: options.output.args } : {}),
  ...(options.output.cwd !== undefined ? { cwd: options.output.cwd } : {}),
  ...(options.resourcePath !== undefined
    ? { resourcePath: options.resourcePath }
    : {}),
  ...(options.output.sandboxResourcePath !== undefined
    ? { sandboxResourcePath: options.output.sandboxResourcePath }
    : {}),
  ...(options.output.registryDigest !== undefined
    ? { registryDigest: options.output.registryDigest }
    : {}),
  ...(options.output.observedDigest !== undefined
    ? { observedDigest: options.output.observedDigest }
    : {}),
  ...(options.output.digestMatchesRegistry !== undefined
    ? { digestMatchesRegistry: options.output.digestMatchesRegistry }
    : {}),
  ...(options.output.registrySizeBytes !== undefined
    ? { registrySizeBytes: options.output.registrySizeBytes }
    : {}),
  ...(options.output.observedSizeBytes !== undefined
    ? { observedSizeBytes: options.output.observedSizeBytes }
    : {}),
  ...(options.output.exitCode !== undefined
    ? { exitCode: options.output.exitCode }
    : {}),
  diagnostics: options.output.diagnostics,
  ...(options.output.error !== undefined
    ? { error: options.output.error }
    : {}),
});

export const runSkillScriptTool: HarnessToolDefinition<
  RunSkillScriptToolInput,
  RunSkillScriptToolOutput
> = {
  descriptor: runSkillScriptToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("run_skill_script");
    const executedAt = context.now();
    const executionTarget = context.skillScriptExecutionTarget;
    let normalizedPath: string;
    let args: string[];
    let timeoutMs: number;
    try {
      normalizedPath = normalizeSkillScriptPath(input.path);
      args = normalizeArgs(input.args);
      timeoutMs = normalizeTimeoutMs(input.timeoutMs);
    } catch (error) {
      const output = errorOutput({
        outputId,
        skill: input.skill,
        path: input.path,
        code: "script_path_invalid",
        message: error instanceof Error ? error.message : String(error),
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({ output, runId: context.runId, executedAt }),
      );
      return output;
    }

    if (context.skillRegistry === undefined) {
      const output = errorOutput({
        outputId,
        skill: input.skill,
        path: normalizedPath,
        code: "skill_registry_missing",
        message:
          "run_skill_script requires a run-start skill registry; configure --skills-root before using this tool",
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({ output, runId: context.runId, executedAt }),
      );
      return output;
    }
    if (context.skillActivations === undefined) {
      const output = errorOutput({
        outputId,
        skill: input.skill,
        path: normalizedPath,
        code: "skill_activations_missing",
        message:
          "run_skill_script requires an explicitly activated skill; configure --skill before using this tool",
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({ output, runId: context.runId, executedAt }),
      );
      return output;
    }

    const skill = findSkill(context.skillRegistry.skills, input.skill);
    if (skill === undefined) {
      const output = errorOutput({
        outputId,
        skill: input.skill,
        path: normalizedPath,
        code: "skill_not_found",
        message: `skill not found in registry: ${input.skill}`,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({ output, runId: context.runId, executedAt }),
      );
      return output;
    }
    if (
      !context.skillActivations.activations.some((activation) =>
        activation.name === skill.name
      )
    ) {
      const output = errorOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        code: "skill_not_activated",
        message: `skill is not activated for this run: ${skill.name}`,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({ output, runId: context.runId, executedAt }),
      );
      return output;
    }
    if (
      !isSkillScriptAllowlisted(context.allowedSkillScripts, {
        skill: skill.name,
        path: normalizedPath,
      })
    ) {
      const output = errorOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        code: "script_not_allowlisted",
        message:
          `skill script is not exactly allowlisted: ${skill.name}:${normalizedPath}`,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({ output, runId: context.runId, executedAt }),
      );
      return output;
    }

    const resource = findResource(skill, normalizedPath);
    if (resource === undefined) {
      const output = errorOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        code: "script_not_indexed",
        message:
          `script not found in run-start registry for skill ${skill.name}: ${normalizedPath}`,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({ output, runId: context.runId, executedAt }),
      );
      return output;
    }
    if (resource.kind !== "script") {
      const output = errorOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        code: "resource_not_script",
        message: `resource is not a script resource: ${normalizedPath}`,
        resource,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({
          output,
          runId: context.runId,
          executedAt,
          resourcePath: resource.resourcePath,
        }),
      );
      return output;
    }

    let resolvedSkillsRoot: string;
    let resolvedSkillDir: string;
    let resolvedResourcePath: string;
    try {
      resolvedSkillsRoot = await Deno.realPath(
        context.skillRegistry.skillsRoot,
      );
      resolvedSkillDir = await Deno.realPath(skill.skillDir);
      resolvedResourcePath = await Deno.realPath(resource.resourcePath);
    } catch (error) {
      const code = error instanceof Deno.errors.NotFound
        ? "script_not_found"
        : error instanceof Deno.errors.PermissionDenied
        ? "permission_denied"
        : "unknown";
      const output = errorOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        code,
        message: error instanceof Error ? error.message : String(error),
        resource,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({
          output,
          runId: context.runId,
          executedAt,
          resourcePath: resource.resourcePath,
        }),
      );
      return output;
    }
    if (
      !isPathWithinRoot(resolvedSkillDir, resolvedResourcePath) ||
      !isPathWithinRoot(resolvedSkillsRoot, resolvedResourcePath)
    ) {
      const output = errorOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        code: "script_outside_root",
        message:
          `script no longer resolves inside the skill directory and configured skills root: ${normalizedPath}`,
        resource,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({
          output,
          runId: context.runId,
          executedAt,
          resourcePath: resource.resourcePath,
        }),
      );
      return output;
    }

    let content: Uint8Array;
    try {
      const stat = await Deno.stat(resolvedResourcePath);
      if (!stat.isFile) {
        const output = errorOutput({
          outputId,
          skill: skill.name,
          path: normalizedPath,
          code: "script_not_file",
          message: `script is not a file: ${normalizedPath}`,
          resource,
        });
        await context.recordSkillScriptExecution(
          buildExecutionRecord({
            output,
            runId: context.runId,
            executedAt,
            resourcePath: resource.resourcePath,
          }),
        );
        return output;
      }
      content = await Deno.readFile(resolvedResourcePath);
    } catch (error) {
      const code = error instanceof Deno.errors.NotFound
        ? "script_not_found"
        : error instanceof Deno.errors.PermissionDenied
        ? "permission_denied"
        : "unknown";
      const output = errorOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        code,
        message: error instanceof Error ? error.message : String(error),
        resource,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({
          output,
          runId: context.runId,
          executedAt,
          resourcePath: resource.resourcePath,
        }),
      );
      return output;
    }

    const observedDigest = await sha256Digest(content);
    const observedSizeBytes = content.byteLength;
    if (
      observedDigest !== resource.digest ||
      observedSizeBytes !== resource.sizeBytes
    ) {
      const output = errorOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        code: "script_snapshot_mismatch",
        message:
          "Skill script differs from the run-start registry snapshot; refusing to execute active code.",
        resource,
        observedDigest,
        observedSizeBytes,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({
          output,
          runId: context.runId,
          executedAt,
          resourcePath: resource.resourcePath,
        }),
      );
      return output;
    }

    const scriptExecutionPlan = executionForScript(resource, args, content);
    if (!scriptExecutionPlan.ok) {
      const output = errorOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        code: scriptExecutionPlan.error.code,
        message: scriptExecutionPlan.error.message,
        resource,
        observedDigest,
        observedSizeBytes,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({
          output,
          runId: context.runId,
          executedAt,
          resourcePath: resource.resourcePath,
        }),
      );
      return output;
    }
    const scriptExecution = scriptExecutionPlan.execution;

    if (executionTarget === "host" && skill.name === "agent-browser") {
      const browserLeaseError = validateHostAgentBrowserScriptArgs(
        args,
        context.browserAccess?.cdpUrl,
        context.browserAccess?.expiresAt,
      );
      if (browserLeaseError !== undefined) {
        const output = errorOutput({
          outputId,
          skill: skill.name,
          path: normalizedPath,
          executionTarget,
          code: "permission_denied",
          message: browserLeaseError,
          resource,
          observedDigest,
          observedSizeBytes,
        });
        await context.recordSkillScriptExecution(
          buildExecutionRecord({
            output,
            runId: context.runId,
            executedAt,
            resourcePath: resource.resourcePath,
          }),
        );
        return output;
      }
    }

    const cwd = input.cwd !== undefined
      ? context.resolvePath(input.cwd)
      : context.sandbox.defaultWorkingDirectory();
    const hostCwd = executionTarget === "host"
      ? context.resolveHostPath(cwd)
      : undefined;
    if (
      hostCwd !== undefined &&
      (!(await context.isHostPathWithinWorkspace(hostCwd)) ||
        await context.isHostPathWithinArtifactRoot(hostCwd, {
          allowMissing: true,
        }))
    ) {
      const output = errorOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        executionTarget,
        code: "permission_denied",
        message:
          "host skill scripts must execute from a workspace path outside cf-harness artifacts",
        resource,
        observedDigest,
        observedSizeBytes,
      });
      await context.recordSkillScriptExecution(
        buildExecutionRecord({
          output,
          runId: context.runId,
          executedAt,
          resourcePath: resource.resourcePath,
        }),
      );
      return output;
    }
    const sandboxEnv = {
      CF_HARNESS_RUN_ID: context.runId,
      SKILL_NAME: skill.name,
      SKILL_DIR: skill.sandboxSkillDir,
      SKILL_SCRIPT: resource.sandboxResourcePath,
      CF_HARNESS_SKILL_SCRIPT_EXECUTION_TARGET: executionTarget,
    };
    const result = executionTarget === "host"
      ? await context.hostProcessRunner.run({
        command: scriptExecution.argv[0]!,
        args: scriptExecution.argv.slice(1),
        cwd: hostCwd,
        clearEnv: true,
        env: createClearedHostProcessEnv({
          CF_HARNESS_RUN_ID: context.runId,
          SKILL_NAME: skill.name,
          SKILL_DIR: skill.skillDir,
          SKILL_SCRIPT: resource.resourcePath,
          CF_HARNESS_SKILL_SCRIPT_EXECUTION_TARGET: executionTarget,
        }),
        ...(scriptExecution.stdinText !== undefined
          ? { stdinText: scriptExecution.stdinText }
          : {}),
        timeoutMs,
      })
      : await context.sandbox.run({
        argv: scriptExecution.argv,
        cwd,
        env: sandboxEnv,
        ...(scriptExecution.stdinText !== undefined
          ? { stdinText: scriptExecution.stdinText }
          : {}),
        timeoutMs,
        cfcInvocationContext: await context.createCfcInvocationContext({
          toolId: "run_skill_script",
          toolOutputId: outputId,
          operation: "command",
          cwd,
          argv: scriptExecution.argv,
          args,
          env: sandboxEnv,
          ...(scriptExecution.stdinText !== undefined
            ? { stdinText: scriptExecution.stdinText }
            : {}),
          ...(input.cfcInputLabels !== undefined
            ? { cfcInputLabels: input.cfcInputLabels }
            : {}),
          cfcInputLabelPaths: input.cwd !== undefined
            ? [["argv"], ["args"], ["cwd"], ["env"]]
            : [["argv"], ["args"], ["env"]],
        }),
      });

    const cfcResult = (result as { cfcResult?: CfcSandboxResult }).cfcResult;
    const output: RunSkillScriptToolOutput = {
      ...baseOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        status: "executed",
        executionTarget,
      }),
      runtime: scriptExecution.runtime,
      argv: scriptExecution.argv,
      args,
      cwd,
      sandboxResourcePath: resource.sandboxResourcePath,
      registryDigest: resource.digest,
      observedDigest,
      digestMatchesRegistry: true,
      registrySizeBytes: resource.sizeBytes,
      observedSizeBytes,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      ...(cfcResult !== undefined ? { cfcResult } : {}),
    };
    await context.recordSkillScriptExecution(
      buildExecutionRecord({
        output,
        runId: context.runId,
        executedAt,
        resourcePath: resource.resourcePath,
      }),
    );
    return output;
  },
};
