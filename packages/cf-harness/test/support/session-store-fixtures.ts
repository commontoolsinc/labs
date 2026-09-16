/**
 * Fixtures shared by the session store suites: a clock that ticks one second
 * per reading, and a prompt loop result that appends one assistant message.
 */

import type {
  HarnessPromptLoopResult,
  RunHarnessTranscriptOptions,
} from "../../src/prompt-loop.ts";

/** Returns a clock whose readings advance by one second per call. */
export const nextIsoNow = (): () => string => {
  let counter = 0;
  return () => {
    counter += 1;
    return `2026-05-27T00:00:${String(counter).padStart(2, "0")}.000Z`;
  };
};

/** Returns the result of a turn that answers `finalAssistantText`. */
export const makeResult = (
  options: RunHarnessTranscriptOptions,
  finalAssistantText: string,
): HarnessPromptLoopResult => ({
  model: options.model ?? "gpt-test",
  finalAssistantText,
  transcript: [
    ...options.transcript,
    { role: "assistant", content: finalAssistantText },
  ],
  modelTurns: 1,
  runState: {} as HarnessPromptLoopResult["runState"],
});
