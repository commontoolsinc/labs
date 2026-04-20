import type { JSONSchema } from "@commonfabric/api";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessToolDefinition } from "./types.ts";

export type WriteFileMode = "replace" | "append";

export interface WriteFileToolInput {
  path: string;
  content: string;
  mode?: WriteFileMode;
  createParents?: boolean;
}

export interface WriteFileToolOutput {
  outputId: string;
  path: string;
  mode: WriteFileMode;
}

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
    type: "object",
    properties: {
      outputId: { type: "string" },
      path: { type: "string" },
      mode: { type: "string", enum: [...WRITE_FILE_MODES] },
    },
    required: ["outputId", "path", "mode"],
    additionalProperties: false,
  } satisfies JSONSchema,
  tags: ["file", "write", "vm"],
};

export const writeFileTool: HarnessToolDefinition<
  WriteFileToolInput,
  WriteFileToolOutput
> = {
  descriptor: writeFileToolDescriptor,
  async invoke(context, input) {
    const resolvedPath = context.sandbox.resolvePath(input.path);
    const mode = input.mode ?? "replace";
    await context.sandbox.runShell({
      command: [
        "set -eu",
        'path="$1"',
        'mode="$2"',
        'create_parents="$3"',
        'if [ "$create_parents" = "true" ]; then',
        '  mkdir -p "$(dirname "$path")"',
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
        "    exit 2",
        "    ;;",
        "esac",
      ].join("\n"),
      args: [resolvedPath, mode, String(input.createParents ?? false)],
      stdinText: input.content,
    });
    return {
      outputId: context.nextOutputId("write_file"),
      path: resolvedPath,
      mode,
    };
  },
};
