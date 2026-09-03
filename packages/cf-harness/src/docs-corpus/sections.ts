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

/** Longest section text the corpus keeps, in characters. */
export const MAX_SECTION_TEXT_LENGTH = 4_000;

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

const trimSectionText = (lines: readonly string[]): string => {
  const text = lines.join("\n").trim();
  return text.length > MAX_SECTION_TEXT_LENGTH
    ? text.slice(0, MAX_SECTION_TEXT_LENGTH)
    : text;
};

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
    const sectionText = trimSectionText(lines);
    if (sectionText.length > 0) {
      sections.push({ ...document, heading, text: sectionText });
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
  const terms = questionTerms(question);
  if (terms.length === 0) {
    return [];
  }
  const maxSections = options.maxSections ?? DEFAULT_SELECTED_SECTIONS;
  const maxChars = options.maxChars ?? MAX_SELECTED_SECTION_CHARS;
  const scored = sections
    .map((section) => ({ section, score: scoreSection(section, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      utf8Compare(left.section.path, right.section.path) ||
      utf8Compare(left.section.heading, right.section.heading)
    );
  const selected: HarnessDocsCorpusSection[] = [];
  let chars = 0;
  for (const entry of scored) {
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
