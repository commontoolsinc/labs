import type { JSONSchema } from "@commonfabric/api";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface ReadFileToolInput {
  path: string;
  encoding?: "utf-8";
  maxBytes?: number;
}

export interface ReadFileToolOutput {
  outputId: string;
  path: string;
  content: string;
}

export const readFileToolDescriptor: HarnessToolDescriptor = {
  toolId: "read_file",
  title: "Read File",
  description:
    "Read a file from the target VM through a structured file-read path.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      encoding: { type: "string", enum: ["utf-8"] },
      maxBytes: { type: "integer", minimum: 0 },
    },
    required: ["path"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    type: "object",
    properties: {
      outputId: { type: "string" },
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["outputId", "path", "content"],
    additionalProperties: false,
  } satisfies JSONSchema,
  tags: ["file", "read", "vm"],
};

export const readFileTool: HarnessToolDefinition<
  ReadFileToolInput,
  ReadFileToolOutput
> = {
  descriptor: readFileToolDescriptor,
  async invoke(context, input) {
    if (
      input.maxBytes !== undefined &&
      (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0)
    ) {
      throw new Error("read_file maxBytes must be a non-negative integer");
    }
    const resolvedPath = context.resolvePath(input.path);
    const result = await context.sandbox.runShell({
      command: [
        "set -eu",
        'if [ ! -f "$1" ]; then',
        '  echo "file not found: $1" >&2',
        "  exit 1",
        "fi",
        'if [ -n "$2" ]; then',
        '  exec head -c "$2" "$1"',
        "fi",
        'exec cat "$1"',
      ].join("\n"),
      args: [
        resolvedPath,
        input.maxBytes !== undefined ? String(input.maxBytes) : "",
      ],
    });
    return {
      outputId: context.nextOutputId("read_file"),
      path: resolvedPath,
      content: result.stdout,
    };
  },
};
