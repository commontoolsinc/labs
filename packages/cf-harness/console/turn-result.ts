/**
 * Projects a completed console turn from the durable transcript the model
 * received. Missing or malformed artifacts produce no result rather than a
 * partial object that could be mistaken for a completed contract.
 */

import { join } from "@std/path";

import type {
  HarnessChatEventEnvelope,
  HarnessChatStructuredEvent,
} from "../src/contracts/interactive-chat.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";

/** A named piece a completed console turn made openable. */
export interface ConsoleTurnResultPiece {
  /** Slug returned by `assign_slug`. */
  slug: string;

  /** Openable URL returned beside the slug. */
  url: string;
}

/** The stable result an external console caller reads for a completed turn. */
export interface ConsoleTurnResult {
  /** Successful named-piece outputs, in transcript order. */
  pieces: readonly ConsoleTurnResultPiece[];

  /** The space this console is configured against. */
  spaceName: string;

  /** Last assistant text, or an empty string when the turn ended on a tool. */
  finalText: string;
}

/** The console's completed SSE event with its external result attached. */
export type ConsoleTurnCompletedEvent =
  & Extract<
    HarnessChatStructuredEvent,
    { kind: "turn_completed" }
  >
  & { result: ConsoleTurnResult };

/** A console SSE event, whose completed-turn case always carries a result. */
export type ConsoleChatStructuredEvent =
  | Exclude<HarnessChatStructuredEvent, { kind: "turn_completed" }>
  | ConsoleTurnCompletedEvent;

/** The event envelope emitted by the console SSE route. */
export type ConsoleChatEventEnvelope =
  & Omit<
    HarnessChatEventEnvelope,
    "event"
  >
  & { event: ConsoleChatStructuredEvent };

/** Inputs which identify one turn's durable result. */
export interface ReadConsoleTurnResultOptions {
  /** Root holding one artifact directory per turn. */
  artifactRoot: string;

  /** Turn identifier, which is also the run artifact directory name. */
  turnId: string;

  /** Space this console is configured against. */
  spaceName: string;
}

/** Characters the artifact store admits in one run directory name. */
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

/** Whether an artifact value has the minimum shape of a transcript message. */
const isTranscriptMessage = (
  value: unknown,
): value is HarnessTranscriptMessage => {
  if (
    typeof value !== "object" || value === null || !("role" in value) ||
    !("content" in value) || typeof value.content !== "string"
  ) {
    return false;
  }
  if (
    value.role === "system" || value.role === "user" ||
    value.role === "assistant"
  ) {
    return true;
  }
  return value.role === "tool" && "toolCallId" in value &&
    typeof value.toolCallId === "string" && "toolName" in value &&
    typeof value.toolName === "string";
};

/** Reads a transcript without admitting a turn id as a path. */
const readTranscript = async (
  artifactRoot: string,
  turnId: string,
): Promise<readonly HarnessTranscriptMessage[] | undefined> => {
  if (
    !SAFE_RUN_ID.test(turnId) || turnId === "." || turnId === ".."
  ) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(
      await Deno.readTextFile(join(artifactRoot, turnId, "transcript.json")),
    );
    return Array.isArray(parsed) && parsed.every(isTranscriptMessage)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
};

/** Copies the openable fields from one successful `assign_slug` output. */
const pieceFromAssignSlug = (
  message: HarnessTranscriptMessage,
): ConsoleTurnResultPiece | undefined => {
  if (message.role !== "tool" || message.toolName !== "assign_slug") {
    return undefined;
  }
  let output: unknown;
  try {
    output = JSON.parse(message.content);
  } catch {
    return undefined;
  }
  if (
    typeof output !== "object" || output === null ||
    !("status" in output) || output.status !== "ok" ||
    !("slug" in output) || typeof output.slug !== "string" ||
    !("url" in output) || typeof output.url !== "string"
  ) {
    return undefined;
  }
  // These two fields are copied from the model-facing `assign_slug` output.
  // No new data crosses the console boundary and no URL is reconstructed.
  return { slug: output.slug, url: output.url };
};

/**
 * Reads one completed turn from its durable model-facing transcript. Returns
 * `undefined` when the artifact cannot establish a complete result.
 */
export const readConsoleTurnResult = async (
  options: ReadConsoleTurnResultOptions,
): Promise<ConsoleTurnResult | undefined> => {
  const transcript = await readTranscript(options.artifactRoot, options.turnId);
  if (transcript === undefined) {
    return undefined;
  }
  const finalText =
    transcript.findLast((message) => message.role === "assistant")?.content ??
      "";
  return {
    pieces: transcript.flatMap((message) => {
      const piece = pieceFromAssignSlug(message);
      return piece === undefined ? [] : [piece];
    }),
    spaceName: options.spaceName,
    finalText,
  };
};
