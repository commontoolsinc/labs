/**
 * A run as a timeline you can scrub. The feed says what happened next; this
 * says what the run looked like at step N — the call that was made, the whole
 * of what went into it and came back, and which handles were in scope by then.
 *
 * Handle scope is reconstructed rather than recorded. `run-state.json` carries
 * one handle table, the run's last, so "in scope at step N" is derived by
 * walking the transcript forward and taking a handle to be in scope from the
 * step its token first appears in. That is the same order the model saw them
 * in, which is the order that matters for reading a run back.
 */

import {
  HANDLE_TOKEN_PATTERN,
  type HarnessHandleEntry,
  type HarnessHandleTable,
} from "../src/contracts/handle-table.ts";
import type {
  HarnessToolCall,
  HarnessTranscriptMessage,
} from "../src/contracts/transcript.ts";
import type { ToolResultRef } from "../src/contracts/tool-result.ts";
import type { HarnessPolicyEvent } from "../src/contracts/policy.ts";
import type { HarnessPolicyDecisionRecord } from "../src/contracts/policy-trace.ts";
import type { HarnessCfcInvocationContext } from "../src/contracts/cfc-invocation-context.ts";

/** One handle, as the timeline reports it. */
export interface KickoffHandle {
  token: string;
  /** The address the handle stands for, when the run's table still holds it. */
  ref?: string;
  addressKey?: string;
  /** The step whose text first carried this token. */
  introducedAtStep: number;
}

/** What kind of step this is, which decides what the detail pane shows. */
export type KickoffStepKind = "system" | "user" | "assistant" | "tool";

/** How a step turned out, at a glance. */
export type KickoffStepStatus = "ok" | "error" | "denied" | "none";

/**
 * What a tool result let across as a value, beside what it sealed behind a
 * reference. The harness seals a string the schema does not pin to an enum or
 * a const, but a number is never sealed and neither is an array of them — so
 * the size of what crossed as plain data is worth stating rather than leaving
 * to be read out of a JSON block.
 */
export interface KickoffDisclosure {
  /** Bytes of JSON the result carried as value. */
  valueBytes: number;
  /** Positions the sanitizer replaced with an opaque link. */
  sealedPositions: number;
  /**
   * The longest run of numbers the value carries. An array of integers is an
   * array of values none of which is sealed, so a long one is a channel wide
   * enough for arbitrary content and is worth looking at.
   */
  longestNumericRun: number;
}

/** One step of a run. */
export interface KickoffStep {
  index: number;
  kind: KickoffStepKind;

  /** Assistant or user prose, and the system prompt for step zero. */
  text?: string;

  toolName?: string;
  toolCallId?: string;

  /**
   * The call's arguments, parsed. Arguments arrive as a JSON string the model
   * produced, so one it malformed is reported as `inputText` instead.
   */
  input?: unknown;
  inputText?: string;

  /** The result the model read, parsed on the same terms as the input. */
  output?: unknown;
  outputText?: string;

  /** Where the untruncated result was persisted, when the run recorded it. */
  resultRef?: ToolResultRef;

  /** The `delegate_task` child this step started, whose run has its own timeline. */
  childRunId?: string;

  /** Tokens whose first appearance in the run is this step. */
  handlesIntroduced: readonly string[];

  /** Every token in scope by the end of this step, in the order introduced. */
  handlesInScope: readonly string[];

  /** How the step turned out, from its own result and from CFC's verdict. */
  status: KickoffStepStatus;

  /** The CFC decision for this call, when the run recorded one. */
  policy?: {
    decision: string;
    effectClass?: string;
    reasonCodes: readonly string[];
  };

  /** Policy events raised against this call — a denial names its reason. */
  policyEvents: readonly HarnessPolicyEvent[];

  /** What the result let across as value, for a step whose result carries one. */
  disclosure?: KickoffDisclosure;

  /**
   * The CFC invocation context recorded for this call. Under a posture that
   * propagates flow labels, its `cfcInputLabels` are the labels the runtime
   * computed for each input position — which is where a confidentiality atom
   * such as `PromptSlotInfluence` becomes visible.
   */
  invocation?: HarnessCfcInvocationContext;
}

const parseJson = (text: string): { value?: unknown; ok: boolean } => {
  try {
    return { value: JSON.parse(text), ok: true };
  } catch {
    return { ok: false };
  }
};

/** Every handle token in a piece of text, in the order it carries them. */
const tokensIn = (text: string): string[] =>
  text.match(new RegExp(HANDLE_TOKEN_PATTERN)) ?? [];

/** The tool calls an assistant made, by call id. */
const toolCallsById = (
  transcript: readonly HarnessTranscriptMessage[],
): Map<string, HarnessToolCall> => {
  const calls = new Map<string, HarnessToolCall>();
  for (const message of transcript) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        calls.set(call.id, call);
      }
    }
  }
  return calls;
};

/**
 * The longest run of consecutive numbers anywhere in a value. Walks arrays and
 * object values alike, because a channel does not have to sit at the root.
 */
const longestNumericRun = (value: unknown): number => {
  if (Array.isArray(value)) {
    let best = 0;
    let current = 0;
    for (const item of value) {
      if (typeof item === "number") {
        current += 1;
        best = Math.max(best, current);
      } else {
        current = 0;
        best = Math.max(best, longestNumericRun(item));
      }
    }
    return best;
  }
  if (typeof value === "object" && value !== null) {
    let best = 0;
    for (const item of Object.values(value)) {
      best = Math.max(best, longestNumericRun(item));
    }
    return best;
  }
  return 0;
};

/** Positions a sanitizer replaced with an opaque link, counted in a value. */
const sealedPositions = (value: unknown): number => {
  if (typeof value === "string") {
    return value.startsWith("opaque:") ? 1 : 0;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (total, item) => total + sealedPositions(item),
      0,
    );
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record["@link"] === "string") {
      return String(record["@link"]).startsWith("opaque:") ? 1 : 0;
    }
    return Object.values(record).reduce<number>(
      (total, item) => total + sealedPositions(item),
      0,
    );
  }
  return 0;
};

/**
 * What a result let across as a value. Absent for a result carrying none,
 * which is most of them: the question only arises where a schema admitted
 * something.
 */
const disclosureOf = (output: unknown): KickoffDisclosure | undefined => {
  const record = typeof output === "object" && output !== null
    ? output as Record<string, unknown>
    : undefined;
  if (record === undefined || !Object.hasOwn(record, "value")) {
    return undefined;
  }
  const value = record.value;
  return {
    valueBytes: JSON.stringify(value ?? null)?.length ?? 0,
    sealedPositions: sealedPositions(output),
    longestNumericRun: longestNumericRun(value),
  };
};

/** How a tool step turned out, read from its own result and CFC's verdict. */
const statusOf = (
  output: unknown,
  outputText: string | undefined,
  decision: HarnessPolicyDecisionRecord | undefined,
  events: readonly HarnessPolicyEvent[],
): KickoffStepStatus => {
  if (
    decision?.decision === "denied" ||
    events.some((event) => event.severity === "denied")
  ) {
    return "denied";
  }
  const record = typeof output === "object" && output !== null
    ? output as Record<string, unknown>
    : undefined;
  const status = record?.status;
  if (typeof status === "string") {
    return status === "ok" || status === "completed" ? "ok" : "error";
  }
  if (record?.error !== undefined) {
    return "error";
  }
  return outputText === undefined && record === undefined ? "none" : "ok";
};

/** The child run a `delegate_task` result names, when it names one. */
const childRunIdOf = (output: unknown): string | undefined => {
  const record = typeof output === "object" && output !== null
    ? output as { subagent?: { childRunId?: unknown } }
    : undefined;
  const childRunId = record?.subagent?.childRunId;
  return typeof childRunId === "string" ? childRunId : undefined;
};

/**
 * The steps of a run. A tool call and the result answering it are one step
 * rather than two: what went in and what came back are the pair a person reads
 * together, and the assistant message that carried only the call has nothing
 * else to say.
 */
export const kickoffRunSteps = (
  transcript: readonly HarnessTranscriptMessage[],
  policyDecisions: readonly HarnessPolicyDecisionRecord[] = [],
  policyEvents: readonly HarnessPolicyEvent[] = [],
  invocationContexts: readonly HarnessCfcInvocationContext[] = [],
): readonly KickoffStep[] => {
  // An invocation context names the output it was recorded for, which is the
  // same id the transcript's tool message carries as its result reference.
  const invocationsByOutput = new Map(
    invocationContexts.map((context) => [
      String(context.toolOutputId),
      context,
    ]),
  );
  const calls = toolCallsById(transcript);
  const decisionsByCall = new Map(
    policyDecisions.map((decision) => [decision.toolCallId, decision]),
  );
  const eventsByCall = new Map<string, HarnessPolicyEvent[]>();
  for (const event of policyEvents) {
    if (event.toolCallId === undefined) {
      continue;
    }
    const held = eventsByCall.get(event.toolCallId);
    if (held === undefined) {
      eventsByCall.set(event.toolCallId, [event]);
    } else {
      held.push(event);
    }
  }
  const steps: KickoffStep[] = [];
  const inScope: string[] = [];

  const admit = (texts: readonly string[]): string[] => {
    const introduced: string[] = [];
    for (const text of texts) {
      for (const token of tokensIn(text)) {
        if (!inScope.includes(token) && !introduced.includes(token)) {
          introduced.push(token);
        }
      }
    }
    inScope.push(...introduced);
    return introduced;
  };

  for (const message of transcript) {
    // An assistant message that only carries tool calls is the call's own
    // step, folded into the tool result below.
    if (
      message.role === "assistant" && message.content.trim() === "" &&
      (message.toolCalls?.length ?? 0) > 0
    ) {
      continue;
    }
    const index = steps.length;
    if (message.role === "tool") {
      const call = calls.get(message.toolCallId);
      const parsedInput = call === undefined
        ? { ok: false as const }
        : parseJson(call.function.arguments);
      const parsedOutput = parseJson(message.content);
      const handlesIntroduced = admit([
        call?.function.arguments ?? "",
        message.content,
      ]);
      const childRunId = childRunIdOf(parsedOutput.value);
      const decision = decisionsByCall.get(message.toolCallId);
      const events = eventsByCall.get(message.toolCallId) ?? [];
      const disclosure = disclosureOf(parsedOutput.value);
      steps.push({
        index,
        kind: "tool",
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        ...(parsedInput.ok
          ? { input: parsedInput.value }
          : call !== undefined
          ? { inputText: call.function.arguments }
          : {}),
        ...(parsedOutput.ok
          ? { output: parsedOutput.value }
          : { outputText: message.content }),
        ...(message.resultRef !== undefined
          ? { resultRef: message.resultRef }
          : {}),
        ...(childRunId !== undefined ? { childRunId } : {}),
        handlesIntroduced,
        handlesInScope: [...inScope],
        status: statusOf(
          parsedOutput.value,
          parsedOutput.ok ? undefined : message.content,
          decision,
          events,
        ),
        ...(decision !== undefined
          ? {
            policy: {
              decision: decision.decision,
              ...(decision.effectClass !== undefined
                ? { effectClass: decision.effectClass }
                : {}),
              reasonCodes: decision.reasonCodes,
            },
          }
          : {}),
        policyEvents: events,
        ...(disclosure !== undefined ? { disclosure } : {}),
        ...(() => {
          const invocation = message.resultRef === undefined
            ? undefined
            : invocationsByOutput.get(String(message.resultRef.outputId));
          return invocation === undefined ? {} : { invocation };
        })(),
      });
      continue;
    }
    const handlesIntroduced = admit([message.content]);
    steps.push({
      index,
      kind: message.role,
      text: message.content,
      handlesIntroduced,
      handlesInScope: [...inScope],
      status: "none",
      policyEvents: [],
    });
  }
  return steps;
};

/**
 * The handles a run introduced, each resolved against the run's own table.
 * A token the table no longer holds is still reported: that the run passed a
 * handle is the fact, and an address it did not keep is not a reason to hide
 * it.
 */
export const kickoffRunHandles = (
  steps: readonly KickoffStep[],
  handleTable?: HarnessHandleTable,
): readonly KickoffHandle[] => {
  const entries = new Map<string, HarnessHandleEntry>(
    (handleTable?.entries ?? []).map((entry) => [entry.token, entry]),
  );
  const handles: KickoffHandle[] = [];
  for (const step of steps) {
    for (const token of step.handlesIntroduced) {
      const entry = entries.get(token);
      handles.push({
        token,
        ...(entry?.ref !== undefined ? { ref: entry.ref } : {}),
        ...(entry?.addressKey !== undefined
          ? { addressKey: entry.addressKey }
          : {}),
        introducedAtStep: step.index,
      });
    }
  }
  return handles;
};
