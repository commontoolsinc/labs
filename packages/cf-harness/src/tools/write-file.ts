import type { JSONSchema } from "@commonfabric/api";
import type { CfcLabelView, CfcSandboxResult } from "@commonfabric/runner/cfc";
import {
  CFC_SANDBOX_RESULT_ORIGINS,
  type CfcSandboxResultOrigin,
} from "../sandbox/types.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessToolDefinition } from "./types.ts";
import {
  classifyFileToolShellFailure,
  classifyPathResolutionError,
  createStructuredFileToolErrorOutput,
  detailFromShellFailure,
  detailFromUnknownError,
  type StructuredFileToolErrorOutput,
  structuredFileToolErrorOutputSchema,
} from "./file-errors.ts";
import {
  isResolvedPathInsideArtifactRoot,
  RESERVED_ARTIFACT_PATH_DETAIL,
} from "./reserved-artifacts.ts";

export type WriteFileMode = "replace" | "append";

export interface WriteFileToolInput {
  path: string;
  content: string;
  mode?: WriteFileMode;
  createParents?: boolean;
  // Trusted harness/test plumbing for invocation input labels. This is omitted
  // from the public tool schema so model-authored tool calls do not mint labels.
  cfcInputLabels?: CfcLabelView;
}

/**
 * The sandbox's record of what one write was exposed to: result and origin,
 * never one without the other.
 *
 * A PERSISTED EVIDENCE SURFACE, and one of two this package adds. It is NOT
 * what the run's taint is read from — that is collected at the sandbox
 * invocation boundary, precisely so a tool cannot lose it by dropping a
 * field. Nothing reads this as a source of labels. It is evidence for a
 * reader of the run, and a write whose result is absent here costs the record
 * rather than any decision.
 *
 * The two travel together because the origin is what separates the two
 * records a reader cannot otherwise tell apart: a result the runtime
 * synthesized carries an empty label, and so does runsc's report of a public
 * container. A result on its own would be read as the second, which is the
 * "we had nothing to say" that reads as "nothing was carried". Declared as a
 * pair rather than as two optional fields so that a record holding one of
 * them is a value this cannot construct.
 */
export interface WriteFileToolCfcEvidence {
  cfcResult: CfcSandboxResult;
  cfcResultOrigin: CfcSandboxResultOrigin;
}

/** `T`, carrying the evidence pair or carrying neither half of it. */
export type WithCfcEvidence<T> =
  | (T & WriteFileToolCfcEvidence)
  | (T & { cfcResult?: never; cfcResultOrigin?: never });

export interface WriteFileToolWroteOutput {
  outputId: string;
  path: string;
  mode: WriteFileMode;
}

export type WriteFileToolSuccessOutput = WithCfcEvidence<
  WriteFileToolWroteOutput
>;

/**
 * A failed write carries the evidence too: a command that exited non-zero may
 * still have truncated or partly written its target, so what that write was
 * exposed to is worth the same here as on the success path.
 */
export type WriteFileToolFailureOutput = WithCfcEvidence<
  StructuredFileToolErrorOutput
>;

export type WriteFileToolOutput =
  | WriteFileToolSuccessOutput
  | WriteFileToolFailureOutput;

export const WRITE_FILE_MODES: readonly WriteFileMode[] = [
  "replace",
  "append",
];

/**
 * The evidence pair as schema, for both arms of the output.
 *
 * `dependentRequired` is the pair stated where a validator can act on it: a
 * record holding one half is refused rather than accepted as a record that
 * happens to be missing a field. The failure arm needs these declared as much
 * as the success arm does — its schema closes to additional properties, so
 * evidence on a failed write would otherwise make the persisted shape
 * something the declared contract rejects.
 */
const CFC_EVIDENCE_SCHEMA_PROPERTIES = {
  cfcResult: { type: "object" },
  cfcResultOrigin: { type: "string", enum: [...CFC_SANDBOX_RESULT_ORIGINS] },
} as const;

const CFC_EVIDENCE_SCHEMA_DEPENDENCIES = {
  dependentRequired: {
    cfcResult: ["cfcResultOrigin"],
    cfcResultOrigin: ["cfcResult"],
  },
} as const;

export const writeFileToolDescriptor: HarnessToolDescriptor = {
  toolId: "write_file",
  title: "Write File",
  description:
    "Write or append file content inside the target VM through a structured file-write path.",
  effectClass: "write",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      mode: { type: "string", enum: [...WRITE_FILE_MODES] },
      createParents: { type: "boolean" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        outputId: { type: "string" },
        path: { type: "string" },
        mode: { type: "string", enum: [...WRITE_FILE_MODES] },
        ...CFC_EVIDENCE_SCHEMA_PROPERTIES,
      },
      required: ["outputId", "path", "mode"],
      additionalProperties: false,
      ...CFC_EVIDENCE_SCHEMA_DEPENDENCIES,
    }, {
      ...structuredFileToolErrorOutputSchema,
      properties: {
        ...structuredFileToolErrorOutputSchema.properties,
        ...CFC_EVIDENCE_SCHEMA_PROPERTIES,
      },
      ...CFC_EVIDENCE_SCHEMA_DEPENDENCIES,
    }],
  } satisfies JSONSchema,
  tags: ["file", "write", "vm"],
};

/**
 * The sandbox's evidence for one write, result and origin together.
 *
 * Together because either alone is a record a reader can misread: a result
 * without its origin cannot be told from a synthesized one, and an origin
 * without a result describes nothing. A sandbox that reported neither leaves
 * neither, and the run's taint — collected at the invocation boundary, where
 * no tool can drop it — is what says an invocation happened at all.
 */
const cfcEvidenceOf = (
  result: {
    cfcResult?: CfcSandboxResult;
    cfcResultOrigin?: CfcSandboxResultOrigin;
  },
): WriteFileToolCfcEvidence | Record<PropertyKey, never> =>
  result.cfcResult === undefined ? {} : {
    cfcResult: result.cfcResult,
    // A runtime that reported a result and no origin did not say where it came
    // from, and the taint reader already reads that silence as synthetic —
    // only `runsc-taint` counts as runsc's own. Writing it down here rather
    // than leaving the field off keeps the record self-describing, and keeps
    // "the runtime had nothing to say" from reading as a public container.
    cfcResultOrigin: result.cfcResultOrigin ?? "synthetic",
  };

export const writeFileTool: HarnessToolDefinition<
  WriteFileToolInput,
  WriteFileToolOutput
> = {
  descriptor: writeFileToolDescriptor,
  async invoke(context, input) {
    let resolvedPath: string;
    try {
      resolvedPath = context.resolvePath(input.path);
    } catch (error) {
      return createStructuredFileToolErrorOutput(context, "write_file", {
        path: input.path,
        code: classifyPathResolutionError(error),
        detail: detailFromUnknownError(error),
      });
    }
    if (await isResolvedPathInsideArtifactRoot(context, resolvedPath)) {
      return createStructuredFileToolErrorOutput(context, "write_file", {
        path: resolvedPath,
        code: "permission_denied",
        detail: RESERVED_ARTIFACT_PATH_DETAIL,
      });
    }
    const mode = input.mode ?? "replace";
    const outputId = context.nextOutputId("write_file");
    const command = [
      "set -eu",
      'path="$1"',
      'mode="$2"',
      'create_parents="$3"',
      'parent="$(dirname "$path")"',
      'if [ "$create_parents" = "true" ]; then',
      '  mkdir -p "$parent"',
      'elif [ ! -d "$parent" ]; then',
      '  echo "file not found: parent directory $parent" >&2',
      "  exit 10",
      "fi",
      'if [ -e "$path" ] && [ ! -f "$path" ]; then',
      '  echo "not a file: $path" >&2',
      "  exit 11",
      "fi",
      'case "$mode" in',
      "  replace)",
      '    cat > "$path"',
      "    ;;",
      "  append)",
      '    cat >> "$path"',
      "    ;;",
      "  *)",
      '    echo "unsupported write mode: $mode" >&2',
      "    exit 12",
      "    ;;",
      "esac",
    ].join("\n");
    const args = [resolvedPath, mode, String(input.createParents ?? false)];
    const result = await context.sandbox.runShell({
      command,
      args,
      cwd: context.currentDir,
      stdinText: input.content,
      cfcInvocationContext: await context.createCfcInvocationContext({
        toolId: "write_file",
        toolOutputId: outputId,
        operation: "shell",
        cwd: context.currentDir,
        command,
        args,
        stdinText: input.content,
        ...(input.cfcInputLabels !== undefined
          ? { cfcInputLabels: input.cfcInputLabels }
          : {}),
        // write_file is a CFC sink: both the selected destination/mode args and
        // the bytes written on stdin are model-authored invocation inputs.
        cfcInputLabelPaths: [["args"], ["stdin"]],
      }),
    });
    if (result.exitCode !== 0) {
      // The evidence travels with the failure too: a command that exited
      // non-zero may still have truncated or partly written its target.
      return {
        ...createStructuredFileToolErrorOutput(context, "write_file", {
          outputId,
          path: resolvedPath,
          code: classifyFileToolShellFailure(result),
          detail: detailFromShellFailure(result),
          exitCode: result.exitCode,
        }),
        ...cfcEvidenceOf(result),
      };
    }
    return {
      outputId,
      path: resolvedPath,
      mode,
      ...cfcEvidenceOf(result),
    };
  },
};
