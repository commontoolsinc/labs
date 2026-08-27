/**
 * The typed client for the deployed pattern index: a small JSON-over-HTTP
 * surface for searching published patterns, reading one back, recording what
 * a run did with it, and publishing a new one. Every call is a POST to
 * `{baseUrl}/{function}` signed with the CF1 first-party scheme, so the index
 * sees the run's own identity rather than a shared secret.
 *
 * Everything here runs on the trusted host side. A pattern's source reaches
 * this module and the `run_pattern` compile path and stops there: it is never
 * placed in model-facing output.
 */

import type { JSONSchema } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import {
  type FirstPartyHttpSigner,
  signFirstPartyHttpRequest,
} from "@commonfabric/runner/toolshed-http-auth";
import type { HarnessPatternIndexConfig } from "../config.ts";
import {
  defaultHarnessFetch,
  type HarnessFetch,
} from "../contracts/http-fetch.ts";

/** Usage counters the index keeps for a pattern, when it has any. */
export interface PatternIndexSignals {
  uses: number;
  score: number;
}

/** One hit from `searchPatterns`. Carries metadata and never source. */
export interface PatternIndexSearchResult {
  patternId: string;
  description: string;
  hashtags: readonly string[];
  ownerDid: string;
  createdAt: string;
  dependencies: readonly string[];
  signals?: PatternIndexSignals;

  /**
   * With a text query: how many of its terms this hit carries, out of
   * `queryTerms`. Text matching is disjunctive and ranked, so a hit is not a
   * claim that everything matched — the ratio is what says how close.
   */
  matchedTerms?: number;
  queryTerms?: number;
}

export interface PatternIndexSearchRequest {
  tags?: readonly string[];
  text?: string;
  limit?: number;
}

export interface PatternIndexSearchResponse {
  results: readonly PatternIndexSearchResult[];
}

export interface PatternIndexProgramFile {
  name: string;
  contents: string;
}

/**
 * The published program, in the shape a `RuntimeProgram` is assembled from.
 * Present only when `getPattern` was asked for source.
 */
export interface PatternIndexProgram {
  main: string;
  mainExport?: string;
  files: readonly PatternIndexProgramFile[];
  sourceRoots?: readonly string[];
  dataFiles?: readonly string[];
}

export interface PatternIndexPattern {
  patternId: string;
  ownerDid: string;
  createdAt: string;
  description: string;
  hashtags: readonly string[];
  argumentSchema?: JSONSchema;
  resultSchema?: JSONSchema;
  dependencies: readonly string[];
  priorPatternId?: string;
  program?: PatternIndexProgram;
}

export interface PatternIndexGetRequest {
  patternId: string;
  includeSource?: boolean;
}

/**
 * What a run reports back about a pattern it took from the index. The index
 * ranks on these, so a run that instantiates a pattern and then fails says
 * both things rather than only the first.
 */
export type PatternIndexEventType =
  | "created"
  | "instantiated"
  | "run_succeeded"
  | "run_failed"
  | "thumbs_up"
  | "thumbs_down";

export interface PatternIndexRecordEventRequest {
  patternId: string;
  eventType: PatternIndexEventType;
  note?: string;
}

export interface PatternIndexRecordEventResponse {
  ok: boolean;
}

export interface PatternIndexPublishRequest {
  /**
   * The program's content-addressed entry identity — what
   * `computeEntryIdentity` answers for the same `main` and files. The index
   * stores a pattern under the identity the publisher computed, so the same
   * source published twice is the same entry rather than a second copy.
   */
  patternId: string;

  description: string;
  hashtags: readonly string[];

  /**
   * The request this pattern was written to answer, kept by the index for
   * ranking and never returned by a read.
   */
  directQuery: string;

  keywords?: readonly string[];
  program: PatternIndexProgram;
  argumentSchema?: JSONSchema;
  resultSchema?: JSONSchema;
  dependencies?: readonly string[];
  priorPatternId?: string;
}

export interface PatternIndexPublishResponse {
  patternId: string;

  /** `false` when the index already held this identity, which is not an error. */
  created: boolean;
}

/**
 * A non-2xx answer from the index, carrying the HTTP status alongside the
 * `error` message the service returned. The status is what separates a
 * misconfigured identity (401/403) from a pattern that is not there (404),
 * and callers phrase their own message from it.
 */
export class PatternIndexError extends Error {
  override name = "PatternIndexError";
  readonly status: number;

  /** The index function that answered, for a message that says where. */
  readonly fn: string;

  /**
   * What the service actually said. Deliberately NOT part of `message`: a
   * failure body from the index can quote indexed source or storage detail,
   * and `message` is what tool error paths render toward the model. The
   * detail is for artifacts — the paths that stash withheld text into
   * `rawCauseMessage` read it from here.
   */
  readonly detail?: string;

  constructor(fn: string, status: number, detail?: string) {
    super(`pattern index ${fn} failed (${status})`);
    this.fn = fn;
    this.status = status;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

export interface PatternIndexClientOptions {
  baseUrl: string;
  fetchFn?: HarnessFetch;
  signer: FirstPartyHttpSigner;
}

/**
 * Joins an index function onto the configured base, keeping every segment the
 * base already carries. `new URL(fn, base)` would drop the base's last
 * segment whenever it has no trailing slash, which is how a deployment served
 * under a path prefix loses that prefix.
 */
const functionUrl = (baseUrl: string, fn: string): URL =>
  new URL(`${baseUrl.replace(/\/+$/, "")}/${fn}`);

export class PatternIndexClient {
  readonly #baseUrl: string;
  readonly #fetchFn: HarnessFetch;
  readonly #signer: FirstPartyHttpSigner;

  constructor(options: PatternIndexClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#fetchFn = options.fetchFn ?? defaultHarnessFetch;
    this.#signer = options.signer;
  }

  /**
   * Posts `payload` to one index function and returns its parsed answer.
   *
   * @throws PatternIndexError when the index answers non-2xx, or when a 2xx
   * answer does not parse as JSON — a body the caller cannot read is a
   * failure of the call rather than a result.
   */
  async #call<T>(fn: string, payload: Record<string, unknown>): Promise<T> {
    const url = functionUrl(this.#baseUrl, fn);
    // The proof commits to the body hash, so the bytes signed and the bytes
    // sent must be identical — serialize once.
    const body = JSON.stringify(payload);
    const headers = await signFirstPartyHttpRequest({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signer: this.#signer,
    });
    const response = await this.#fetchFn(url, {
      method: "POST",
      headers,
      body,
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const error = typeof parsed === "object" && parsed !== null &&
          typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : text.slice(0, 200);
      throw new PatternIndexError(fn, response.status, error);
    }
    if (parsed === undefined) {
      throw new PatternIndexError(
        fn,
        response.status,
        "answer was not JSON",
      );
    }
    return parsed as T;
  }

  searchPatterns(
    request: PatternIndexSearchRequest,
  ): Promise<PatternIndexSearchResponse> {
    return this.#call<PatternIndexSearchResponse>("searchPatterns", {
      ...(request.tags !== undefined ? { tags: [...request.tags] } : {}),
      ...(request.text !== undefined ? { text: request.text } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    });
  }

  getPattern(request: PatternIndexGetRequest): Promise<PatternIndexPattern> {
    return this.#call<PatternIndexPattern>("getPattern", {
      patternId: request.patternId,
      ...(request.includeSource !== undefined
        ? { includeSource: request.includeSource }
        : {}),
    });
  }

  recordEvent(
    request: PatternIndexRecordEventRequest,
  ): Promise<PatternIndexRecordEventResponse> {
    return this.#call<PatternIndexRecordEventResponse>("recordEvent", {
      patternId: request.patternId,
      eventType: request.eventType,
      ...(request.note !== undefined ? { note: request.note } : {}),
    });
  }

  publishPattern(
    request: PatternIndexPublishRequest,
  ): Promise<PatternIndexPublishResponse> {
    const schemas = {
      ...(request.argumentSchema !== undefined
        ? { argumentSchema: request.argumentSchema }
        : {}),
      ...(request.resultSchema !== undefined
        ? { resultSchema: request.resultSchema }
        : {}),
    };
    return this.#call<PatternIndexPublishResponse>("publishPattern", {
      patternId: request.patternId,
      program: request.program,
      meta: {
        directQuery: request.directQuery,
        description: request.description,
        hashtags: [...request.hashtags],
        ...(request.keywords !== undefined
          ? { keywords: [...request.keywords] }
          : {}),
      },
      ...(Object.keys(schemas).length > 0 ? { schemas } : {}),
      ...(request.dependencies !== undefined
        ? { dependencies: [...request.dependencies] }
        : {}),
      ...(request.priorPatternId !== undefined
        ? { priorPatternId: request.priorPatternId }
        : {}),
    });
  }
}

/**
 * Builds the run's pattern-index client. The engine caches a healthy result
 * so a factory is called at most once per run; a construction failure
 * surfaces as an ordinary tool-output error, and the next tool call invokes
 * the factory again.
 */
export type HarnessPatternIndexClientFactory = () => Promise<
  PatternIndexClient
>;

/**
 * Default factory over `config`. Requests are signed with the run's Fabric
 * identity — the index authorizes the same principal the run writes to its
 * space as — so the keyfile path comes from the fabric session config, which
 * is why a pattern index without one is a configuration error.
 */
export const createHarnessPatternIndexClientFactory = (
  config: HarnessPatternIndexConfig,
  identityKeyPath: string,
  fetchFn?: HarnessFetch,
): HarnessPatternIndexClientFactory =>
async () => {
  const identity = await Identity.fromPkcs8(
    await Deno.readFile(identityKeyPath),
  );
  return new PatternIndexClient({
    baseUrl: config.baseUrl,
    signer: identity,
    ...(fetchFn !== undefined ? { fetchFn } : {}),
  });
};

/**
 * Wraps `factory` so a healthy client is built once and shared by every
 * invocation in the run. An in-flight construction is shared too, but a
 * REJECTED construction clears the cache: the failure still reaches every
 * caller awaiting it, and the next tool call invokes the factory again rather
 * than replaying a terminal failure for the rest of the run.
 */
export const cacheHarnessPatternIndexClientFactory = (
  factory: HarnessPatternIndexClientFactory,
): HarnessPatternIndexClientFactory => {
  let client: Promise<PatternIndexClient> | undefined;
  return () => {
    if (client === undefined) {
      const attempt: Promise<PatternIndexClient> = Promise.resolve()
        .then(factory)
        .catch((error) => {
          if (client === attempt) {
            client = undefined;
          }
          throw error;
        });
      client = attempt;
    }
    return client;
  };
};
