import type { CfcEnforcementMode } from "@commonfabric/runner/cfc";
import type { PromptSlotBinding } from "./prompt-slot.ts";
import type { HarnessRunManifest } from "./run-manifest.ts";
import type { BuiltinToolId } from "./tool-descriptor.ts";
import type { ToolOutputId } from "./tool-result.ts";

export type HarnessCfcInvocationOperation = "command" | "shell";

export interface HarnessCfcRedactedTextSummary {
  type: "cf-harness.redacted-text-summary";
  bytes: number;
  digest: string;
}

export interface HarnessCfcRedactedSequenceSummary {
  type: "cf-harness.redacted-sequence-summary";
  count: number;
  totalBytes: number;
  digest: string;
}

export interface HarnessCfcEnvSummary {
  type: "cf-harness.env-summary";
  count: number;
  names: readonly string[];
}

export interface HarnessCfcInvocationInputSummary {
  command?: HarnessCfcRedactedTextSummary;
  argv?: HarnessCfcRedactedSequenceSummary;
  args?: HarnessCfcRedactedSequenceSummary;
  stdin?: HarnessCfcRedactedTextSummary;
  env?: HarnessCfcEnvSummary;
}

export interface HarnessCfcInvocationRunManifestSummary {
  present: boolean;
  path?: string;
  source?: string;
  wishId?: string;
  dispatchClass?: string;
  cfcEnforcementMode?: CfcEnforcementMode;
  promptSlotPresent?: boolean;
}

export interface HarnessCfcInvocationContext {
  type: "cf-harness.cfc-invocation-context";
  version: 1;
  sequence: number;
  runId: string;
  createdAt: string;
  toolId: BuiltinToolId | string;
  toolOutputId?: ToolOutputId;
  operation: HarnessCfcInvocationOperation;
  cfcEnforcementMode: CfcEnforcementMode;
  cwd: string;
  promptSlot?: PromptSlotBinding;
  runManifest: HarnessCfcInvocationRunManifestSummary;
  inputs: HarnessCfcInvocationInputSummary;
}

export interface CreateHarnessCfcInvocationContextOptions {
  sequence: number;
  runId: string;
  createdAt: string;
  toolId: BuiltinToolId | string;
  toolOutputId?: ToolOutputId;
  operation: HarnessCfcInvocationOperation;
  cfcEnforcementMode: CfcEnforcementMode;
  cwd: string;
  promptSlot?: PromptSlotBinding;
  runManifest: HarnessCfcInvocationRunManifestSummary;
  command?: string;
  argv?: readonly string[];
  args?: readonly string[];
  stdinText?: string;
  env?: Record<string, string>;
}

const textEncoder = new TextEncoder();

const bytesForText = (text: string): Uint8Array => textEncoder.encode(text);

const sha256Digest = async (input: Uint8Array): Promise<string> => {
  const digestInput = input.buffer.slice(
    input.byteOffset,
    input.byteOffset + input.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  return `sha256:${
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
};

export const summarizeCfcInvocationText = async (
  text: string,
): Promise<HarnessCfcRedactedTextSummary> => {
  const bytes = bytesForText(text);
  return {
    type: "cf-harness.redacted-text-summary",
    bytes: bytes.byteLength,
    digest: await sha256Digest(bytes),
  };
};

export const summarizeCfcInvocationSequence = async (
  values: readonly string[],
): Promise<HarnessCfcRedactedSequenceSummary> => {
  const totalBytes = values.reduce(
    (total, value) => total + bytesForText(value).byteLength,
    0,
  );
  return {
    type: "cf-harness.redacted-sequence-summary",
    count: values.length,
    totalBytes,
    digest: await sha256Digest(bytesForText(JSON.stringify(values))),
  };
};

export const summarizeCfcInvocationEnv = (
  env: Record<string, string> | undefined,
): HarnessCfcEnvSummary | undefined => {
  if (env === undefined) {
    return undefined;
  }
  return {
    type: "cf-harness.env-summary",
    count: Object.keys(env).length,
    names: Object.keys(env).sort(),
  };
};

export const summarizeCfcInvocationRunManifest = (
  manifest: HarnessRunManifest | undefined,
  path: string | undefined,
): HarnessCfcInvocationRunManifestSummary => ({
  present: manifest !== undefined || path !== undefined,
  ...(path !== undefined ? { path } : {}),
  ...(manifest !== undefined
    ? {
      source: manifest.source,
      ...(manifest.wishId !== undefined ? { wishId: manifest.wishId } : {}),
      ...(manifest.dispatchClass !== undefined
        ? { dispatchClass: manifest.dispatchClass }
        : {}),
      ...(manifest.cfc?.enforcementMode !== undefined
        ? { cfcEnforcementMode: manifest.cfc.enforcementMode }
        : {}),
      promptSlotPresent: manifest.promptSlot !== undefined,
    }
    : {}),
});

export const createHarnessCfcInvocationContext = async (
  options: CreateHarnessCfcInvocationContextOptions,
): Promise<HarnessCfcInvocationContext> => {
  const command = options.command === undefined
    ? undefined
    : await summarizeCfcInvocationText(options.command);
  const argv = options.argv === undefined
    ? undefined
    : await summarizeCfcInvocationSequence(options.argv);
  const args = options.args === undefined
    ? undefined
    : await summarizeCfcInvocationSequence(options.args);
  const stdin = options.stdinText === undefined
    ? undefined
    : await summarizeCfcInvocationText(options.stdinText);
  const env = summarizeCfcInvocationEnv(options.env);

  return {
    type: "cf-harness.cfc-invocation-context",
    version: 1,
    sequence: options.sequence,
    runId: options.runId,
    createdAt: options.createdAt,
    toolId: options.toolId,
    ...(options.toolOutputId !== undefined
      ? { toolOutputId: options.toolOutputId }
      : {}),
    operation: options.operation,
    cfcEnforcementMode: options.cfcEnforcementMode,
    cwd: options.cwd,
    ...(options.promptSlot !== undefined
      ? { promptSlot: options.promptSlot }
      : {}),
    runManifest: options.runManifest,
    inputs: {
      ...(command !== undefined ? { command } : {}),
      ...(argv !== undefined ? { argv } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(stdin !== undefined ? { stdin } : {}),
      ...(env !== undefined ? { env } : {}),
    },
  };
};
