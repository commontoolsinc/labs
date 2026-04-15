import type { JSONSchema } from "@commonfabric/api";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import {
  createUnimplementedToolError,
  type HarnessToolDefinition,
} from "./types.ts";

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
      maxBytes: { type: "number", minimum: 0 },
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
  async invoke() {
    throw createUnimplementedToolError("read_file");
  },
};
