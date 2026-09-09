/**
 * `ingest_sandbox_file`: the return half of the sandbox round trip. Work that
 * left the fabric to run under gVisor comes back as a cell, carrying the
 * confidentiality the run's sandbox invocations accumulated.
 *
 * The label is the RUN's, not the file's. gVisor does label sandbox output at
 * file granularity — a `trusted.cfc.contentLabel` xattr on what the sandboxed
 * work wrote — but that xattr does not cross the gofer, so the trusted side
 * cannot read it; every channel that could carry it out of the container is
 * one the sandboxed workload writes, and a workload that can name its own
 * output's label can name a lower one. The container taint runsc reports in
 * its result sidecar is written where the workload cannot reach it, so it is
 * what this mints from. It over-approximates: a file's label is bounded above
 * by the taint of the container that wrote it, so a cell minted here carries
 * at least what its bytes require and sometimes more.
 */

import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface IngestSandboxFileToolInput {
  path?: string;
}

export interface IngestSandboxFileToolSuccessOutput {
  outputId: string;
  status: "ok";

  /** Reference to the cell the bytes landed in. Never the bytes themselves. */
  cellRef: string;

  /** How many bytes were written, so a caller can tell an empty file apart. */
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
    "Write a file the sandbox produced into a new cell in this run's space, labelled with the confidentiality this run's sandbox work accumulated, and return a reference to it. Use it to keep a result that must stay in the fabric under the label its computation earned. The label is derived from the sandbox itself and cannot be passed in or chosen. The bytes are not returned: the reference is what you pass on, and a pattern is what reads it.",
  effectClass: "write",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Path to the file inside the sandbox workspace, absolute or relative to the current directory.",
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
    if (typeof input.path !== "string" || input.path.trim().length === 0) {
      return errorOutput("ingest_sandbox_file requires a path");
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
    // Only the workspace. A path resolving elsewhere on the host is not
    // something the sandbox produced, so the taint this mints from would
    // describe a different run of work than the bytes it applies to.
    if (!await context.isHostPathWithinWorkspace(hostPath)) {
      return errorOutput(
        "ingest_sandbox_file only reads files in the sandbox workspace",
      );
    }
    let content: string;
    try {
      content = await Deno.readTextFile(hostPath);
    } catch (error) {
      return errorOutput(
        `ingest_sandbox_file could not read the file: ${errorMessage(error)}`,
      );
    }
    const confidentiality = context.cfcSandboxTaint?.confidentiality;
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
        bytes: new TextEncoder().encode(content).length,
        labeled,
      };
    } catch (error) {
      return errorOutput(
        `ingest_sandbox_file failed: ${errorMessage(error)}`,
      );
    }
  },
};
