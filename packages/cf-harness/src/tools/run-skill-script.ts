import type { JSONSchema } from "@commonfabric/api";
import type { CfcLabelView, CfcSandboxResult } from "@commonfabric/runner/cfc";
import { basename, isAbsolute, relative } from "@std/path";
import type {
  HarnessSkillDiagnostic,
  HarnessSkillRecord,
  HarnessSkillResourceRecord,
  HarnessSkillScriptExecution,
  HarnessSkillScriptExecutionErrorCode,
  HarnessSkillScriptRuntime,
} from "../contracts/skill.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import {
  isSkillScriptAllowlisted,
  normalizeSkillScriptPath,
} from "../skills/scripts.ts";
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

const splitShebangWords = (shebang: string): string[] =>
  shebang.replace(/^#!/, "").trim().split(/\s+/).filter((word) =>
    word.length > 0
  );

const isDenoWord = (word: string): boolean => basename(word) === "deno";

const denoRunFlagsFromShebang = (shebang: string | undefined): string[] => {
  if (shebang === undefined) {
    return [];
  }
  const words = splitShebangWords(shebang);
  const commandWords = words.length >= 3 &&
      basename(words[0] ?? "") === "env" &&
      words[1] === "-S"
    ? words.slice(2)
    : words.length >= 2 &&
        basename(words[0] ?? "") === "env" &&
        isDenoWord(words[1] ?? "")
    ? words.slice(1)
    : words;
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

const argvForScript = (
  resource: HarnessSkillResourceRecord,
  args: readonly string[],
): { runtime: HarnessSkillScriptRuntime; argv: string[] } | undefined => {
  const runtime = resource.script?.runtime ?? "unknown";
  if (runtime === "deno") {
    return {
      runtime,
      argv: [
        "deno",
        "run",
        ...denoRunFlagsFromShebang(resource.script?.shebang),
        resource.sandboxResourcePath,
        ...args,
      ],
    };
  }
  if (
    runtime === "shebang" &&
    resource.script?.executable === true &&
    resource.script.shebang !== undefined
  ) {
    return {
      runtime,
      argv: [resource.sandboxResourcePath, ...args],
    };
  }
  return undefined;
};

const baseOutput = (
  options: {
    outputId: string;
    skill: string;
    path: string;
    status: RunSkillScriptToolOutput["status"];
    diagnostics?: HarnessSkillDiagnostic[];
  },
): RunSkillScriptToolOutput => ({
  type: "cf-harness.run-skill-script-output",
  outputId: options.outputId,
  skill: options.skill,
  path: options.path,
  status: options.status,
  diagnostics: options.diagnostics ?? [],
});

const errorOutput = (
  options: {
    outputId: string;
    skill: string;
    path: string;
    code: HarnessSkillScriptExecutionErrorCode;
    message: string;
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

    const scriptArgv = argvForScript(resource, args);
    if (scriptArgv === undefined) {
      const output = errorOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        code: "unsupported_runtime",
        message: `unsupported skill script runtime for ${normalizedPath}: ${
          resource.script?.runtime ?? "unknown"
        }`,
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

    const cwd = input.cwd !== undefined
      ? context.resolvePath(input.cwd)
      : context.sandbox.defaultWorkingDirectory();
    const env = {
      CF_HARNESS_RUN_ID: context.runId,
      SKILL_NAME: skill.name,
      SKILL_DIR: skill.sandboxSkillDir,
      SKILL_SCRIPT: resource.sandboxResourcePath,
    };
    const result = await context.sandbox.run({
      argv: scriptArgv.argv,
      cwd,
      env,
      timeoutMs,
      cfcInvocationContext: await context.createCfcInvocationContext({
        toolId: "run_skill_script",
        toolOutputId: outputId,
        operation: "command",
        cwd,
        argv: scriptArgv.argv,
        args,
        env,
        ...(input.cfcInputLabels !== undefined
          ? { cfcInputLabels: input.cfcInputLabels }
          : {}),
        cfcInputLabelPaths: input.cwd !== undefined
          ? [["argv"], ["args"], ["cwd"], ["env"]]
          : [["argv"], ["args"], ["env"]],
      }),
    });

    const output: RunSkillScriptToolOutput = {
      ...baseOutput({
        outputId,
        skill: skill.name,
        path: normalizedPath,
        status: "executed",
      }),
      runtime: scriptArgv.runtime,
      argv: scriptArgv.argv,
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
      ...(result.cfcResult !== undefined
        ? { cfcResult: result.cfcResult }
        : {}),
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
