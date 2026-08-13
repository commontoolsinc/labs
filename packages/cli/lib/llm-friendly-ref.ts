import { ValidationError } from "@cliffy/command";
import type { CellScope } from "@commonfabric/api";
import {
  matchLLMFriendlyLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner";

/** A piece reference normalized from its LLM-friendly link form. */
export interface NormalizedLLMFriendlyRef {
  pieceId: string;
  scope?: CellScope;
  /**
   * Path segments embedded in the reference, in the segment form
   * `parseCellPath` produces: a segment of digits is a number.
   */
  path: (string | number)[];
}

/**
 * Convert a decoded link path segment to the form `parseCellPath` produces
 * for a positional path argument, so an embedded path and a positional path
 * address the same cells. Not `parseCellPath` itself, because that splits on
 * `/` and a JSON-pointer segment may contain one.
 */
function toCellPathSegment(segment: string): string | number {
  if (segment === "") return segment;
  const num = Number(segment);
  return Number.isInteger(num) && num >= 0 ? num : segment;
}

/**
 * Normalize an LLM-friendly piece reference — `/of:fid1:abc.../path`,
 * optionally with a `/@did:.../` space prefix or an `@scope` suffix on the
 * id — into the piece id, scope, and path the CLI's own intake uses.
 *
 * Returns `undefined` when `ref` is not in the LLM-friendly form at all, so
 * a caller can fall through to its existing handling. The grammar itself is
 * the runner's (`parseLLMFriendlyLink`); a reference that matches the form
 * but fails to parse is a usage error, as is an embedded space DID that
 * differs from the space the command targets.
 */
export function normalizeLLMFriendlyRef(
  ref: string,
  options: { space?: string } = {},
): NormalizedLLMFriendlyRef | undefined {
  if (!matchLLMFriendlyLink.test(ref.trim())) return undefined;

  let parsed;
  try {
    parsed = parseLLMFriendlyLink(ref);
  } catch (error) {
    throw new ValidationError(
      error instanceof Error ? error.message : String(error),
      { exitCode: 1 },
    );
  }

  // The parser throws rather than return a link without an id; the guard
  // narrows the optional field on its return type.
  if (parsed.id === undefined) {
    throw new ValidationError(
      'Target must include a piece handle, e.g. "/of:fid1:abc123/path".',
      { exitCode: 1 },
    );
  }

  if (parsed.space && options.space && parsed.space !== options.space) {
    throw new ValidationError(
      `Reference names space "${parsed.space}" but the command targets ` +
        `space "${options.space}".`,
      { exitCode: 1 },
    );
  }

  return {
    pieceId: parsed.id,
    ...(parsed.scope && { scope: parsed.scope as CellScope }),
    path: parsed.path.map(toCellPathSegment),
  };
}
