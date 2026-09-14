/**
 * Splitting Markdown into addressable sections, and choosing the few a
 * question is answered out of.
 *
 * A section rather than a file is the unit here because the whole point of the
 * tool is that a child stops paying for a document to read a rule. Selection is
 * lexical and deterministic: the same question over the same corpus chooses the
 * same sections, which is what makes a query reproducible from a run's record.
 */

import { utf8Compare } from "@commonfabric/utils/utf8";

import type { HarnessDocsCorpusSection } from "../contracts/docs-corpus.ts";

/** How many sections an answer is built out of unless a caller says fewer. */
export const DEFAULT_SELECTED_SECTIONS = 8;

/** Total characters of section text one query may put in front of the model. */
export const MAX_SELECTED_SECTION_CHARS = 24_000;

/**
 * Words carrying no discrimination between documentation sections. Scoring
 * them would rank a section by how much English it contains rather than by
 * how much of the question it answers.
 */
const STOP_WORDS = new Set([
  "a",
  "all",
  "and",
  "are",
  "can",
  "does",
  "doing",
  "for",
  "from",
  "how",
  "into",
  "not",
  "should",
  "that",
  "the",
  "this",
  "use",
  "using",
  "was",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with",
  "you",
  "your",
]);

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;

const sectionText = (lines: readonly string[]): string =>
  lines.join("\n").trim();

/**
 * The sections of one Markdown document. Text above the first heading becomes
 * a section with an empty heading, so a document's opening paragraph — which
 * is where a short skill file says what it is for — is reachable rather than
 * dropped.
 *
 * A fenced code block is passed through verbatim, backtick-fenced or
 * tilde-fenced alike: a `#` inside one is a shell comment or a CSS id, and
 * reading it as a heading would split a section in the middle of an example.
 */
export const splitMarkdownSections = (
  document: Omit<HarnessDocsCorpusSection, "heading" | "text">,
  text: string,
): readonly HarnessDocsCorpusSection[] => {
  const sections: HarnessDocsCorpusSection[] = [];
  let heading = "";
  let lines: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = sectionText(lines);
    if (text.length > 0) {
      sections.push({ ...document, heading, text });
    }
    lines = [];
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      lines.push(line);
      continue;
    }
    const match = inFence ? null : HEADING_PATTERN.exec(line);
    if (match === null) {
      lines.push(line);
      continue;
    }
    flush();
    heading = match[2].trim();
  }
  flush();
  return sections;
};

/** The scoring terms of a question, lowercased and stripped of stop words. */
export const questionTerms = (question: string): readonly string[] => {
  const terms = new Set<string>();
  for (const raw of question.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length >= 3 && !STOP_WORDS.has(raw)) {
      terms.add(raw);
    }
  }
  return [...terms];
};

const occurrences = (haystack: string, term: string): number => {
  let count = 0;
  let index = haystack.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(term, index + term.length);
  }
  return count;
};

/**
 * How well a section answers a question. A term in the heading or the path
 * counts for more than a term in the body: a heading is the section's own
 * claim about its subject, and a body mention may be an aside.
 */
export const scoreSection = (
  section: HarnessDocsCorpusSection,
  terms: readonly string[],
): number => {
  const heading = section.heading.toLowerCase();
  const path = section.path.toLowerCase();
  const body = section.text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    score += occurrences(heading, term) * 8;
    score += occurrences(path, term) * 4;
    score += Math.min(occurrences(body, term), 8);
  }
  return score;
};

export interface SelectSectionsOptions {
  maxSections?: number;
  maxChars?: number;
}

/** One section and its deterministic lexical score for a query. */
export interface RankedDocsCorpusSection {
  /** Section found in the corpus. */
  section: HarnessDocsCorpusSection;

  /** Weighted occurrences of the query terms. */
  score: number;
}

/**
 * Every section that lexically matches `query`, in deterministic best-first
 * order. The section remains whole: callers that expose text apply their own
 * read window, so ranking a long section never destroys its tail.
 */
export const rankSections = (
  sections: readonly HarnessDocsCorpusSection[],
  query: string,
): readonly RankedDocsCorpusSection[] => {
  const terms = questionTerms(query);
  if (terms.length === 0) {
    return [];
  }
  return sections
    .map((section) => ({ section, score: scoreSection(section, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      utf8Compare(left.section.path, right.section.path) ||
      utf8Compare(left.section.heading, right.section.heading)
    );
};

/**
 * The sections a question is answered out of, best first. Sections scoring
 * zero are left out rather than padding the selection: a question the corpus
 * says nothing about is better answered with nothing than with the first
 * eight documents in path order.
 *
 * Ties break on path and heading under the repository's code-point comparator,
 * so the selection is a function of the corpus and the question alone rather
 * than of the host's default locale.
 */
export const selectSections = (
  sections: readonly HarnessDocsCorpusSection[],
  question: string,
  options: SelectSectionsOptions = {},
): readonly HarnessDocsCorpusSection[] => {
  const maxSections = options.maxSections ?? DEFAULT_SELECTED_SECTIONS;
  const maxChars = options.maxChars ?? MAX_SELECTED_SECTION_CHARS;
  const selected: HarnessDocsCorpusSection[] = [];
  let chars = 0;
  for (const entry of rankSections(sections, question)) {
    if (selected.length >= maxSections) {
      break;
    }
    if (chars + entry.section.text.length > maxChars) {
      continue;
    }
    selected.push(entry.section);
    chars += entry.section.text.length;
  }
  return selected;
};
