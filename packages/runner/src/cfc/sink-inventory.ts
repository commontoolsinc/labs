export type InitialSinkName =
  | "fetchData"
  | "fetchProgram"
  | "streamData"
  | "llm"
  | "llmDialog"
  | "generateText"
  | "generateObject";

const INITIAL_SINK_NAMES: readonly InitialSinkName[] = [
  "fetchData",
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

export const INITIAL_SINK_ROLLOUT_GATE: readonly InitialSinkName[] = Object.freeze(
  [...INITIAL_SINK_NAMES],
);

export const isInitialSinkInventoryName = (
  name: string,
): name is InitialSinkName => (INITIAL_SINK_INVENTORY as readonly string[]).includes(name);
