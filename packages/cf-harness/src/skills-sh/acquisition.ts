/**
 * Host-side acquisition of one skills.sh discovery id from its immutable
 * GitHub commit. The recursive tree is the payload inventory; only after that
 * inventory passes the instructions-only whitelist is `SKILL.md` fetched.
 */

import { sha256 } from "@commonfabric/content-hash";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";

import {
  defaultHarnessFetch,
  type HarnessFetch,
} from "../contracts/http-fetch.ts";
import {
  parseSkillsShSkillId,
  type ResolveSkillsShHitPinOptions,
  resolveSkillsShSkillIdPin,
  type SkillsShPinnedAddress,
} from "./pin.ts";
import { sanitizeRegistryString } from "./search-client.ts";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_RAW_BASE_URL = "https://raw.githubusercontent.com";
const FULL_GIT_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_TREE_PATH_CHARS = 4_096;
/** Maximum exact byte length admitted for an instructions-only SKILL.md. */
export const SKILLS_SH_MAX_SKILL_BYTES = 256 * 1_024;

export type SkillsShAcquisitionFailureCode =
  | "invalid_pin"
  | "request_failed"
  | "http_error"
  | "unparseable_response"
  | "tree_truncated"
  | "skill_not_found"
  | "skill_ambiguous"
  | "instructions_only"
  | "skill_too_large"
  | "invalid_skill_text";

export class SkillsShAcquisitionError extends Error {
  override readonly name = "SkillsShAcquisitionError";
  readonly code: SkillsShAcquisitionFailureCode;
  readonly offendingCount?: number;
  readonly offendingPaths?: readonly string[];
  readonly candidatePaths?: readonly string[];

  constructor(
    code: SkillsShAcquisitionFailureCode,
    message: string,
    details: {
      offendingPaths?: readonly string[];
      candidatePaths?: readonly string[];
    } = {},
  ) {
    super(message);
    this.code = code;
    if (details.offendingPaths !== undefined) {
      this.offendingCount = details.offendingPaths.length;
      this.offendingPaths = details.offendingPaths;
    }
    if (details.candidatePaths !== undefined) {
      this.candidatePaths = details.candidatePaths;
    }
  }
}

export interface SkillsShAcquiredSkill {
  readonly pin: SkillsShPinnedAddress;
  readonly skillRoot: string;
  readonly sourceUrl: string;
  readonly text: string;
  readonly valueDigest: string;
  readonly loadedPaths: readonly ["SKILL.md"];
}

export interface AcquireSkillsShPinnedSkillOptions {
  readonly fetch?: HarnessFetch;
}

interface GithubTreeEntry {
  readonly path: string;
  readonly mode: "040000" | "100644" | "100755" | "120000" | "160000";
  readonly type: "blob" | "tree" | "commit";
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const safeHostileText = (value: unknown): string =>
  sanitizeRegistryString(
    value instanceof Error ? value.message : String(value),
  );

const acquisitionError = (
  code: SkillsShAcquisitionFailureCode,
  message: string,
): SkillsShAcquisitionError => new SkillsShAcquisitionError(code, message);

const fetchResponse = async (
  fetch: HarnessFetch,
  url: string,
  label: string,
): Promise<Response> => {
  let response: Response;
  try {
    response = await fetch(
      url,
      label === "GitHub tree"
        ? {
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
        }
        : undefined,
    );
  } catch (error) {
    throw acquisitionError(
      "request_failed",
      `${label} could not be reached: ${safeHostileText(error)}`,
    );
  }
  if (!response.ok) {
    throw acquisitionError(
      "http_error",
      `${label} answered ${response.status}`,
    );
  }
  return response;
};

const isUsableTreePath = (path: string): boolean => {
  if (
    path.length === 0 || path.length > MAX_TREE_PATH_CHARS ||
    path.startsWith("/") || path.endsWith("/")
  ) {
    return false;
  }
  return path.split("/").every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".."
  );
};

const readTreeEntries = (body: unknown): readonly GithubTreeEntry[] => {
  const record = asRecord(body);
  if (record === undefined || !Array.isArray(record.tree)) {
    throw acquisitionError(
      "unparseable_response",
      "GitHub tree answered without a tree array",
    );
  }
  if (record.truncated === true) {
    throw acquisitionError(
      "tree_truncated",
      "GitHub marked the recursive tree as truncated; the payload inventory is unreadable",
    );
  }
  if (record.truncated !== false) {
    throw acquisitionError(
      "unparseable_response",
      "GitHub tree answered without an explicit truncation status",
    );
  }

  const entries: GithubTreeEntry[] = [];
  for (const item of record.tree) {
    const entry = asRecord(item);
    const path = entry?.path;
    const mode = entry?.mode;
    const type = entry?.type;
    if (
      typeof path !== "string" || !isUsableTreePath(path) ||
      (mode !== "040000" && mode !== "100644" && mode !== "100755" &&
        mode !== "120000" && mode !== "160000") ||
      (type !== "blob" && type !== "tree" && type !== "commit")
    ) {
      throw acquisitionError(
        "unparseable_response",
        "GitHub tree carried a malformed tree entry",
      );
    }
    entries.push({ path, mode, type });
  }
  return entries;
};

const skillCandidatePaths = (
  pin: SkillsShPinnedAddress,
  entries: readonly GithubTreeEntry[],
): readonly string[] =>
  entries.flatMap((entry) => {
    if (entry.path === "SKILL.md") {
      return pin.repo === pin.slug ? [entry.path] : [];
    }
    const segments = entry.path.split("/");
    if (segments.at(-1) !== "SKILL.md") return [];
    return segments.at(-2) === pin.slug ? [entry.path] : [];
  });

const candidateRoot = (skillPath: string): string => {
  const slash = skillPath.lastIndexOf("/");
  return slash === -1 ? "" : skillPath.slice(0, slash);
};

const displayPath = (path: string): string =>
  sanitizeRegistryString(path) || "(unsafe path)";

const encodedTreePath = (path: string): string =>
  path.split("/").map((segment) => encodeURIComponent(segment)).join("/");

const valueDigestOf = (bytes: Uint8Array): string =>
  `sha256:${toUnpaddedBase64url(sha256(bytes))}`;

const readSkillBytes = async (response: Response): Promise<Uint8Array> => {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      if (total + value.byteLength > SKILLS_SH_MAX_SKILL_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation is cleanup; it cannot replace the size refusal.
        }
        throw acquisitionError(
          "skill_too_large",
          `the pinned SKILL.md exceeds the ${SKILLS_SH_MAX_SKILL_BYTES}-byte limit`,
        );
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/**
 * Fetches the recursive tree and root `SKILL.md` at exactly `pin.commitSha`.
 *
 * The whitelist judges the selected candidate root's subtree, not the whole
 * repository: sibling skills and repository-level files outside that root are
 * not part of the acquired payload. Inside that subtree, only root
 * `SKILL.md` is admitted. Any other path refuses the whole payload. Silently
 * dropping a path would make instructions-only true only of the cell and
 * invisible in the record; a skill whose prose references `scripts/foo.py`
 * is not that skill without the script, and would instead instruct a model to
 * run something that is not there.
 */
export const acquireSkillsShPinnedSkill = async (
  pin: SkillsShPinnedAddress,
  options: AcquireSkillsShPinnedSkillOptions = {},
): Promise<SkillsShAcquiredSkill> => {
  let parsedPin: ReturnType<typeof parseSkillsShSkillId>;
  try {
    parsedPin = parseSkillsShSkillId(pin.id);
  } catch {
    throw acquisitionError(
      "invalid_pin",
      "external skill acquisition requires a validated discovery address",
    );
  }
  if (
    parsedPin.owner !== pin.owner || parsedPin.repo !== pin.repo ||
    parsedPin.slug !== pin.slug ||
    !FULL_GIT_COMMIT_SHA_PATTERN.test(pin.commitSha)
  ) {
    throw acquisitionError(
      "invalid_pin",
      "external skill acquisition requires a validated address and full lowercase commit SHA",
    );
  }
  const fetch = options.fetch ?? defaultHarnessFetch;
  const treeUrl =
    `${GITHUB_API_BASE_URL}/repos/${pin.owner}/${pin.repo}/git/trees/${pin.commitSha}?recursive=1`;
  const treeResponse = await fetchResponse(fetch, treeUrl, "GitHub tree");
  let treeBody: unknown;
  try {
    treeBody = await treeResponse.json();
  } catch {
    throw acquisitionError(
      "unparseable_response",
      "GitHub tree answered with a body that is not JSON",
    );
  }
  const entries = readTreeEntries(treeBody);
  const candidates = skillCandidatePaths(pin, entries);
  if (candidates.length === 0) {
    throw acquisitionError(
      "skill_not_found",
      "the pinned tree contains no root SKILL.md for the exact discovery slug",
    );
  }
  if (candidates.length > 1) {
    const candidatePaths = candidates.map(displayPath);
    throw new SkillsShAcquisitionError(
      "skill_ambiguous",
      `the pinned tree contains ${candidatePaths.length} candidate roots for the exact discovery slug`,
      { candidatePaths },
    );
  }

  const skillPath = candidates[0];
  const skillEntry = entries.find((entry) => entry.path === skillPath);
  if (
    skillEntry?.type !== "blob" ||
    (skillEntry.mode !== "100644" && skillEntry.mode !== "100755")
  ) {
    throw acquisitionError(
      "unparseable_response",
      "the candidate root SKILL.md is not a regular file",
    );
  }
  const root = candidateRoot(skillPath);
  const rootPrefix = root === "" ? "" : `${root}/`;
  const payloadEntries = entries.filter((entry) =>
    root === "" || entry.path.startsWith(rootPrefix)
  );
  const offendingPaths = payloadEntries
    .filter((entry) => entry.path !== skillPath)
    .map((entry) =>
      displayPath(
        root === "" ? entry.path : entry.path.slice(rootPrefix.length),
      )
    );
  if (offendingPaths.length > 0) {
    throw new SkillsShAcquisitionError(
      "instructions_only",
      `instructions-only acquisition refused ${offendingPaths.length} offending paths: ${
        offendingPaths.join(", ")
      }`,
      { offendingPaths },
    );
  }
  const sourceUrl =
    `${GITHUB_RAW_BASE_URL}/${pin.owner}/${pin.repo}/${pin.commitSha}/${
      encodedTreePath(skillPath)
    }`;
  const skillResponse = await fetchResponse(
    fetch,
    sourceUrl,
    "GitHub raw SKILL.md",
  );
  const bytes = await readSkillBytes(skillResponse);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw acquisitionError(
      "invalid_skill_text",
      "the pinned SKILL.md bytes are not UTF-8",
    );
  }
  if (text.trim().length === 0) {
    throw acquisitionError(
      "invalid_skill_text",
      "the pinned SKILL.md is empty",
    );
  }

  return {
    pin,
    skillRoot: root === "" ? "." : displayPath(root),
    sourceUrl,
    text,
    valueDigest: valueDigestOf(bytes),
    loadedPaths: ["SKILL.md"],
  };
};

export interface SkillsShAcquisitionClientOptions {
  readonly fetch?: HarnessFetch;
}

/** GitHub pin resolution and pinned acquisition for one run. */
export class SkillsShAcquisitionClient {
  readonly #fetch: HarnessFetch;

  constructor(options: SkillsShAcquisitionClientOptions = {}) {
    this.#fetch = options.fetch ?? defaultHarnessFetch;
  }

  resolvePin(
    id: string,
    options: Omit<ResolveSkillsShHitPinOptions, "fetch"> = {},
  ): Promise<SkillsShPinnedAddress> {
    return resolveSkillsShSkillIdPin(id, { ...options, fetch: this.#fetch });
  }

  acquirePin(pin: SkillsShPinnedAddress): Promise<SkillsShAcquiredSkill> {
    return acquireSkillsShPinnedSkill(pin, { fetch: this.#fetch });
  }
}

/** Builds the pinned-acquisition client used by a run. */
export type HarnessSkillsShAcquisitionClientFactory = () => Promise<
  SkillsShAcquisitionClient
>;

/** Creates a client factory over the host's GitHub fetch capability. */
export const createHarnessSkillsShAcquisitionClientFactory = (
  fetch?: HarnessFetch,
): HarnessSkillsShAcquisitionClientFactory =>
() =>
  Promise.resolve(
    new SkillsShAcquisitionClient(fetch === undefined ? {} : { fetch }),
  );

/** Caches a healthy client for one run and forgets a rejected construction. */
export const cacheHarnessSkillsShAcquisitionClientFactory = (
  factory: HarnessSkillsShAcquisitionClientFactory,
): HarnessSkillsShAcquisitionClientFactory => {
  let client: Promise<SkillsShAcquisitionClient> | undefined;
  return () => {
    if (client === undefined) {
      const attempt = Promise.resolve().then(factory).catch((error) => {
        if (client === attempt) client = undefined;
        throw error;
      });
      client = attempt;
    }
    return client;
  };
};
