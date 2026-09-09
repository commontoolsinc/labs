/**
 * `ingest_sandbox_file`: the return half of the sandbox round trip. Work that
 * left the fabric to run under gVisor comes back as a cell, carrying the
 * confidentiality the run family's sandbox work accumulated.
 *
 * Three things have to hold before a label on that cell means anything, and
 * each of them is a refusal here rather than a caveat in a document.
 *
 * PROVENANCE. Containment in the workspace is not evidence that this run
 * wrote the file: a workspace is an ordinary directory the operator names, so
 * a file in it may predate the run entirely. Only the run family's own output
 * directory carries that evidence, because the harness creates it fresh and
 * refuses to reuse one, so nothing in it predates the family. A path outside
 * it is refused however far inside the workspace it sits.
 *
 * EVIDENCE. The label is the join of the container taints runsc reported for
 * the family's sandbox invocations, read from the result sidecar it writes
 * where the sandboxed workload cannot reach it. An invocation that ran
 * without leaving that evidence could have written anything under any label,
 * so the family's knowledge is not clean — it is gone, and this refuses for
 * the rest of the run. There is no recovery, because nothing later can
 * establish what that invocation did.
 *
 * The label is the FAMILY's, not the file's. gVisor does label sandbox output
 * per file — a `trusted.cfc.contentLabel` xattr on what the sandboxed work
 * wrote — but that xattr does not cross the gofer, and every channel that
 * could carry it out of the container is one the workload writes. It
 * over-approximates: a file's label is bounded above by the taint of the
 * container that wrote it, so a cell minted here carries at least what its
 * bytes require and sometimes more.
 */

import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { isAbsolute, relative } from "@std/path";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import {
  SANDBOX_OUTPUT_DIR_ENV,
  sandboxOutputRootIsIntact,
} from "../sandbox/output-root.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface IngestSandboxFileToolInput {
  path?: string;
}

export interface IngestSandboxFileToolSuccessOutput {
  outputId: string;
  status: "ok";

  /** Reference to the cell the text landed in. Never the text itself. */
  cellRef: string;

  /** The file's size on disk, so a caller can tell an empty file apart. */
  bytes: number;

  /**
   * Whether the cell carries a confidentiality label. Whether, and not which:
   * the atoms name the sources that influenced this run, and a run whose
   * sandbox output was withheld from the model does not get them back as the
   * names of what withheld them.
   */
  labeled: boolean;
}

export interface IngestSandboxFileToolErrorOutput {
  outputId: string;
  status: "error";
  message: string;
}

export type IngestSandboxFileToolOutput =
  | IngestSandboxFileToolSuccessOutput
  | IngestSandboxFileToolErrorOutput;

export const ingestSandboxFileToolDescriptor: HarnessToolDescriptor = {
  toolId: "ingest_sandbox_file",
  title: "Ingest Sandbox File",
  description:
    `Write a UTF-8 text file your sandbox work produced into a new cell in this run's space, labelled with the confidentiality this run's sandbox work accumulated, and return a reference to it. Use it to keep a result that must stay in the fabric under the label its computation earned. The file must be under this run's output directory, named by $${SANDBOX_OUTPUT_DIR_ENV} inside the sandbox: write it as $${SANDBOX_OUTPUT_DIR_ENV}/name.txt and pass that same path here. A file anywhere else is refused however far inside the workspace it sits — being in the workspace does not establish that this run produced it, and only that directory does. The label is derived from the sandbox and cannot be passed in or chosen. The bytes are not returned: the reference is what you pass on, and a pattern is what reads it.`,
  effectClass: "write",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          `Path to the file, under the run's output directory ($${SANDBOX_OUTPUT_DIR_ENV}); absolute or relative to the current directory.`,
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      outputId: { type: "string" },
      status: { enum: ["ok", "error"] },
      cellRef: { type: "string" },
      bytes: { type: "number" },
      labeled: { type: "boolean" },
      message: { type: "string" },
    },
    required: ["outputId", "status"],
    additionalProperties: false,
  },
  tags: ["fabric", "sandbox"],
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Whether `hostPath` sits strictly inside `root`, deciding on REAL paths.
 *
 * A lexical comparison answers about the name a caller wrote, and the read
 * that follows answers about the file the name reaches. A symlink planted in
 * the output directory by the sandboxed workload — which can write there —
 * makes those two different files, and the label would then describe a
 * container that never wrote what was stored. Both sides are resolved, so a
 * link out of the directory is a path out of the directory.
 *
 * A path that cannot be resolved is not inside anything: `undefined` says the
 * question could not be answered, and the caller refuses rather than guessing.
 */
const realPathWithin = async (
  root: string,
  hostPath: string,
): Promise<
  | { kind: "within"; realPath: string }
  | { kind: "unreadable"; error: unknown }
  | { kind: "outside" }
> => {
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = await Deno.realPath(root);
    realPath = await Deno.realPath(hostPath);
  } catch (error) {
    return { kind: "unreadable", error };
  }
  const step = relative(realRoot, realPath);
  return step !== "" && !step.startsWith("..") && !isAbsolute(step)
    ? { kind: "within", realPath }
    : { kind: "outside" };
};

export const ingestSandboxFileTool: HarnessToolDefinition<
  IngestSandboxFileToolInput,
  IngestSandboxFileToolOutput
> = {
  descriptor: ingestSandboxFileToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("ingest_sandbox_file");
    const errorOutput = (
      message: string,
    ): IngestSandboxFileToolErrorOutput => ({
      outputId,
      status: "error",
      message,
    });
    if (context.getFabricSession === undefined) {
      return errorOutput(
        "ingest_sandbox_file requires a fabric session; a run without one has no space to write into",
      );
    }
    // Before the path is even resolved: a family that lost track of what its
    // sandbox did has no label to mint, whatever file is named.
    const taint = context.workspaceTaint;
    if (taint.kind === "unknown") {
      return errorOutput(
        `ingest_sandbox_file cannot label anything from this run: ${taint.reason}. ` +
          `Nothing later can establish what that invocation wrote, so this run ` +
          `ingests nothing.`,
      );
    }
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      return errorOutput("ingest_sandbox_file requires a path");
    }
    const root = context.sandboxOutputRoot;
    if (root === undefined) {
      return errorOutput(
        `ingest_sandbox_file has no output directory of this run's own to ` +
          `read from, and reads from nowhere else: ${
            context.sandboxOutputRootFailure ?? "this run established none"
          }`,
      );
    }
    let hostPath: string;
    try {
      hostPath = context.resolveHostPath(context.resolvePath(input.path));
    } catch (error) {
      return errorOutput(
        `ingest_sandbox_file could not resolve the path: ${
          errorMessage(error)
        }`,
      );
    }
    // The directory this reads from must still be the directory the family
    // made. A name can be re-pointed — and the mount's own name cannot be, but
    // checking the identity costs one `stat` and does not depend on that
    // being true.
    if (!await sandboxOutputRootIsIntact(root)) {
      return errorOutput(
        `ingest_sandbox_file found something other than the directory this ` +
          `run created at its output path, so nothing in it can be ` +
          `attributed to this run. Nothing was read.`,
      );
    }
    // BEFORE anything follows the name. A leaf that is a link is refused for
    // being one, not for where it leads: resolving it first would mean the
    // decision was taken about the link's target, and a workload can point a
    // name inside the directory at another name inside it, or move it between
    // the resolution and the read.
    try {
      const leaf = await Deno.lstat(hostPath);
      if (leaf.isSymlink) {
        return errorOutput(
          `ingest_sandbox_file refuses a symbolic link: name the file itself, ` +
            `so that what is read is what was written rather than whatever ` +
            `the link points at when it is followed.`,
        );
      }
    } catch (error) {
      return errorOutput(
        `ingest_sandbox_file could not read the file: ${errorMessage(error)}`,
      );
    }
    const resolved = await realPathWithin(root.hostPath, hostPath);
    // A path that cannot be resolved is reported as the file it names, not as
    // one outside the directory: the usual reason is that nothing is there,
    // and answering "outside" would send a caller looking for an escape it
    // did not attempt.
    if (resolved.kind === "unreadable") {
      return errorOutput(
        `ingest_sandbox_file could not read the file: ${
          errorMessage(resolved.error)
        }`,
      );
    }
    if (resolved.kind === "outside") {
      return errorOutput(
        `ingest_sandbox_file only reads files under this run's output ` +
          `directory (${context.sandboxOutputMountPath}, named by ` +
          `$${SANDBOX_OUTPUT_DIR_ENV} inside the sandbox). Being in the ` +
          `workspace does not establish that this run produced a file; only ` +
          `that directory does, and a link out of it leads back to one that ` +
          `does not. Write the file there and ingest it from there.`,
      );
    }
    // A hard link is a second name for a file this family never wrote: the
    // sandbox can make one from the workspace without reading the bytes, so
    // the taint need not cover what they require. Real-path containment
    // cannot tell the two directory entries apart, and a link count above one
    // is what does. The dedicated mount already makes such a link fail across
    // filesystems; this refuses the case where it did not.
    let bytes: Uint8Array;
    try {
      const stat = await Deno.stat(resolved.realPath);
      if (!stat.isFile) {
        throw new Deno.errors.NotSupported(
          `not a regular file: ${input.path}`,
        );
      }
      if (stat.nlink !== null && stat.nlink > 1) {
        return errorOutput(
          `ingest_sandbox_file refuses a file with more than one name: a ` +
            `second link to it exists outside this run's output directory, ` +
            `so its bytes are not something this run's sandbox work produced.`,
        );
      }
      bytes = await Deno.readFile(resolved.realPath);
    } catch (error) {
      return errorOutput(
        `ingest_sandbox_file could not read the file: ${errorMessage(error)}`,
      );
    }
    // Decoded strictly, and refused rather than repaired. A lenient decode
    // replaces every invalid sequence with U+FFFD, which would put bytes in
    // the cell that were never in the file while reporting a size taken from
    // the replacement. This tool ingests text; a file that is not text is a
    // refusal until there is a binary value convention to store it under.
    //
    // `ignoreBOM` keeps a leading U+FEFF as content. Stripping it is the
    // default, and it would drop three bytes from the value while `bytes`
    // still reported the file's length — the same mismatch a lenient decode
    // makes, arrived at from the other side.
    let content: string;
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      return errorOutput(
        "ingest_sandbox_file reads UTF-8 text, and this file is not valid UTF-8. " +
          "Its bytes would have to be altered to store them, so nothing was written.",
      );
    }
    const confidentiality = taint.label?.confidentiality;
    const labeled = Array.isArray(confidentiality) &&
      confidentiality.length > 0;
    try {
      const { pieces } = await context.getFabricSession();
      const runtime = pieces.runtime;
      const space = pieces.getSpace();
      const cell = runtime.getCell(
        space,
        `sandbox-file:${context.runId}:${outputId}`,
        {} as const,
      );
      const link = cell.getAsNormalizedFullLink();
      const { error } = await runtime.editWithRetry((tx) => {
        const written = cell.withTx(tx);
        written.set(content);
        if (labeled) {
          // Same transaction as the value: a cell that existed unlabelled
          // between two commits is one a concurrent reader could read
          // without the requirement its bytes carry.
          written.asSchema({ ifc: { confidentiality } })
            .applyCfcSchemaToExistingValue();
        }
      });
      if (error !== undefined) {
        return errorOutput(
          `ingest_sandbox_file could not write the cell: ${
            errorMessage(error)
          }`,
        );
      }
      await runtime.idle();
      return {
        outputId,
        status: "ok",
        cellRef: createLLMFriendlyLink(link, space),
        bytes: bytes.byteLength,
        labeled,
      };
    } catch (error) {
      return errorOutput(
        `ingest_sandbox_file failed: ${errorMessage(error)}`,
      );
    }
  },
};
