/**
 * Running one explore query: a cheap model, the sections it may answer out of,
 * and a bounded reply.
 *
 * The `explore` profile has no tools, so there is no tool loop to run — a
 * single model turn is the whole of it, and the harness stays a caller of the
 * model rather than the parent of another agent. That is what keeps the
 * subagent depth invariant out of this path: `query_docs` starts no child run.
 */

import {
  EXPLORE_RETURN_SCHEMA,
  EXPLORE_SUBAGENT_CODEX_MODEL,
  EXPLORE_SUBAGENT_MODEL,
  MAX_EXPLORE_ANSWER_LENGTH,
  MAX_EXPLORE_CITATIONS,
} from "../contracts/subagent.ts";
import {
  citationOfSection,
  type HarnessDocsCitation,
  type HarnessDocsCorpusSection,
} from "../contracts/docs-corpus.ts";
import type {
  HarnessModelAttemptDiagnostic,
  HarnessModelClient,
  HarnessModelUsage,
} from "../model/client.ts";
import type { HarnessTranscriptMessage } from "../contracts/transcript.ts";
import { parseStructuredResultJson } from "../structured-result.ts";

export interface HarnessExploreQueryRequest {
  question: string;
  sections: readonly HarnessDocsCorpusSection[];
  signal?: AbortSignal;
}

/**
 * What the harness sent the provider for one explore turn, verbatim. The
 * corpus is trusted for confidentiality so no release gate stands between a
 * section and the provider — which is exactly why the record is not optional:
 * an audit and a retrospective read what left from here.
 */
export interface HarnessExploreQuerySent {
  model: string;
  messages: readonly { role: "system" | "user"; content: string }[];
}

export interface HarnessExploreQueryReply {
  answer: string;
  citations: readonly HarnessDocsCitation[];
  sent: HarnessExploreQuerySent;
}

/**
 * What `query_docs` calls to turn a question and a selection of sections into
 * an answer. A run that has no model client to spend has no runner, and the
 * tool says so rather than answering out of nothing.
 */
export type HarnessExploreQueryRunner = (
  request: HarnessExploreQueryRequest,
) => Promise<HarnessExploreQueryReply>;

const EXPLORE_SYSTEM_PROMPT = [
  "You answer one documentation question out of the sections supplied to you,",
  "and nothing else. You have no tools and no other source.",
  "Answer only from the supplied sections. Where they do not answer the",
  "question, say so plainly and cite nothing: an invented answer costs the",
  "reader more than an absent one.",
  "Cite the sections you drew on by their exact path and heading.",
  `Keep the answer under ${MAX_EXPLORE_ANSWER_LENGTH} characters.`,
  "Reply with JSON matching this schema and no other text:",
  JSON.stringify(EXPLORE_RETURN_SCHEMA),
].join("\n");

const sectionBlock = (section: HarnessDocsCorpusSection): string =>
  [
    `--- path: ${section.path}`,
    `--- heading: ${section.heading}`,
    section.text,
  ].join("\n");

/** The one user message an explore turn is given. */
export const exploreQueryPrompt = (
  request: HarnessExploreQueryRequest,
): string =>
  [
    `Question: ${request.question}`,
    "",
    "Sections:",
    ...request.sections.map(sectionBlock),
  ].join("\n\n");

/**
 * The identity of a section for citation matching. A newline separates the two
 * parts because neither can hold one: a corpus path is a single path segment
 * chain and a heading is one line of a document, so no pair of distinct
 * sections can collide on this key.
 */
const sectionKey = (citation: HarnessDocsCitation): string =>
  `${citation.path}\n${citation.heading}`;

/**
 * The reply's citations, keeping only those naming a section the child was
 * actually given. A citation is an address a reader will follow, so one the
 * corpus does not hold is worse than none: it sends them to a document that
 * says nothing about the answer, or to no document at all.
 */
export const admitCitations = (
  value: unknown,
  sections: readonly HarnessDocsCorpusSection[],
): readonly HarnessDocsCitation[] => {
  const supplied = new Map(
    sections.map((section) => {
      const citation = citationOfSection(section);
      return [sectionKey(citation), citation];
    }),
  );
  const admitted: HarnessDocsCitation[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(value) ? value : []) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { path, heading } = entry as Record<string, unknown>;
    if (typeof path !== "string" || typeof heading !== "string") {
      continue;
    }
    const key = sectionKey({ path, heading });
    const citation = supplied.get(key);
    if (citation === undefined || seen.has(key)) {
      continue;
    }
    seen.add(key);
    admitted.push(citation);
    if (admitted.length >= MAX_EXPLORE_CITATIONS) {
      break;
    }
  }
  return admitted;
};

/**
 * The reply a model turn produced, held to the profile's contract: the answer
 * clipped to its bound, and only citations the corpus can back.
 */
export const readExploreQueryReply = (
  content: string,
  sections: readonly HarnessDocsCorpusSection[],
  sent: HarnessExploreQuerySent,
): HarnessExploreQueryReply => {
  const parsed = parseStructuredResultJson(content, {
    emptyMessage: "explore reply was empty",
    invalidMessage: "explore reply was not valid JSON",
  });
  const record = typeof parsed === "object" && parsed !== null
    ? parsed as Record<string, unknown>
    : {};
  const answer = typeof record.answer === "string" ? record.answer : "";
  return {
    answer: answer.slice(0, MAX_EXPLORE_ANSWER_LENGTH),
    citations: admitCitations(record.citations, sections),
    sent,
  };
};

/**
 * Which model answers an explore turn on `providerId`.
 *
 * The profile names a cheap model rather than the run's, because which model
 * answers a documentation question is an operator's choice about cost and not
 * a caller's about the question. That name is a gateway name, and a transport
 * serves only its own models — sending it to one that does not is a refused
 * request, not a fallback — so each transport answers with the model it has.
 */
export const exploreQueryModel = (providerId: string): string =>
  providerId === "openai-codex"
    ? EXPLORE_SUBAGENT_CODEX_MODEL
    : EXPLORE_SUBAGENT_MODEL;

/**
 * An explore runner over `modelClient`, on the model that client's transport
 * serves. What was sent is recorded on the reply, so the model that answered
 * is read off the artifact rather than assumed from the profile.
 */
export const createExploreQueryRunner = (options: {
  modelClient: HarnessModelClient;
  runId: string;

  /** Where this turn's provider attempts are recorded, as any turn's are. */
  onAttempt?: (attempt: HarnessModelAttemptDiagnostic) => void | Promise<void>;

  /** Where this turn's tokens are counted, beside a delegation's. */
  onUsage?: (usage: HarnessModelUsage) => void;
}): HarnessExploreQueryRunner =>
async (request) => {
  const messages = [
    { role: "system", content: EXPLORE_SYSTEM_PROMPT },
    { role: "user", content: exploreQueryPrompt(request) },
  ] as const satisfies readonly HarnessTranscriptMessage[];
  const model = exploreQueryModel(options.modelClient.providerId);
  const sent: HarnessExploreQuerySent = {
    model,
    messages: messages.map((message) => ({ ...message })),
  };
  const result = await options.modelClient.complete({
    model,
    transcript: messages,
    tools: [],
    nativeModelToolIds: [],
    runId: options.runId,
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
    ...(options.onAttempt !== undefined
      ? { onAttempt: options.onAttempt }
      : {}),
  });
  if (result.usage !== undefined) {
    options.onUsage?.(result.usage);
  }
  return readExploreQueryReply(
    result.assistant.content,
    request.sections,
    sent,
  );
};
