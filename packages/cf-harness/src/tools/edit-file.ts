import type { JSONSchema } from "@commonfabric/api";
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

export interface EditFileTextEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  expectedReplacements?: number;
}

export interface EditFileToolInput {
  path: string;
  edits: EditFileTextEdit[];
  expectedDigest?: string;
}

export interface EditFileToolSuccessOutput {
  outputId: string;
  path: string;
  editsApplied: number;
  replacements: number;
  oldDigest: string;
  newDigest: string;
  oldSizeBytes: number;
  newSizeBytes: number;
  diff: string;
}

export type EditFileToolOutput =
  | EditFileToolSuccessOutput
  | StructuredFileToolErrorOutput;

interface AppliedEditResult {
  content: string;
  replacements: number;
}

interface ApplyEditsResult {
  content: string;
  replacements: number;
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

const summarizeText = async (
  text: string,
): Promise<{ bytes: number; digest: string }> => {
  const bytes = bytesForText(text);
  return {
    bytes: bytes.byteLength,
    digest: await sha256Digest(bytes),
  };
};

const findOccurrences = (content: string, needle: string): number[] => {
  const positions: number[] = [];
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(needle, offset);
    if (index === -1) {
      break;
    }
    positions.push(index);
    offset = index + needle.length;
  }
  return positions;
};

const validateExpectedReplacements = (
  edit: EditFileTextEdit,
  editIndex: number,
): number | undefined => {
  if (edit.expectedReplacements === undefined) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(edit.expectedReplacements) ||
    edit.expectedReplacements <= 0
  ) {
    throw new Error(
      `edit ${editIndex + 1} expectedReplacements must be a positive integer`,
    );
  }
  if (edit.expectedReplacements !== 1 && edit.replaceAll !== true) {
    throw new Error(
      `edit ${
        editIndex + 1
      } expectedReplacements greater than 1 requires replaceAll=true`,
    );
  }
  return edit.expectedReplacements;
};

const applySingleEdit = (
  content: string,
  edit: EditFileTextEdit,
  editIndex: number,
): AppliedEditResult => {
  if (edit.oldText.length === 0) {
    throw new Error(`edit ${editIndex + 1} oldText must be non-empty`);
  }
  const expectedReplacements = validateExpectedReplacements(edit, editIndex);
  const occurrences = findOccurrences(content, edit.oldText);
  if (occurrences.length === 0) {
    throw new Error(`edit ${editIndex + 1} oldText was not found`);
  }
  if (
    expectedReplacements !== undefined &&
    occurrences.length !== expectedReplacements
  ) {
    throw new Error(
      `edit ${
        editIndex + 1
      } expected ${expectedReplacements} replacement(s) but found ${occurrences.length}`,
    );
  }
  if (edit.replaceAll === true) {
    return {
      content: content.split(edit.oldText).join(edit.newText),
      replacements: occurrences.length,
    };
  }
  if (occurrences.length !== 1) {
    throw new Error(
      `edit ${
        editIndex + 1
      } oldText matched ${occurrences.length} times; provide more surrounding context or set replaceAll=true`,
    );
  }
  const index = occurrences[0]!;
  return {
    content: content.slice(0, index) + edit.newText +
      content.slice(index + edit.oldText.length),
    replacements: 1,
  };
};

const applyEdits = (
  content: string,
  edits: readonly EditFileTextEdit[],
): ApplyEditsResult => {
  if (edits.length === 0) {
    throw new Error("edit_file edits must include at least one edit");
  }
  let nextContent = content;
  let replacements = 0;
  for (const [index, edit] of edits.entries()) {
    const result = applySingleEdit(nextContent, edit, index);
    nextContent = result.content;
    replacements += result.replacements;
  }
  return { content: nextContent, replacements };
};

const splitLines = (text: string): string[] => {
  if (text.length === 0) {
    return [];
  }
  const parts = text.split("\n");
  const lines = parts.map((line, index) =>
    index < parts.length - 1 ? `${line}\n` : line
  );
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
};

const renderDiffLine = (prefix: string, line: string): string =>
  `${prefix}${line.endsWith("\n") ? line.slice(0, -1) : line}`;

const rangeHeader = (startZeroBased: number, count: number): string =>
  `${startZeroBased + 1},${count}`;

const createUnifiedDiff = (
  path: string,
  oldContent: string,
  newContent: string,
  contextLineCount = 3,
): string => {
  if (oldContent === newContent) {
    return "";
  }
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let oldSuffix = oldLines.length;
  let newSuffix = newLines.length;
  while (
    oldSuffix > prefix &&
    newSuffix > prefix &&
    oldLines[oldSuffix - 1] === newLines[newSuffix - 1]
  ) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  const oldHunkStart = Math.max(0, prefix - contextLineCount);
  const newHunkStart = Math.max(0, prefix - contextLineCount);
  const oldHunkEnd = Math.min(
    oldLines.length,
    oldSuffix + contextLineCount,
  );
  const newHunkEnd = Math.min(
    newLines.length,
    newSuffix + contextLineCount,
  );
  const lines = [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${rangeHeader(oldHunkStart, oldHunkEnd - oldHunkStart)} +${
      rangeHeader(newHunkStart, newHunkEnd - newHunkStart)
    } @@`,
  ];
  for (let index = oldHunkStart; index < prefix; index += 1) {
    lines.push(renderDiffLine(" ", oldLines[index]!));
  }
  for (let index = prefix; index < oldSuffix; index += 1) {
    lines.push(renderDiffLine("-", oldLines[index]!));
  }
  for (let index = prefix; index < newSuffix; index += 1) {
    lines.push(renderDiffLine("+", newLines[index]!));
  }
  for (let index = oldSuffix; index < oldHunkEnd; index += 1) {
    lines.push(renderDiffLine(" ", oldLines[index]!));
  }
  return `${lines.join("\n")}\n`;
};

const READ_FILE_COMMAND = [
  "set -eu",
  'if [ ! -e "$1" ]; then',
  '  echo "file not found: $1" >&2',
  "  exit 10",
  "fi",
  'if [ ! -f "$1" ]; then',
  '  echo "not a file: $1" >&2',
  "  exit 11",
  "fi",
  'exec cat "$1"',
].join("\n");

const WRITE_FILE_COMMAND = [
  "set -eu",
  'path="$1"',
  'if [ ! -e "$path" ]; then',
  '  echo "file not found: $path" >&2',
  "  exit 10",
  "fi",
  'if [ ! -f "$path" ]; then',
  '  echo "not a file: $path" >&2',
  "  exit 11",
  "fi",
  'cat > "$path"',
].join("\n");

export const editFileToolDescriptor: HarnessToolDescriptor = {
  toolId: "edit_file",
  title: "Edit File",
  description:
    "Apply exact string-replacement edits to an existing file in the target VM. Use this for targeted changes after reading the file; use write_file for new files or full rewrites.",
  effectClass: "write",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      edits: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", minLength: 1 },
            newText: { type: "string" },
            replaceAll: { type: "boolean" },
            expectedReplacements: { type: "integer", minimum: 1 },
          },
          required: ["oldText", "newText"],
          additionalProperties: false,
        },
      },
      expectedDigest: { type: "string" },
    },
    required: ["path", "edits"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        outputId: { type: "string" },
        path: { type: "string" },
        editsApplied: { type: "integer", minimum: 0 },
        replacements: { type: "integer", minimum: 0 },
        oldDigest: { type: "string" },
        newDigest: { type: "string" },
        oldSizeBytes: { type: "integer", minimum: 0 },
        newSizeBytes: { type: "integer", minimum: 0 },
        diff: { type: "string" },
      },
      required: [
        "outputId",
        "path",
        "editsApplied",
        "replacements",
        "oldDigest",
        "newDigest",
        "oldSizeBytes",
        "newSizeBytes",
        "diff",
      ],
      additionalProperties: false,
    }, structuredFileToolErrorOutputSchema],
  } satisfies JSONSchema,
  tags: ["file", "write", "vm", "edit"],
};

export const editFileTool: HarnessToolDefinition<
  EditFileToolInput,
  EditFileToolOutput
> = {
  descriptor: editFileToolDescriptor,
  async invoke(context, input) {
    let resolvedPath: string;
    try {
      resolvedPath = context.resolvePath(input.path);
    } catch (error) {
      return createStructuredFileToolErrorOutput(context, "edit_file", {
        path: input.path,
        code: classifyPathResolutionError(error),
        detail: detailFromUnknownError(error),
      });
    }
    if (await isResolvedPathInsideArtifactRoot(context, resolvedPath)) {
      return createStructuredFileToolErrorOutput(context, "edit_file", {
        path: resolvedPath,
        code: "permission_denied",
        detail: RESERVED_ARTIFACT_PATH_DETAIL,
      });
    }

    const readArgs = [resolvedPath];
    const readResult = await context.sandbox.runShell({
      command: READ_FILE_COMMAND,
      args: readArgs,
      cwd: context.currentDir,
      cfcInvocationContext: await context.createCfcInvocationContext({
        toolId: "edit_file",
        operation: "shell",
        cwd: context.currentDir,
        command: READ_FILE_COMMAND,
        args: readArgs,
      }),
    });
    if (readResult.exitCode !== 0) {
      return createStructuredFileToolErrorOutput(context, "edit_file", {
        path: resolvedPath,
        code: classifyFileToolShellFailure(readResult),
        detail: detailFromShellFailure(readResult),
        exitCode: readResult.exitCode,
      });
    }

    const oldSummary = await summarizeText(readResult.stdout);
    if (
      input.expectedDigest !== undefined &&
      input.expectedDigest !== oldSummary.digest
    ) {
      return createStructuredFileToolErrorOutput(context, "edit_file", {
        path: resolvedPath,
        code: "edit_conflict",
        detail:
          `expected digest ${input.expectedDigest} but current digest is ${oldSummary.digest}`,
      });
    }

    let edited: ApplyEditsResult;
    try {
      edited = applyEdits(readResult.stdout, input.edits);
    } catch (error) {
      return createStructuredFileToolErrorOutput(context, "edit_file", {
        path: resolvedPath,
        code: "edit_conflict",
        detail: detailFromUnknownError(error),
      });
    }

    const newSummary = await summarizeText(edited.content);
    const writeArgs = [resolvedPath];
    const writeResult = await context.sandbox.runShell({
      command: WRITE_FILE_COMMAND,
      args: writeArgs,
      cwd: context.currentDir,
      stdinText: edited.content,
      cfcInvocationContext: await context.createCfcInvocationContext({
        toolId: "edit_file",
        operation: "shell",
        cwd: context.currentDir,
        command: WRITE_FILE_COMMAND,
        args: writeArgs,
        stdinText: edited.content,
      }),
    });
    if (writeResult.exitCode !== 0) {
      return createStructuredFileToolErrorOutput(context, "edit_file", {
        path: resolvedPath,
        code: classifyFileToolShellFailure(writeResult),
        detail: detailFromShellFailure(writeResult),
        exitCode: writeResult.exitCode,
      });
    }

    const verifyResult = await context.sandbox.runShell({
      command: READ_FILE_COMMAND,
      args: readArgs,
      cwd: context.currentDir,
      cfcInvocationContext: await context.createCfcInvocationContext({
        toolId: "edit_file",
        operation: "shell",
        cwd: context.currentDir,
        command: READ_FILE_COMMAND,
        args: readArgs,
      }),
    });
    if (verifyResult.exitCode !== 0) {
      return createStructuredFileToolErrorOutput(context, "edit_file", {
        path: resolvedPath,
        code: classifyFileToolShellFailure(verifyResult),
        detail: detailFromShellFailure(verifyResult),
        exitCode: verifyResult.exitCode,
      });
    }
    if (verifyResult.stdout !== edited.content) {
      const observedSummary = await summarizeText(verifyResult.stdout);
      return createStructuredFileToolErrorOutput(context, "edit_file", {
        path: resolvedPath,
        code: "edit_conflict",
        detail:
          `post-write verification failed: expected ${newSummary.digest} but observed ${observedSummary.digest}`,
      });
    }

    return {
      outputId: context.nextOutputId("edit_file"),
      path: resolvedPath,
      editsApplied: input.edits.length,
      replacements: edited.replacements,
      oldDigest: oldSummary.digest,
      newDigest: newSummary.digest,
      oldSizeBytes: oldSummary.bytes,
      newSizeBytes: newSummary.bytes,
      diff: createUnifiedDiff(resolvedPath, readResult.stdout, edited.content),
    };
  },
};
