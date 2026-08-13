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
   * Path segments embedded in the reference: a canonical array-index
   * segment is a number, everything else stays a string.
   */
  path: (string | number)[];
}

/**
 * A canonical array-index token: `0`, or digits without a leading zero.
 * Only these convert to numbers; a non-canonical numeric-looking token
 * such as `01`, `007`, `1.5`, or `-2` names a string property, and
 * converting it would address a different cell than the pointer names.
 */
const canonicalArrayIndex = /^(0|[1-9][0-9]*)$/;

/**
 * Convert a decoded link path segment to the number-or-string form the
 * CLI's cell traversal uses, so an embedded path and a positional path
 * address the same cells. Not the runner's `parseCellPath`, because that
 * splits on `/` (a JSON-pointer segment may contain one) and coerces any
 * numeric-looking token — including non-canonical ones like `01` — to a
 * number; here only canonical array indices convert, deliberately.
 */
function toCellPathSegment(segment: string): string | number {
  return canonicalArrayIndex.test(segment) ? Number(segment) : segment;
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
