import type { JSONSchema } from "@commonfabric/api";
import type { CfcLabelView, CfcSandboxResult } from "@commonfabric/runner/cfc";
import type { CfcSandboxResultOrigin } from "../sandbox/types.ts";
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

export interface WriteFileToolSuccessOutput {
  outputId: string;
  path: string;
  mode: WriteFileMode;

  /**
   * The sandbox's own CFC result for the write. Kept on the output — and
   * stripped before the model sees it — as the run's record of what the write
   * was exposed to.
   *
   * A PERSISTED EVIDENCE SURFACE, and one of two this package adds. It is
   * NOT what the run's taint is read from: that is collected at the sandbox
   * invocation boundary, precisely so a tool cannot lose it by dropping a
   * field. Nothing reads this as a source of labels. It is evidence for a
   * reader of the run, and a write whose result is absent here costs the
   * record rather than any decision.
   */
  cfcResult?: CfcSandboxResult;

  /**
   * Where that result came from: runsc's own report, or a value the runtime
   * synthesized because it had none.
   *
   * It travels with the result because it is what separates the two records
   * a reader cannot otherwise tell apart. A synthesized denied result carries
   * an empty label, and so does a runsc report of a public container; without
   * the origin beside it, a reader of this artifact would read "the runtime
   * had nothing to say" as "the container was public". Absent whenever
   * `cfcResult` is.
   */
  cfcResultOrigin?: CfcSandboxResultOrigin;
}

export type WriteFileToolOutput =
  | WriteFileToolSuccessOutput
  | StructuredFileToolErrorOutput;

export const WRITE_FILE_MODES: readonly WriteFileMode[] = [
  "replace",
  "append",
];

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
        cfcResult: { type: "object" },
        cfcResultOrigin: { type: "string" },
      },
      required: ["outputId", "path", "mode"],
      additionalProperties: false,
    }, structuredFileToolErrorOutputSchema],
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
): { cfcResult?: CfcSandboxResult; cfcResultOrigin?: CfcSandboxResultOrigin } =>
  result.cfcResult === undefined ? {} : {
    cfcResult: result.cfcResult,
    ...(result.cfcResultOrigin !== undefined
      ? { cfcResultOrigin: result.cfcResultOrigin }
      : {}),
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
