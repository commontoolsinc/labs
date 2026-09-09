/**
 * The `query_docs` tool: one documentation question, one bounded answer, and
 * the places it came from.
 *
 * The corpus is operator-provisioned reference material read on the host, and
 * every section of it carries an integrity endorsement naming the root it was
 * provisioned under. That endorsement is what makes a section eligible: text
 * written into the workspace is not corpus, so it cannot reach an answer, and
 * a reader of the run can tell the two apart by the label rather than by trust
 * in a mount.
 */

import type { JSONSchema } from "@commonfabric/api";

import {
  CFC_HARNESS_ATOM_CLASS,
  type HarnessDocsCitation,
  type HarnessDocsCorpusSection,
  isOperatorProvisionedReferenceAtom,
} from "../contracts/docs-corpus.ts";
import {
  EXPLORE_SUBAGENT_PROFILE,
  MAX_EXPLORE_ANSWER_LENGTH,
  MAX_EXPLORE_CITATIONS,
} from "../contracts/subagent.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import { admitCitations } from "../docs-corpus/explore.ts";
import { selectSections } from "../docs-corpus/sections.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface QueryDocsToolInput {
  question: string;
  maxCitations?: number;
}

export interface QueryDocsToolAnswerOutput {
  outputId: string;
  status: "ok";
  answer: string;
  citations: readonly HarnessDocsCitation[];

  /**
   * The endorsement classes carried by the sections the answer was built out
   * of. Empty exactly when the corpus held nothing for the question, which is
   * the one case where no reference material was read.
   */
  provenance: { integrity: readonly string[] };

  /** What the corpus held, and how much of it the question reached. */
  searched: { corpusSections: number; readSections: number };

  /**
   * What the explore turn was given and what it was sent to, kept on the
   * artifact and stripped before the answer reaches the caller. The caller
   * asked a question and is owed an answer; a reader of the run is owed the
   * bytes that left for the provider, and the two are not the same audience.
   *
   * Absent where the corpus matched nothing, which is the one answer no
   * explore turn was spent on.
   */
  exploreRecord?: HarnessQueryDocsExploreRecord;
}

/** One explore turn, as the run's artifact records it. */
export interface HarnessQueryDocsExploreRecord {
  type: "cf-harness.query-docs-explore-record";
  profile: typeof EXPLORE_SUBAGENT_PROFILE;
  model: string;
  question: string;

  /** The sections the turn was given, with the endorsement each carries. */
  sections: readonly {
    path: string;
    heading: string;
    chars: number;
    integrity: readonly string[];
  }[];

  messages: readonly { role: string; content: string }[];
}

export interface QueryDocsToolErrorOutput {
  outputId: string;
  status: "error";
  message: string;
}

export type QueryDocsToolOutput =
  | QueryDocsToolAnswerOutput
  | QueryDocsToolErrorOutput;

export const queryDocsToolDescriptor: HarnessToolDescriptor = {
  toolId: "query_docs",
  title: "Query Docs",
  description:
    "Ask one question of the operator-provisioned documentation and get a short answer plus the sections it came from. A cheap model reads the matching sections on the trusted host side; you receive the answer, never the documents. Citations are addresses — a path and a heading — and carry no text, so open one with read_file when the answer is not enough. Reach for this instead of guessing at an import, an API, or a rule.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        minLength: 3,
        description:
          "The question to answer, in a sentence. Name the symbol, error text, or rule you are stuck on.",
      },
      maxCitations: {
        type: "integer",
        minimum: 1,
        maximum: MAX_EXPLORE_CITATIONS,
        description:
          "Most sections to answer out of. Values above the cap read as the cap.",
      },
    },
    required: ["question"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["ok"] },
        answer: { type: "string", maxLength: MAX_EXPLORE_ANSWER_LENGTH },
        citations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              heading: { type: "string" },
            },
            required: ["path", "heading"],
            additionalProperties: false,
          },
        },
        provenance: {
          type: "object",
          properties: {
            integrity: { type: "array", items: { type: "string" } },
          },
          required: ["integrity"],
          additionalProperties: false,
        },
        searched: {
          type: "object",
          properties: {
            corpusSections: { type: "integer", minimum: 0 },
            readSections: { type: "integer", minimum: 0 },
          },
          required: ["corpusSections", "readSections"],
          additionalProperties: false,
        },
        exploreRecord: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["cf-harness.query-docs-explore-record"],
            },
            profile: { type: "string", enum: [EXPLORE_SUBAGENT_PROFILE] },
            model: { type: "string" },
            question: { type: "string" },
            sections: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  heading: { type: "string" },
                  chars: { type: "integer", minimum: 0 },
                  integrity: { type: "array", items: { type: "string" } },
                },
                required: ["path", "heading", "chars", "integrity"],
                additionalProperties: false,
              },
            },
            messages: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string" },
                  content: { type: "string" },
                },
                required: ["role", "content"],
                additionalProperties: false,
              },
            },
          },
          required: [
            "type",
            "profile",
            "model",
            "question",
            "sections",
            "messages",
          ],
          additionalProperties: false,
        },
      },
      required: [
        "outputId",
        "status",
        "answer",
        "citations",
        "provenance",
        "searched",
      ],
      additionalProperties: false,
    }, {
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["error"] },
        message: { type: "string" },
      },
      required: ["outputId", "status", "message"],
      additionalProperties: false,
    }],
  } satisfies JSONSchema,
  tags: ["docs", "search", "explore"],
};

const NO_MATCH_ANSWER =
  "The documentation corpus holds nothing about that question.";

/**
 * The sections an answer may be built out of: those carrying the
 * operator-provisioned endorsement, and no others. The filter runs over what
 * the loader produced rather than trusting it, so a corpus assembled by some
 * other route cannot smuggle an unendorsed section into an answer.
 */
const endorsedSections = (
  sections: readonly HarnessDocsCorpusSection[],
): readonly HarnessDocsCorpusSection[] =>
  sections.filter((section) =>
    section.integrity.some(isOperatorProvisionedReferenceAtom)
  );

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const queryDocsTool: HarnessToolDefinition<
  QueryDocsToolInput,
  QueryDocsToolOutput
> = {
  descriptor: queryDocsToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("query_docs");
    const errorOutput = (message: string): QueryDocsToolErrorOutput => ({
      outputId,
      status: "error",
      message,
    });
    if (context.getDocsCorpus === undefined) {
      return errorOutput(
        "query_docs requires a documentation corpus; configure --docs-corpus-root",
      );
    }
    if (context.runExploreQuery === undefined) {
      return errorOutput("query_docs requires the host explore query runner");
    }
    try {
      const corpus = await context.getDocsCorpus();
      const eligible = endorsedSections(corpus.sections);
      const sections = selectSections(eligible, input.question, {
        maxSections: Math.min(
          input.maxCitations ?? MAX_EXPLORE_CITATIONS,
          MAX_EXPLORE_CITATIONS,
        ),
      });
      const searched = {
        corpusSections: eligible.length,
        readSections: sections.length,
      };
      if (sections.length === 0) {
        return {
          outputId,
          status: "ok",
          answer: NO_MATCH_ANSWER,
          citations: [],
          provenance: { integrity: [] },
          searched,
        };
      }
      const reply = await context.runExploreQuery({
        question: input.question,
        sections,
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      });
      return {
        outputId,
        status: "ok",
        answer: reply.answer,
        // The reply's citations are held to the sections this call selected,
        // here rather than only where a reply is parsed: what a citation
        // addresses is the tool's contract with its caller, so the tool is
        // where an address the corpus cannot back stops.
        citations: admitCitations(reply.citations, sections),
        provenance: {
          integrity: [CFC_HARNESS_ATOM_CLASS.OperatorProvisionedReference],
        },
        searched,
        exploreRecord: {
          type: "cf-harness.query-docs-explore-record",
          profile: EXPLORE_SUBAGENT_PROFILE,
          model: reply.sent.model,
          question: input.question,
          sections: sections.map((section) => ({
            path: section.path,
            heading: section.heading,
            chars: section.text.length,
            integrity: section.integrity.map((atom) => atom.class),
          })),
          messages: reply.sent.messages.map((message) => ({ ...message })),
        },
      };
    } catch (error) {
      // A cancelled run is the loop's to end, not a failure the model reacts
      // to: answering an aborted query with a tool error would have the child
      // spend its next turn on a run that is already over.
      if (context.signal?.aborted === true) {
        throw error;
      }
      return errorOutput(`query_docs failed: ${errorMessage(error)}`);
    }
  },
};
