import type { JSONSchema } from "@commonfabric/api";
import { encodeHex } from "@std/encoding/hex";
import { sha256 } from "@commonfabric/content-hash";
import {
  computeEntryIdentity,
  ensureCompilerStack,
} from "@commonfabric/runner";

import type {
  HarnessResearchExample,
  HarnessResearchHandleRecord,
  HarnessResearchInputBinding,
  HarnessResearchKit,
  HarnessResearchPatternRecord,
  HarnessResearchRecommendationKind,
  HarnessResearchRule,
  HarnessResearchRunSummary,
  HarnessResearchSourceRead,
  HarnessResearchStatus,
} from "../contracts/research.ts";
import type { HarnessModelToolDescriptor } from "../contracts/tool-descriptor.ts";
import type {
  HarnessAssistantTranscriptMessage,
  HarnessTranscriptMessage,
} from "../contracts/transcript.ts";
import {
  isOperatorProvisionedReferenceAtom,
} from "../contracts/docs-corpus.ts";
import type { HarnessDocsCorpus } from "../docs-corpus/corpus.ts";
import { rankSections } from "../docs-corpus/sections.ts";
import type {
  HarnessModelAttemptDiagnostic,
  HarnessModelClient,
  HarnessModelUsage,
} from "../model/client.ts";
import type {
  PatternIndexPattern,
  PatternIndexProgram,
  PatternIndexSearchRequest,
  PatternIndexSearchResponse,
} from "../pattern-index/client.ts";
import { patternIndexDependencies } from "../pattern-index/composition.ts";
import type { DescribeHandleToolOutput } from "../tools/describe-handle.ts";
import {
  patternIndexDeclaredType,
  patternIndexImportHint,
} from "../tools/search-patterns.ts";
import { parseStructuredResultJson } from "../structured-result.ts";

/** Cheap gateway model used by the bounded research loop. */
export const RESEARCH_MODEL = "gemini-3.5-flash" as const;

/** Cheap model available on the owner-authenticated Codex transport. */
export const RESEARCH_CODEX_MODEL = "gpt-5.6-luna" as const;

/** Most model turns one research call may spend. */
export const MAX_RESEARCH_MODEL_TURNS = 8;

/** Most private tool calls one research call may execute. */
export const MAX_RESEARCH_TOOL_CALLS = 24;

/** Largest exact document or source window returned by one private read. */
export const MAX_RESEARCH_READ_CHARS = 8_000;

/** Total exact document and source characters one research call may read. */
export const MAX_RESEARCH_TOTAL_READ_CHARS = 96_000;

/** Largest complete code or invocation example admitted to a kit. */
export const MAX_RESEARCH_EXAMPLE_CHARS = 24_000;

/** Narrow index surface required by research. */
export interface HarnessResearchPatternIndex {
  /** Searches public pattern metadata. */
  searchPatterns(
    request: PatternIndexSearchRequest,
  ): Promise<PatternIndexSearchResponse>;

  /** Reads one published pattern, optionally with its program. */
  getPattern(request: {
    patternId: string;
    includeSource?: boolean;
  }): Promise<PatternIndexPattern>;
}

/** Dependencies the host gives one bounded research run. */
export interface HarnessResearchRequest {
  /** Whole implementation task or focused follow-up to investigate. */
  task: string;

  /** Unique id used for internal model affinity and provenance. */
  researchRunId: string;

  /** Operator-provisioned documentation, when configured. */
  corpus?: HarnessDocsCorpus;

  /** Lazy pattern-index client, when configured. */
  getPatternIndex?: () => Promise<HarnessResearchPatternIndex>;

  /** General handles visible to the calling run. */
  handleTokens: readonly string[];

  /** Safe shape-only description of one general handle. */
  describeHandle?: (token: string) => Promise<DescribeHandleToolOutput>;

  /** Prior research retained by this run, newest last. */
  priorResearchRuns?: readonly HarnessResearchRunSummary[];

  /** Run-level cancellation signal. */
  signal?: AbortSignal;
}

/** Full artifact-only evidence for one research loop. */
export interface HarnessResearchRecord {
  /** Research artifact discriminator. */
  type: "cf-harness.research-record";

  /** Unique research run id. */
  researchRunId: string;

  /** Cheap model that performed the bounded exploration. */
  model: string;

  /** Task supplied to the loop. */
  task: string;

  /** Complete private model/tool transcript, including exact read windows. */
  messages: readonly HarnessTranscriptMessage[];

  /** Exact trusted reads admitted during the loop. */
  sourceReads: readonly HarnessResearchSourceRead[];

  /** Pattern records independently confirmed by the host. */
  confirmedPatterns: readonly HarnessResearchPatternRecord[];

  /** Handles safely described by the host. */
  describedHandles: readonly HarnessResearchHandleRecord[];

  /** Resource use at the end of the loop. */
  budgets: {
    /** Model turns spent. */
    modelTurns: number;

    /** Private tool calls executed. */
    toolCalls: number;

    /** Exact source characters read. */
    readChars: number;
  };
}

/** Admitted kit plus the artifact-only derivation that produced it. */
export interface HarnessResearchReply {
  /** Structured result safe to give the caller. */
  kit: HarnessResearchKit;

  /** Full research trace retained only in the tool artifact. */
  record: HarnessResearchRecord;
}

/** Failure that carries every private observation made before it occurred. */
export class HarnessResearchError extends Error {
  override name = "HarnessResearchError";

  /** Partial artifact record preserved on the failed builtin output. */
  readonly record: HarnessResearchRecord;

  constructor(message: string, record: HarnessResearchRecord) {
    super(message);
    this.record = record;
  }
}

/** Host-side research function installed into the builtin tool context. */
export type HarnessResearchRunner = (
  request: HarnessResearchRequest,
) => Promise<HarnessResearchReply>;

interface RawResearchResult {
  status?: unknown;
  summary?: unknown;
  recommendation?: unknown;
  inputs?: unknown;
  selectedPatternIds?: unknown;
  steps?: unknown;
  example?: unknown;
  rules?: unknown;
  verification?: unknown;
  sourceIds?: unknown;
  missing?: unknown;
}

interface ResearchState {
  sourceReads: HarnessResearchSourceRead[];
  confirmedPatterns: Map<string, HarnessResearchPatternRecord>;
  searchedPatterns: Map<string, HarnessResearchPatternRecord>;
  programs: Map<string, PatternIndexProgram>;
  describedHandles: Map<string, HarnessResearchHandleRecord>;
  readChars: number;
  toolCalls: number;
}

const RESEARCH_RESULT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["complete", "incomplete"] },
    summary: { type: "string", maxLength: 2_000 },
    recommendation: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["direct-run", "compose", "author", "focused-api"],
        },
        rationale: { type: "string", maxLength: 2_000 },
      },
      required: ["kind", "rationale"],
      additionalProperties: false,
    },
    inputs: {
      type: "array",
      maxItems: 16,
      description:
        "Existing external data handles only. Every token must come from the authoritative inventory and must have a successful describe_handle result. Use [] when the recipe needs no external data; types, defaults, and new local state belong in the example instead.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          token: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description:
              "Exact opaque cfh token from a successful describe_handle result, never a type, default, literal, or raw Fabric reference.",
          },
          purpose: { type: "string", minLength: 1, maxLength: 1_000 },
        },
        required: ["name", "token", "purpose"],
        additionalProperties: false,
      },
    },
    selectedPatternIds: {
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 200 },
    },
    steps: {
      type: "array",
      maxItems: 24,
      items: { type: "string", maxLength: 2_000 },
    },
    example: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["run-pattern-input", "pattern-source"],
        },
        content: { type: "string", maxLength: MAX_RESEARCH_EXAMPLE_CHARS },
        sourceIds: {
          type: "array",
          maxItems: 16,
          description:
            "Exact opened reads supporting every API shown in the example, including APIs mentioned in comments.",
          items: { type: "string", maxLength: 500 },
        },
      },
      required: ["kind", "content", "sourceIds"],
      additionalProperties: false,
    },
    rules: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        properties: {
          rule: { type: "string", maxLength: 2_000 },
          sourceIds: {
            type: "array",
            maxItems: 12,
            items: { type: "string", maxLength: 500 },
          },
        },
        required: ["rule", "sourceIds"],
        additionalProperties: false,
      },
    },
    verification: {
      type: "array",
      maxItems: 24,
      items: { type: "string", maxLength: 2_000 },
    },
    sourceIds: {
      type: "array",
      maxItems: 32,
      items: { type: "string", maxLength: 500 },
    },
    missing: {
      type: "array",
      maxItems: 24,
      description:
        "Actual blockers only. Make routine reversible assumptions in the smallest complete recipe instead of listing optional product choices as missing.",
      items: { type: "string", maxLength: 2_000 },
    },
  },
  required: [
    "status",
    "summary",
    "recommendation",
    "inputs",
    "selectedPatternIds",
    "steps",
    "rules",
    "verification",
    "sourceIds",
    "missing",
  ],
  additionalProperties: false,
};

const SEARCH_DOCS_TOOL: HarnessModelToolDescriptor = {
  toolId: "search_docs",
  title: "Search CF Docs",
  description:
    "Search the operator-provisioned Common Fabric docs and skills corpus. Results are exact section ids and metadata only; call open_doc_section to read one. Search sees the complete section, including text after the first 4,000 characters.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 2 },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const OPEN_DOC_TOOL: HarnessModelToolDescriptor = {
  toolId: "open_doc_section",
  title: "Open Exact CF Doc Section",
  description:
    "Read an exact section returned by search_docs. Reads are bounded; when complete is false, call again with nextOffset to continue through the rest of the same section.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      sectionId: { type: "string" },
      offset: { type: "integer", minimum: 0 },
      maxChars: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RESEARCH_READ_CHARS,
      },
    },
    required: ["sectionId"],
    additionalProperties: false,
  },
};

const SEARCH_PATTERNS_TOOL: HarnessModelToolDescriptor = {
  toolId: "search_pattern_index",
  title: "Search Published Patterns",
  description:
    "Search published Common Fabric pattern metadata. Inspect promising ids before selecting them so source identity, files, dependencies, and contracts are host-confirmed.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
    additionalProperties: false,
  },
};

const INSPECT_PATTERN_TOOL: HarnessModelToolDescriptor = {
  toolId: "inspect_pattern",
  title: "Inspect Published Pattern",
  description:
    "Fetch one indexed pattern with its complete multi-file program, verify its content identity when supported, and return metadata, contracts, dependency ids, and exact file paths without source text. Use open_pattern_file for source.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: { patternId: { type: "string", minLength: 1 } },
    required: ["patternId"],
    additionalProperties: false,
  },
};

const OPEN_PATTERN_FILE_TOOL: HarnessModelToolDescriptor = {
  toolId: "open_pattern_file",
  title: "Open Published Pattern File",
  description:
    "Read a bounded exact range of a file from a pattern already inspected. Continue with nextOffset until complete when the needed contract or example lies later in the file.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      patternId: { type: "string", minLength: 1 },
      path: { type: "string", minLength: 1 },
      offset: { type: "integer", minimum: 0 },
      maxChars: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RESEARCH_READ_CHARS,
      },
    },
    required: ["patternId", "path"],
    additionalProperties: false,
  },
};

const LIST_HANDLES_TOOL: HarnessModelToolDescriptor = {
  toolId: "list_handles",
  title: "List Available Handles",
  description:
    "List the caller's general handle tokens. This reveals no values or shapes; call describe_handle before binding a token in the kit.",
  effectClass: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const DESCRIBE_HANDLE_TOOL: HarnessModelToolDescriptor = {
  toolId: "describe_handle",
  title: "Describe Available Handle",
  description:
    "Read the safe shape-only handle description. Never reads row or cell values. Only described general tokens can become kit inputs.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: { token: { type: "string", minLength: 1 } },
    required: ["token"],
    additionalProperties: false,
  },
};

const RESEARCH_TOOLS = [
  SEARCH_DOCS_TOOL,
  OPEN_DOC_TOOL,
  SEARCH_PATTERNS_TOOL,
  INSPECT_PATTERN_TOOL,
  OPEN_PATTERN_FILE_TOOL,
  LIST_HANDLES_TOOL,
  DESCRIBE_HANDLE_TOOL,
] as const;

const stringValue = (value: unknown, max = 2_000): string =>
  typeof value === "string" ? value.slice(0, max) : "";

const stringList = (
  value: unknown,
  maxItems = 24,
  maxLength = 2_000,
): string[] =>
  (Array.isArray(value) ? value : [])
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, maxItems)
    .map((entry) => entry.slice(0, maxLength));

const integerValue = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) ? value : fallback;

const objectValue = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const runWasAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

const abortError = (signal: AbortSignal | undefined): unknown =>
  signal?.reason ?? new DOMException("Aborted", "AbortError");

const digestText = (text: string): string =>
  `sha256:${encodeHex(sha256(new TextEncoder().encode(text)))}`;

const sourceId = (
  kind: string,
  location: string,
  offset: number,
  end: number,
  contentDigest: string,
) =>
  `${kind}:${
    digestText(`${location}\n${offset}\n${end}\n${contentDigest}`).slice(7, 23)
  }`;

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const researchModel = (providerId: string): string =>
  providerId === "openai-codex" ? RESEARCH_CODEX_MODEL : RESEARCH_MODEL;

const systemPrompt = (): string =>
  [
    "You are the private Common Fabric research loop inside the harness.",
    "Investigate the whole task or focused follow-up using only the supplied tools.",
    "This is CF documentation, skills, pattern-index, source, dependency, and handle research; it is not web research.",
    "Search broadly enough to find the relevant sections and patterns, then open exact evidence. Search results are leads, not evidence.",
    "A long section or source file is never represented by its first chunk alone. Follow nextOffset with another exact read whenever the needed answer could continue later.",
    "Inspect every selected pattern. Read the relevant source files and inspect direct dependencies when composition behavior matters.",
    "A handle binding is supported only after you call describe_handle for that exact token and receive a successful description. Never infer a binding from task prose alone.",
    "The final inputs array is only for existing described external handles. Use [] when the task needs no external data; put types, defaults, literals, and new local state in the recipe.",
    "Never invent a pattern id, import, handle, grant, API rule, source id, or missing input. If the tools do not establish one, return incomplete and name it under missing.",
    "Prefer direct-run when one verified published pattern solves the task, composition when verified parts fit, and author only when reuse does not. Use focused-api only for a narrow rules/contracts answer that needs no runnable recipe.",
    "Return a practical complete invocation or complete source example when possible. Never return a clipped code prefix.",
    "Every API illustrated in an example, including an API mentioned only in a comment, must be supported by an exact opened read cited in example.sourceIds.",
    "Complete the smallest recipe the task asks for. State routine reversible assumptions in the summary or steps; reserve missing for facts whose absence actually blocks a correct implementation.",
    "On your final turn, make no tool calls and return only JSON matching this schema:",
    JSON.stringify(RESEARCH_RESULT_SCHEMA),
  ].join("\n");

const userPrompt = (
  request: HarnessResearchRequest,
): string => {
  const prior = request.priorResearchRuns?.slice(-2) ?? [];
  return [
    "Task:",
    request.task,
    "",
    "Authoritative general handle inventory for this research call:",
    request.handleTokens.length > 0
      ? request.handleTokens.join("\n")
      : "No general handles are available.",
    "Keep these opaque cfh tokens unchanged. Call describe_handle for every token you recommend binding; a failed or skipped description cannot support an input binding.",
    ...(prior.length > 0
      ? [
        "",
        "Prior implementation kits retained by this run:",
        JSON.stringify(prior.map((run) => ({
          researchRunId: run.researchRunId,
          kit: run.kit,
        }))),
        "Treat these as starting context, then use tools to resolve the follow-up or verify anything the current answer relies on.",
      ]
      : []),
  ].join("\n");
};

const toolResultMessage = (
  callId: string,
  toolName: string,
  output: unknown,
): HarnessTranscriptMessage => ({
  role: "tool",
  toolCallId: callId,
  toolName,
  content: JSON.stringify(output),
});

const checkedReadRange = (
  text: string,
  offsetValue: unknown,
  maxCharsValue: unknown,
): { offset: number; end: number; content: string } => {
  const offset = Math.max(0, integerValue(offsetValue, 0));
  if (offset > text.length) {
    throw new Error(`offset ${offset} exceeds ${text.length} characters`);
  }
  const maxChars = Math.max(
    1,
    Math.min(
      MAX_RESEARCH_READ_CHARS,
      integerValue(maxCharsValue, MAX_RESEARCH_READ_CHARS),
    ),
  );
  const end = Math.min(text.length, offset + maxChars);
  return { offset, end, content: text.slice(offset, end) };
};

const addRead = (
  state: ResearchState,
  read: Omit<HarnessResearchSourceRead, "sourceId" | "digest">,
  content: string,
): HarnessResearchSourceRead => {
  if (state.readChars + content.length > MAX_RESEARCH_TOTAL_READ_CHARS) {
    throw new Error(
      `research read budget of ${MAX_RESEARCH_TOTAL_READ_CHARS} characters is exhausted`,
    );
  }
  state.readChars += content.length;
  const digest = digestText(content);
  const admitted: HarnessResearchSourceRead = {
    ...read,
    sourceId: sourceId(
      read.kind,
      read.location,
      read.offset,
      read.end,
      digest,
    ),
    digest,
  };
  const prior = state.sourceReads.find((candidate) =>
    candidate.sourceId === admitted.sourceId
  );
  if (prior === undefined) {
    state.sourceReads.push(admitted);
  }
  return prior ?? admitted;
};

const searchedPatternRecord = (
  hit: PatternIndexSearchResponse["results"][number],
): HarnessResearchPatternRecord => ({
  patternId: hit.patternId,
  description: hit.description,
  hashtags: [...hit.hashtags],
  ...(hit.signals !== undefined ? { signals: { ...hit.signals } } : {}),
  kind: hit.kind,
  quality: hit.quality,
  ...(hit.matchedTerms !== undefined ? { matchedTerms: hit.matchedTerms } : {}),
  ...(hit.queryTerms !== undefined ? { queryTerms: hit.queryTerms } : {}),
  importHint: patternIndexImportHint(hit.patternId),
  ownerDid: hit.ownerDid,
  createdAt: hit.createdAt,
  dependencies: [...hit.dependencies],
});

const inspectPattern = async (
  state: ResearchState,
  index: HarnessResearchPatternIndex,
  patternId: string,
): Promise<Record<string, unknown>> => {
  const pattern = await index.getPattern({ patternId, includeSource: true });
  if (pattern.patternId !== patternId) {
    throw new Error(
      `pattern index returned ${pattern.patternId} for ${patternId}`,
    );
  }
  if (pattern.program === undefined) {
    throw new Error(`pattern ${patternId} has no indexed source program`);
  }
  const program = pattern.program;
  let identityVerified: true | undefined;
  let identityNote: string | undefined;
  let computedIdentity: string | undefined;
  try {
    await ensureCompilerStack();
    computedIdentity = computeEntryIdentity(program.main, program.files, {
      ...(program.sourceRoots !== undefined
        ? { sourceRoots: program.sourceRoots }
        : {}),
      ...(program.dataFiles !== undefined
        ? { dataFiles: program.dataFiles }
        : {}),
    });
  } catch (error) {
    const message = errorMessage(error);
    if (!message.includes("is not supported by the light identity path")) {
      throw error;
    }
    identityNote = message;
  }
  if (computedIdentity !== undefined) {
    if (computedIdentity !== patternId) {
      throw new Error(
        `pattern ${patternId} source computes to identity ${computedIdentity}`,
      );
    }
    identityVerified = true;
  }
  const searched = state.searchedPatterns.get(patternId);
  const dependencies = unique([
    ...pattern.dependencies,
    ...patternIndexDependencies(program.files),
  ]);
  const confirmed: HarnessResearchPatternRecord = {
    patternId,
    description: pattern.description,
    hashtags: [...pattern.hashtags],
    ...(searched?.signals !== undefined
      ? { signals: { ...searched.signals } }
      : {}),
    ...(searched?.kind !== undefined ? { kind: searched.kind } : {}),
    ...(searched?.quality !== undefined ? { quality: searched.quality } : {}),
    ...(searched?.matchedTerms !== undefined
      ? { matchedTerms: searched.matchedTerms }
      : {}),
    ...(searched?.queryTerms !== undefined
      ? { queryTerms: searched.queryTerms }
      : {}),
    importHint: patternIndexImportHint(patternId),
    ...(patternIndexDeclaredType(pattern.argumentSchema) !== undefined
      ? { argumentType: patternIndexDeclaredType(pattern.argumentSchema) }
      : {}),
    ...(patternIndexDeclaredType(pattern.resultSchema) !== undefined
      ? { resultType: patternIndexDeclaredType(pattern.resultSchema) }
      : {}),
    ...(pattern.argumentSchema !== undefined
      ? { argumentSchema: structuredClone(pattern.argumentSchema) }
      : {}),
    ...(pattern.resultSchema !== undefined
      ? { resultSchema: structuredClone(pattern.resultSchema) }
      : {}),
    ownerDid: pattern.ownerDid,
    createdAt: pattern.createdAt,
    main: program.main,
    ...(program.mainExport !== undefined
      ? { mainExport: program.mainExport }
      : {}),
    files: program.files.map((file) => file.name),
    ...(program.sourceRoots !== undefined
      ? { sourceRoots: [...program.sourceRoots] }
      : {}),
    ...(program.dataFiles !== undefined
      ? { dataFiles: [...program.dataFiles] }
      : {}),
    dependencies,
    ...(identityVerified === true ? { sourceIdentityVerified: true } : {}),
    identityVerification: identityVerified === true
      ? { status: "verified", method: "light-entry-identity" }
      : {
        status: "deferred",
        method: "full-fabric-compiler",
        detail: identityNote!,
      },
  };
  // `evidence` is the exact object serialized for this read's digest and the
  // exact object returned to the private model. The source id is its citation
  // address and therefore sits beside it rather than recursively inside it.
  const evidence = structuredClone(confirmed);
  const metadata = JSON.stringify(evidence);
  const read = addRead(state, {
    kind: "pattern-metadata",
    location: `cf:pattern:${patternId}`,
    offset: 0,
    end: metadata.length,
    totalChars: metadata.length,
  }, metadata);
  state.programs.set(patternId, structuredClone(program));
  state.confirmedPatterns.set(patternId, confirmed);
  return {
    sourceId: read.sourceId,
    evidence,
  };
};

const invokeResearchTool = async (
  request: HarnessResearchRequest,
  state: ResearchState,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> => {
  switch (name) {
    case "search_docs": {
      const query = stringValue(input.query, 2_000);
      if (query.length < 2) {
        throw new Error("query must be at least 2 characters");
      }
      const eligible = (request.corpus?.sections ?? []).filter((section) =>
        section.integrity.some(isOperatorProvisionedReferenceAtom)
      );
      const limit = Math.max(1, Math.min(10, integerValue(input.limit, 8)));
      return {
        corpusSections: eligible.length,
        results: rankSections(eligible, query).slice(0, limit).map((entry) => {
          const sectionIndex = request.corpus!.sections.indexOf(entry.section);
          return {
            sectionId: `section-${sectionIndex}`,
            path: entry.section.path,
            heading: entry.section.heading,
            chars: entry.section.text.length,
            score: entry.score,
          };
        }),
      };
    }
    case "open_doc_section": {
      const sectionId = stringValue(input.sectionId, 100);
      const match = /^section-(\d+)$/.exec(sectionId);
      const section = match === null
        ? undefined
        : request.corpus?.sections[Number(match[1])];
      if (
        section === undefined ||
        !section.integrity.some(isOperatorProvisionedReferenceAtom)
      ) {
        throw new Error(`unknown documentation section ${sectionId}`);
      }
      const range = checkedReadRange(
        section.text,
        input.offset,
        input.maxChars,
      );
      const location = `${section.path}#${section.heading} (${sectionId})`;
      const read = addRead(state, {
        kind: "documentation",
        location,
        offset: range.offset,
        end: range.end,
        totalChars: section.text.length,
        integrity: section.integrity.map((atom) => atom.class),
      }, range.content);
      return {
        sourceId: read.sourceId,
        path: section.path,
        heading: section.heading,
        offset: range.offset,
        end: range.end,
        totalChars: section.text.length,
        content: range.content,
        complete: range.end === section.text.length,
        ...(range.end < section.text.length ? { nextOffset: range.end } : {}),
      };
    }
    case "search_pattern_index": {
      if (request.getPatternIndex === undefined) {
        throw new Error("this run has no configured pattern index");
      }
      const text = typeof input.text === "string" ? input.text : undefined;
      const tags = Array.isArray(input.tags)
        ? input.tags.filter((tag): tag is string => typeof tag === "string")
        : undefined;
      if (text === undefined && (tags === undefined || tags.length === 0)) {
        throw new Error("pattern search requires text, tags, or both");
      }
      const index = await request.getPatternIndex();
      const limit = Math.max(1, Math.min(10, integerValue(input.limit, 10)));
      const response = await index.searchPatterns({
        ...(text !== undefined ? { text } : {}),
        ...(tags !== undefined ? { tags } : {}),
        limit,
      });
      const results = response.results.slice(0, limit).map(
        searchedPatternRecord,
      );
      for (const result of results) {
        state.searchedPatterns.set(result.patternId, result);
      }
      return { results };
    }
    case "inspect_pattern": {
      if (request.getPatternIndex === undefined) {
        throw new Error("this run has no configured pattern index");
      }
      const patternId = stringValue(input.patternId, 500);
      if (patternId.length === 0) throw new Error("patternId is required");
      return await inspectPattern(
        state,
        await request.getPatternIndex(),
        patternId,
      );
    }
    case "open_pattern_file": {
      const patternId = stringValue(input.patternId, 500);
      const path = stringValue(input.path, 2_000);
      const program = state.programs.get(patternId);
      if (program === undefined) {
        throw new Error(
          `inspect pattern ${patternId} before opening its files`,
        );
      }
      const file = program.files.find((candidate) => candidate.name === path);
      if (file === undefined) {
        throw new Error(`pattern ${patternId} has no file ${path}`);
      }
      const range = checkedReadRange(
        file.contents,
        input.offset,
        input.maxChars,
      );
      const location = `cf:pattern:${patternId}:${path}`;
      const read = addRead(state, {
        kind: "pattern-source",
        location,
        offset: range.offset,
        end: range.end,
        totalChars: file.contents.length,
      }, range.content);
      return {
        sourceId: read.sourceId,
        patternId,
        path,
        offset: range.offset,
        end: range.end,
        totalChars: file.contents.length,
        content: range.content,
        complete: range.end === file.contents.length,
        ...(range.end < file.contents.length ? { nextOffset: range.end } : {}),
      };
    }
    case "list_handles":
      return { tokens: [...request.handleTokens] };
    case "describe_handle": {
      const token = stringValue(input.token, 500);
      if (!request.handleTokens.includes(token)) {
        throw new Error(`unknown or restricted handle ${token}`);
      }
      if (request.describeHandle === undefined) {
        throw new Error("handle description is unavailable");
      }
      const description = await request.describeHandle(token);
      if (!description.known || description.error !== undefined) {
        return description;
      }
      const record = { token, description };
      state.describedHandles.set(token, record);
      return description;
    }
    default:
      throw new Error(`unknown research tool ${name}`);
  }
};

const parseInputs = (
  value: unknown,
  described: ReadonlyMap<string, HarnessResearchHandleRecord>,
  missing: string[],
): HarnessResearchInputBinding[] => {
  const result: HarnessResearchInputBinding[] = [];
  for (const entry of Array.isArray(value) ? value.slice(0, 16) : []) {
    const record = objectValue(entry);
    const token = stringValue(record.token, 200);
    if (token.length === 0) {
      missing.push("an input binding has no nonempty handle token");
      continue;
    }
    if (!described.has(token)) {
      missing.push(`handle ${token} was not described`);
      continue;
    }
    const name = stringValue(record.name, 200).trim();
    if (name.length === 0) {
      missing.push(`handle ${token} has no nonempty input name`);
      continue;
    }
    const purpose = stringValue(record.purpose, 1_000).trim();
    if (purpose.length === 0) {
      missing.push(`handle ${token} has no nonempty binding purpose`);
      continue;
    }
    result.push({
      name,
      token,
      purpose,
    });
  }
  return result;
};

const parseRules = (
  value: unknown,
  sources: ReadonlyMap<string, HarnessResearchSourceRead>,
  missing: string[],
): HarnessResearchRule[] => {
  const rules: HarnessResearchRule[] = [];
  for (const entry of Array.isArray(value) ? value.slice(0, 24) : []) {
    const record = objectValue(entry);
    const cited = unique(stringList(record.sourceIds, 12, 500));
    const admitted = cited.filter((id) => sources.has(id));
    if (admitted.length !== cited.length) {
      missing.push("one or more API rules cited an unread source");
    }
    if (admitted.length === 0) continue;
    rules.push({ rule: stringValue(record.rule), sourceIds: admitted });
  }
  return rules;
};

const parseExample = (
  value: unknown,
  sources: ReadonlyMap<string, HarnessResearchSourceRead>,
  missing: string[],
): HarnessResearchExample | undefined => {
  const record = objectValue(value);
  const kind = record.kind;
  const content = typeof record.content === "string" ? record.content : "";
  if (
    (kind !== "run-pattern-input" && kind !== "pattern-source") ||
    content.length === 0
  ) return undefined;
  if (content.length > MAX_RESEARCH_EXAMPLE_CHARS) {
    missing.push(
      `complete example exceeds ${MAX_RESEARCH_EXAMPLE_CHARS} characters`,
    );
    return undefined;
  }
  const cited = unique(stringList(record.sourceIds, 16, 500));
  const admitted = cited.filter((id) => sources.has(id));
  if (admitted.length !== cited.length) {
    missing.push("the example cited one or more unread sources");
  }
  if (admitted.length === 0) {
    missing.push("the example has no exact opened source supporting its APIs");
  }
  return { kind, content, sourceIds: admitted };
};

const admitResearchKit = (
  task: string,
  raw: RawResearchResult,
  state: ResearchState,
): HarnessResearchKit => {
  const missing = stringList(raw.missing);
  const sourceMap = new Map(
    state.sourceReads.map((read) => [read.sourceId, read]),
  );
  const citedIds = unique(stringList(raw.sourceIds, 32, 500));
  const sources = citedIds.flatMap((id) => {
    const read = sourceMap.get(id);
    if (read === undefined) {
      missing.push(`source ${id} was not read`);
      return [];
    }
    return [structuredClone(read)];
  });
  const selectedIds = unique(stringList(raw.selectedPatternIds, 8, 500));
  const patterns = selectedIds.flatMap((id) => {
    const pattern = state.confirmedPatterns.get(id);
    if (pattern === undefined) {
      missing.push(`pattern ${id} was not inspected successfully`);
      return [];
    }
    return [structuredClone(pattern)];
  });
  const recommendationRecord = objectValue(raw.recommendation);
  const kindValue = recommendationRecord.kind;
  const kind: HarnessResearchRecommendationKind =
    kindValue === "direct-run" || kindValue === "compose" ||
      kindValue === "author" || kindValue === "focused-api"
      ? kindValue
      : "author";
  const inputs = parseInputs(raw.inputs, state.describedHandles, missing);
  const rules = parseRules(raw.rules, sourceMap, missing);
  const example = parseExample(raw.example, sourceMap, missing);
  if ((kind === "direct-run" || kind === "compose") && patterns.length === 0) {
    missing.push(`${kind} requires an inspected published pattern`);
  }
  if (
    (kind === "direct-run" || kind === "compose") &&
    patterns.some((pattern) => pattern.sourceIdentityVerified !== true)
  ) {
    missing.push(`${kind} requires verified published source identities`);
  }
  if (kind === "direct-run" && example?.kind !== "run-pattern-input") {
    missing.push("direct-run requires a complete run_pattern input example");
  }
  if (
    (kind === "compose" || kind === "author") &&
    example?.kind !== "pattern-source"
  ) {
    missing.push(`${kind} requires a complete pattern-source example`);
  }
  if (kind === "focused-api" && rules.length === 0) {
    missing.push("focused-api requires at least one cited rule");
  }
  if (sources.length === 0) {
    missing.push(
      "no exact documentation or indexed-source read supports the kit",
    );
  }
  const dedupedMissing = unique(missing.filter((entry) => entry.length > 0));
  const requestedStatus: HarnessResearchStatus = raw.status === "complete"
    ? "complete"
    : "incomplete";
  const status: HarnessResearchStatus =
    requestedStatus === "complete" && dedupedMissing.length === 0
      ? "complete"
      : "incomplete";
  return {
    status,
    task,
    summary: stringValue(raw.summary),
    recommendation: {
      kind,
      rationale: stringValue(recommendationRecord.rationale),
    },
    inputs,
    patterns,
    steps: stringList(raw.steps),
    ...(example !== undefined ? { example } : {}),
    rules,
    verification: stringList(raw.verification),
    sources,
    missing: dedupedMissing,
  };
};

/**
 * Creates the bounded host-side research loop. Its private tools can read only
 * the configured corpus, index records, indexed source, and safe handle shape;
 * they cannot delegate, execute commands, write files, or touch Fabric state.
 */
export const createResearchRunner = (options: {
  /** Model transport used for the cheap loop. */
  modelClient: HarnessModelClient;

  /** Records each provider attempt in the parent run report. */
  onAttempt?: (attempt: HarnessModelAttemptDiagnostic) => void | Promise<void>;

  /** Counts research usage beside delegated usage. */
  onUsage?: (usage: HarnessModelUsage) => void;
}): HarnessResearchRunner =>
async (request) => {
  const model = researchModel(options.modelClient.providerId);
  const transcript: HarnessTranscriptMessage[] = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: userPrompt(request) },
  ];
  const state: ResearchState = {
    sourceReads: [],
    confirmedPatterns: new Map(),
    searchedPatterns: new Map(),
    programs: new Map(),
    describedHandles: new Map(),
    readChars: 0,
    toolCalls: 0,
  };
  let finalAssistant: HarnessAssistantTranscriptMessage | undefined;
  let modelTurns = 0;
  const record = (): HarnessResearchRecord => ({
    type: "cf-harness.research-record",
    researchRunId: request.researchRunId,
    model,
    task: request.task,
    messages: transcript,
    sourceReads: state.sourceReads.map((read) => structuredClone(read)),
    confirmedPatterns: [...state.confirmedPatterns.values()].map((record) =>
      structuredClone(record)
    ),
    describedHandles: [...state.describedHandles.values()].map((record) =>
      structuredClone(record)
    ),
    budgets: {
      modelTurns,
      toolCalls: state.toolCalls,
      readChars: state.readChars,
    },
  });
  let synthesisOnly = false;
  let synthesisPromptAdded = false;
  try {
    while (modelTurns < MAX_RESEARCH_MODEL_TURNS) {
      if (runWasAborted(request.signal)) {
        throw abortError(request.signal);
      }
      const reservedFinalTurn = modelTurns === MAX_RESEARCH_MODEL_TURNS - 1;
      const withholdTools = synthesisOnly || reservedFinalTurn;
      if (withholdTools && !synthesisPromptAdded) {
        transcript.push({
          role: "user",
          content: [
            "Synthesis turn: private tools are now withheld.",
            `You used ${modelTurns} of ${MAX_RESEARCH_MODEL_TURNS} model turns, ${state.toolCalls} of ${MAX_RESEARCH_TOOL_CALLS} tool calls, and ${state.readChars} of ${MAX_RESEARCH_TOTAL_READ_CHARS} read characters.`,
            "Return the final schema now. If evidence is missing, return status incomplete and name it rather than calling another tool.",
          ].join("\n"),
        });
        synthesisPromptAdded = true;
      }
      const result = await options.modelClient.complete({
        model,
        transcript: [...transcript],
        tools: withholdTools ? [] : RESEARCH_TOOLS,
        nativeModelToolIds: [],
        runId: request.researchRunId,
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
        ...(options.onAttempt !== undefined
          ? { onAttempt: options.onAttempt }
          : {}),
      });
      modelTurns += 1;
      if (result.usage !== undefined) options.onUsage?.(result.usage);
      transcript.push(result.assistant);
      const calls = result.assistant.toolCalls ?? [];
      if (calls.length === 0) {
        finalAssistant = result.assistant;
        break;
      }
      if (withholdTools) synthesisOnly = true;
      for (const [callIndex, call] of calls.entries()) {
        if (runWasAborted(request.signal)) {
          for (const pending of calls.slice(callIndex)) {
            transcript.push(toolResultMessage(
              pending.id,
              pending.function.name,
              { error: "research cancelled before this call executed" },
            ));
          }
          throw abortError(request.signal);
        }
        if (withholdTools || state.toolCalls >= MAX_RESEARCH_TOOL_CALLS) {
          synthesisOnly = true;
          transcript.push(toolResultMessage(call.id, call.function.name, {
            error: withholdTools
              ? "private tools are withheld on the synthesis turn"
              : `research tool-call budget of ${MAX_RESEARCH_TOOL_CALLS} is exhausted`,
          }));
          continue;
        }
        state.toolCalls += 1;
        let output: unknown;
        try {
          const parsed = parseStructuredResultJson(call.function.arguments, {
            emptyMessage: `${call.function.name} arguments were empty`,
            invalidMessage:
              `${call.function.name} arguments were not valid JSON`,
          });
          output = await invokeResearchTool(
            request,
            state,
            call.function.name,
            objectValue(parsed),
          );
        } catch (error) {
          if (runWasAborted(request.signal)) {
            transcript.push(toolResultMessage(call.id, call.function.name, {
              error: "research cancelled during this call",
            }));
            for (const pending of calls.slice(callIndex + 1)) {
              transcript.push(toolResultMessage(
                pending.id,
                pending.function.name,
                { error: "research cancelled before this call executed" },
              ));
            }
            throw error;
          }
          output = { error: errorMessage(error) };
        }
        transcript.push(toolResultMessage(call.id, call.function.name, output));
      }
    }
    if (finalAssistant === undefined) {
      throw new Error(
        `research exceeded ${MAX_RESEARCH_MODEL_TURNS} model turns without a final kit`,
      );
    }
    const parsed = parseStructuredResultJson(finalAssistant.content, {
      emptyMessage: "research result was empty",
      invalidMessage: "research result was not valid JSON",
    });
    const kit = admitResearchKit(
      request.task,
      objectValue(parsed) as RawResearchResult,
      state,
    );
    return { kit, record: record() };
  } catch (error) {
    if (error instanceof HarnessResearchError) throw error;
    throw new HarnessResearchError(errorMessage(error), record());
  }
};
