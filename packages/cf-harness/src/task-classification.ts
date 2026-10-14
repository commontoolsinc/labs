import { isClosedResearchTask } from "./research/closed-task.ts";
import type { HarnessRunState } from "./run-state.ts";

/**
 * The kinds of work a task can call for. A task carries every tag that
 * applies, and each tag adds the orientation that kind of work needs:
 *
 * - `respond`: an answer from what the run already holds.
 * - `find`: a lookup, in the person's data or on the web.
 * - `act`: an operation in the person's application or on a web page.
 * - `pieces`: work on the pieces and patterns the run was handed.
 * - `author`: a pattern written from scratch.
 */
export const HARNESS_TASK_TAGS = [
  "respond",
  "find",
  "act",
  "pieces",
  "author",
] as const;

export type HarnessTaskTag = typeof HARNESS_TASK_TAGS[number];

/**
 * The tags a root task was given before its first model turn, recorded in the
 * run state so a run report can say what orientation the run got and what
 * deciding it cost.
 */
export interface HarnessTaskClassification {
  type: "cf-harness.task-classification";
  version: 1;
  tags: HarnessTaskTag[];

  /**
   * What chose the tags: the keyword rule, one cheap model call when the rule
   * had no answer, or the fallback of every tag when neither did.
   */
  path: "rule" | "model" | "fallback";

  /** Wall time the classification took, model call included. */
  durationMs: number;
}

/** What the classifier reads about a run besides the task text. */
export type TaskClassificationContext =
  & Pick<HarnessRunState, "patternRefs" | "skillRegistry" | "inputCells">
  & { browserHost?: boolean };

const NAVIGATE =
  /\b(?:take me to|go to|open|navigate to|switch to|bring up)\b.*\bloom\b/;
const ACT =
  /\b(?:deploy|add\b.*\bto (?:this|the|my|a) loom|move\b.*\b(?:panel|loom))\b/;
const WEB_ACT =
  /\b(?:buy|order|book|purchase|sign up|fill (?:in|out)|check ?out|browse)\b/;
const QUESTION =
  /^(?:what|what's|whats|when|who|whom|whose|where|which|why|how|is|are|was|were|do|does|did|can|could|has|have)\b|\?\s*$/;
const LOOKUP =
  /\b(?:find|search|look (?:up|for)|list|show me|summari[sz]e|check)\b/;
const EXPLICIT_LOOKUP = /\b(?:find|search|look (?:up|for))\b/;
const URL = /\bhttps?:\/\/\S+/;
const AUTHOR =
  /\b(?:make|build|write|create|author|code|design|generate)\b(?:\s+(?:me|us))?\s+(?:a|an|new|some)\b(?!\s+(?:note|loom)\b)/;
const DEICTIC = /\b(?:it|this|these)\b(?!\s+(?:week|month|year|loom)\b)/;
const CONVERSATIONAL =
  /^(?:hi|hey|hello|thanks|thank you|ok|okay|cool|great|nice|yes|no|sure|got it)\b/;

/** Words of a held piece's name long enough to identify it in a request. */
const nameWords = (name: string): string[] =>
  name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) =>
    word.length >= 4
  );

const mentionsHeldPiece = (
  text: string,
  inputCells: TaskClassificationContext["inputCells"],
): boolean =>
  (inputCells ?? []).some((inputCell) =>
    nameWords(inputCell.name).some((word) =>
      new RegExp(`\\b${word}\\b`, "u").test(text)
    )
  );

/**
 * Tags a task by keyword alone, or answers `undefined` when no rule applies.
 * A task naming a held piece, or pointing at one, is about that piece: a
 * listing or question it asks is answered from the piece rather than looked
 * up elsewhere, unless it says to search.
 */
export const classifyTaskByRule = (
  task: string,
  context: TaskClassificationContext,
): Set<HarnessTaskTag> | undefined => {
  const text = task.trim().toLowerCase();
  const tags = new Set<HarnessTaskTag>();
  const holdsPieces = (context.inputCells?.length ?? 0) > 0;
  const pieces = isClosedResearchTask(task, context) ||
    (holdsPieces &&
      (DEICTIC.test(text) || mentionsHeldPiece(text, context.inputCells)));
  if (pieces) tags.add("pieces");
  if (NAVIGATE.test(text)) {
    tags.add("act");
    tags.add("find");
  }
  if (ACT.test(text) || (context.browserHost && WEB_ACT.test(text))) {
    tags.add("act");
  }
  const lookup = QUESTION.test(text) || LOOKUP.test(text) || URL.test(task);
  if (lookup && (!pieces || EXPLICIT_LOOKUP.test(text))) tags.add("find");
  if (AUTHOR.test(text) && !context.patternRefs?.length) tags.add("author");
  if (
    tags.size === 0 && CONVERSATIONAL.test(text) &&
    text.split(/\s+/).length <= 6
  ) {
    tags.add("respond");
  }
  return tags.size === 0 ? undefined : tags;
};

/** The one-shot prompt the model classifies a task by. */
const modelPrompt = (task: string, context: TaskClassificationContext) => {
  const held = [
    ...(context.inputCells ?? []).map((inputCell) =>
      `piece "${inputCell.name}"`
    ),
    ...(context.patternRefs?.length
      ? [`${context.patternRefs.length} attached pattern(s)`]
      : []),
    ...(context.browserHost ? ["a web browser"] : []),
  ];
  return [
    "Tag this request to an agent with every kind of work it calls for:",
    "respond: answer directly from what is already known.",
    "find: look something up in the person's data or on the web.",
    "act: do something in the person's app (open, add, move) or on a web page.",
    "pieces: read or change a piece or pattern the agent was handed.",
    "author: write a new pattern or app from scratch.",
    "Answer with the tags only, comma-separated.",
    `The agent holds: ${held.length > 0 ? held.join(", ") : "nothing"}.`,
    `Request: ${task}`,
  ].join("\n");
};

const modelTags = (answer: string): Set<HarnessTaskTag> =>
  new Set(
    HARNESS_TASK_TAGS.filter((tag) =>
      new RegExp(`\\b${tag}\\b`, "i").test(answer)
    ),
  );

/**
 * Tags a root task: by rule when one applies, otherwise by one cheap model
 * call, otherwise with every tag, which gives the run all the orientation it
 * would have had without classification. A model failure is a fallback, not
 * a run failure.
 */
export const classifyTask = async (
  task: string,
  context: TaskClassificationContext,
  options: { askModel?: (prompt: string) => Promise<string> } = {},
): Promise<HarnessTaskClassification> => {
  const started = performance.now();
  const classified = (
    tags: ReadonlySet<HarnessTaskTag>,
    path: HarnessTaskClassification["path"],
  ): HarnessTaskClassification => ({
    type: "cf-harness.task-classification",
    version: 1,
    tags: HARNESS_TASK_TAGS.filter((tag) => tags.has(tag)),
    path,
    durationMs: Math.round(performance.now() - started),
  });
  const byRule = classifyTaskByRule(task, context);
  if (byRule !== undefined) return classified(byRule, "rule");
  if (options.askModel !== undefined) {
    try {
      const byModel = modelTags(
        await options.askModel(modelPrompt(task, context)),
      );
      if (byModel.size > 0) return classified(byModel, "model");
    } catch {
      // A failed model call leaves the run with full orientation.
    }
  }
  return classified(new Set(HARNESS_TASK_TAGS), "fallback");
};
