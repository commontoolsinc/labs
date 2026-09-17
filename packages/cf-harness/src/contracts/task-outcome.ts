/**
 * User-facing disposition of a normally ended run. Execution failures remain
 * run failures; a question or a give-up leaves the conversation reusable.
 */

/** The task's result, independent of whether the model loop ran successfully. */
export type HarnessTaskOutcome =
  | { outcome: "completed" }
  | { outcome: "question"; question: { text: string } }
  | { outcome: "gave-up"; reason: string };

/** Reads a serialized task outcome, defaulting only an absent legacy field. */
export const readHarnessTaskOutcome = (
  value: unknown,
): HarnessTaskOutcome | undefined => {
  if (value === undefined) return { outcome: "completed" };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  switch (record.outcome) {
    case "completed":
      return record.question === undefined && record.reason === undefined
        ? { outcome: "completed" }
        : undefined;
    case "question": {
      const question = record.question;
      return typeof question === "object" && question !== null &&
          !Array.isArray(question) && "text" in question &&
          typeof question.text === "string" &&
          question.text.trim().length > 0 &&
          record.reason === undefined
        ? { outcome: "question", question: { text: question.text } }
        : undefined;
    }
    case "gave-up":
      return typeof record.reason === "string" &&
          record.reason.trim().length > 0 && record.question === undefined
        ? { outcome: "gave-up", reason: record.reason }
        : undefined;
    default:
      return undefined;
  }
};
