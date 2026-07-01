export type InitialSinkName =
  | "fetchBinary"
  | "fetchText"
  | "fetchJson"
  | "fetchJsonUnchecked"
  | "fetchProgram"
  | "streamData"
  | "llm"
  | "llmDialog"
  | "generateText"
  | "generateObject";

const INITIAL_SINK_NAMES: readonly InitialSinkName[] = [
  "fetchBinary",
  "fetchText",
  "fetchJson",
  "fetchJsonUnchecked",
  "fetchProgram",
  "streamData",
  "llm",
  "llmDialog",
  "generateText",
  "generateObject",
] as const;

export const INITIAL_SINK_INVENTORY: readonly InitialSinkName[] = Object.freeze(
  [...INITIAL_SINK_NAMES],
);

export const isInitialSinkInventoryName = (
  name: string,
): name is InitialSinkName =>
  (INITIAL_SINK_INVENTORY as readonly string[]).includes(name);

/**
 * Per-sink confidentiality ceiling: the confidentiality atoms a sink's request
 * may carry. A sink ABSENT from the map has no ceiling (its requests are not
 * gated on confidentiality). A sink mapped to an array is gated — every
 * confidentiality atom reachable from the request must be a member; an empty
 * array is therefore "public only" (no confidential atom may flow to the sink).
 *
 * §5.2.1 / §7.3-7.5: a sink is an information-flow egress, so its request must
 * not carry confidentiality the sink isn't cleared for. This is the policy
 * surface for that check; `prepareBoundaryCommit` consults it for every
 * recorded `sink-request` write-policy input.
 */
export type SinkMaxConfidentiality = Readonly<
  Record<string, readonly unknown[]>
>;

/**
 * Default ceilings: NONE declared, so the check is live but inert until a
 * deployment supplies ceilings via `Runtime({ cfcSinkMaxConfidentiality })`.
 *
 * Why empty rather than e.g. public-only on the HTTP sinks: until the default
 * label transition closes value-copy laundering (audit S16), most confidential
 * data reaches a sink as an unlabeled value and would slip a strict default
 * anyway, while the few correctly-labeled flows would be the only ones gated.
 * The honest posture is an opt-in ceiling a deployment rolls out per the
 * standard observe→enforce path (the observe diagnostic names each offending
 * (sink, atom) pair).
 */
export const DEFAULT_SINK_MAX_CONFIDENTIALITY: SinkMaxConfidentiality = Object
  .freeze({});
