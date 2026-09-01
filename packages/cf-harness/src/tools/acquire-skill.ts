/**
 * The `acquire_skill` tool: resolve a discovery id to a GitHub commit, enforce
 * the instructions-only tree whitelist, and durably return only a handle.
 */

import type { JSONSchema } from "@commonfabric/api";
import { stampExternalFetchIngest } from "@commonfabric/runner/cfc";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";

import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import {
  SkillsShAcquisitionError,
  type SkillsShAcquisitionFailureCode,
} from "../skills-sh/acquisition.ts";
import {
  type SkillsShPinnedAddress,
  SkillsShPinResolutionError,
} from "../skills-sh/pin.ts";
import { sanitizeRegistryString } from "../skills-sh/search-client.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface AcquireSkillToolInput {
  readonly id: string;
}

export interface AcquireSkillToolLoadedOutput {
  readonly outputId: string;
  readonly status: "loaded";
  readonly skillHandle: string;
  readonly pin: SkillsShPinnedAddress;
  readonly loaded: {
    readonly skillRoot: string;
    readonly paths: readonly ["SKILL.md"];
    readonly sourceUrl: string;
    readonly verification: "git-commit-sha";
    readonly valueDigest: string;
    readonly receivedAt: string;
  };
}

export interface AcquireSkillToolRefusedOutput {
  readonly outputId: string;
  readonly status: "refused";
  readonly reason: {
    readonly code: string;
    readonly message: string;
  };
  readonly pin?: SkillsShPinnedAddress;
  readonly offendingCount?: number;
  readonly offendingPaths?: readonly string[];
  readonly candidatePaths?: readonly string[];
}

export interface AcquireSkillToolErrorOutput {
  readonly outputId: string;
  readonly status: "error";
  readonly message: string;
}

export type AcquireSkillToolOutput =
  | AcquireSkillToolLoadedOutput
  | AcquireSkillToolRefusedOutput
  | AcquireSkillToolErrorOutput;

const pinnedAddressSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    owner: { type: "string" },
    repo: { type: "string" },
    slug: { type: "string" },
    commitSha: { type: "string" },
    resolvedAt: { type: "string" },
  },
  required: ["id", "owner", "repo", "slug", "commitSha", "resolvedAt"],
  additionalProperties: false,
} satisfies JSONSchema;

export const acquireSkillToolDescriptor: HarnessToolDescriptor = {
  toolId: "acquire_skill",
  title: "Acquire Skill",
  description:
    "Acquire a discovered skill id from its pinned GitHub commit after checking the complete recursive listing. The parent never receives skill text: a loaded result carries a handle only. A refusal is an expected outcome with its reason and offending paths as inert metadata; do not retry around it. Acquisition grants no permission and loads nothing into the parent. Loading the handle into a child is a separate later delegate_task decision.",
  effectClass: "write",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description:
          "Exact discovery id returned by search_skills, in owner/repository/slug form.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["loaded"] },
        skillHandle: { type: "string" },
        pin: pinnedAddressSchema,
        loaded: {
          type: "object",
          properties: {
            skillRoot: { type: "string" },
            paths: {
              type: "array",
              items: { type: "string", enum: ["SKILL.md"] },
            },
            sourceUrl: { type: "string" },
            verification: { type: "string", enum: ["git-commit-sha"] },
            valueDigest: { type: "string" },
            receivedAt: { type: "string" },
          },
          required: [
            "skillRoot",
            "paths",
            "sourceUrl",
            "verification",
            "valueDigest",
            "receivedAt",
          ],
          additionalProperties: false,
        },
      },
      required: ["outputId", "status", "skillHandle", "pin", "loaded"],
      additionalProperties: false,
    }, {
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["refused"] },
        reason: {
          type: "object",
          properties: {
            code: { type: "string" },
            message: { type: "string" },
          },
          required: ["code", "message"],
          additionalProperties: false,
        },
        pin: pinnedAddressSchema,
        offendingCount: { type: "integer", minimum: 0 },
        offendingPaths: { type: "array", items: { type: "string" } },
        candidatePaths: { type: "array", items: { type: "string" } },
      },
      required: ["outputId", "status", "reason"],
      additionalProperties: false,
    }, {
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["error"] },
        message: { type: "string" },
      },
      required: ["outputId", "status", "message"],
      additionalProperties: false,
    }],
  } satisfies JSONSchema,
  tags: ["skill", "acquisition", "handle", "external"],
};

const safeErrorMessage = (error: unknown): string =>
  sanitizeRegistryString(
    error instanceof Error ? error.message : String(error),
  );

const operationalAcquisitionCodes: ReadonlySet<
  SkillsShAcquisitionFailureCode
> = new Set(["request_failed", "http_error"]);

export const acquireSkillTool: HarnessToolDefinition<
  AcquireSkillToolInput,
  AcquireSkillToolOutput
> = {
  descriptor: acquireSkillToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("acquire_skill");
    const errorOutput = (message: string): AcquireSkillToolErrorOutput => ({
      outputId,
      status: "error",
      message,
    });
    if (context.getSkillsShAcquisitionClient === undefined) {
      return errorOutput(
        "acquire_skill requires a skills registry; configure --skills-registry-url",
      );
    }
    if (context.getFabricSession === undefined) {
      return errorOutput("acquire_skill requires a configured fabric session");
    }

    let pin: SkillsShPinnedAddress | undefined;
    try {
      const client = await context.getSkillsShAcquisitionClient();
      const resolvedPin = await client.resolvePin(input.id, {
        now: context.now,
      });
      pin = resolvedPin;
      const acquired = await client.acquirePin(resolvedPin);
      const session = await context.getFabricSession();
      const { pieces } = session;
      const runtime = pieces.runtime;
      const space = pieces.getSpace();
      const receivedAt = context.now();
      const cell = runtime.getCell(
        space,
        `external-skill:${context.runId}:${outputId}`,
        {} as const,
      );
      const link = cell.getAsNormalizedFullLink();
      const { error } = await runtime.editWithRetry((tx) => {
        cell.withTx(tx).set(acquired.text);
        stampExternalFetchIngest(tx, {
          pinnedSource: {
            url: acquired.sourceUrl,
            commitSha: resolvedPin.commitSha,
          },
          receivedAt,
          valueDigest: acquired.valueDigest,
          target: {
            space,
            id: link.id,
            scope: link.scope,
            path: link.path,
          },
        });
      });
      if (error !== undefined) {
        return errorOutput(
          `acquire_skill could not write the skill handle: ${
            safeErrorMessage(error)
          }`,
        );
      }
      await runtime.idle();
      return {
        outputId,
        status: "loaded",
        skillHandle: createLLMFriendlyLink(link, space),
        pin,
        loaded: {
          skillRoot: acquired.skillRoot,
          paths: acquired.loadedPaths,
          sourceUrl: acquired.sourceUrl,
          verification: "git-commit-sha",
          valueDigest: acquired.valueDigest,
          receivedAt,
        },
      };
    } catch (error) {
      if (error instanceof SkillsShAcquisitionError) {
        if (operationalAcquisitionCodes.has(error.code)) {
          return errorOutput(safeErrorMessage(error));
        }
        return {
          outputId,
          status: "refused",
          reason: { code: error.code, message: safeErrorMessage(error) },
          ...(pin !== undefined ? { pin } : {}),
          ...(error.offendingCount !== undefined
            ? { offendingCount: error.offendingCount }
            : {}),
          ...(error.offendingPaths !== undefined
            ? { offendingPaths: error.offendingPaths }
            : {}),
          ...(error.candidatePaths !== undefined
            ? { candidatePaths: error.candidatePaths }
            : {}),
        };
      }
      if (error instanceof SkillsShPinResolutionError) {
        if (error.code === "request_failed" || error.code === "http_error") {
          return errorOutput(safeErrorMessage(error));
        }
        return {
          outputId,
          status: "refused",
          reason: { code: error.code, message: safeErrorMessage(error) },
        };
      }
      return errorOutput(`acquire_skill failed: ${safeErrorMessage(error)}`);
    }
  },
};
