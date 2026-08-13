import { ValidationError } from "@cliffy/command";
import type { CellScope } from "@commonfabric/api";
import { isDID } from "@commonfabric/identity";
import {
  matchLLMFriendlyLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner";

/** A piece reference normalized from its LLM-friendly link form. */
export interface NormalizedLLMFriendlyRef {
  pieceId: string;
  scope?: CellScope;
  /**
   * The space DID embedded in the reference, when the command's target
   * space is a name (or absent) rather than a DID. A name only resolves to
   * a DID once a session opens, so the comparison is deferred: carry this
   * to `validateEmbeddedSpaces` with the session's resolved space DID. A
   * DID-configured target space is compared at parse time instead and
   * never sets this field.
   */
  embeddedSpace?: string;
  /**
   * Path segments embedded in the reference: a canonical array-index
   * segment is a number, everything else stays a string.
   */
  path: (string | number)[];
}

function spaceMismatchError(
  embedded: string,
  target: string,
): ValidationError {
  return new ValidationError(
    `Reference names space "${embedded}" but the command targets ` +
      `space "${target}".`,
    { exitCode: 1 },
  );
}

/**
 * The deferred counterpart of `normalizeLLMFriendlyRef`'s parse-time
 * embedded-space check: compare the space DIDs embedded in a command's
 * references against the space DID its session actually resolved to.
 * Call it once the session exists; `resolvedSpace` is that DID.
 */
export function validateEmbeddedSpaces(
  embeddedSpaces: readonly string[] | undefined,
  resolvedSpace: string,
): void {
  for (const embedded of embeddedSpaces ?? []) {
    if (embedded !== resolvedSpace) {
      throw spaceMismatchError(embedded, resolvedSpace);
    }
  }
}

/**
 * A canonical array-index token: `0`, or digits without a leading zero.
 * Only these convert to numbers; a non-canonical numeric-looking token
 * such as `01`, `007`, `1.5`, or `-2` names a string property, and
 * converting it would address a different cell than the pointer names.
 */
const canonicalArrayIndex = /^(0|[1-9][0-9]*)$/;

/**
 * The largest valid JS array index, 2^32 - 2. A canonical token above it
 * cannot name an array element, and past `Number.MAX_SAFE_INTEGER` the
 * conversion itself is lossy — `Number("9007199254740993")` rounds to a
 * neighboring integer and would address a different cell — so larger
 * tokens stay strings.
 */
const MAX_ARRAY_INDEX = 4294967294;

/**
 * Convert a decoded link path segment to the number-or-string form the
 * CLI's cell traversal uses, so an embedded path and a positional path
 * address the same cells. Not the runner's `parseCellPath`, because that
 * splits on `/` (a JSON-pointer segment may contain one) and coerces any
 * numeric-looking token — including non-canonical ones like `01` — to a
 * number; here only canonical array-index tokens convert, deliberately.
 */
function toCellPathSegment(segment: string): string | number {
  if (!canonicalArrayIndex.test(segment)) return segment;
  const num = Number(segment);
  return num <= MAX_ARRAY_INDEX ? num : segment;
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
 * differs from a DID-configured target space. When `options.space` is a
 * name (or absent), the embedded DID comes back as `embeddedSpace` for the
 * caller to validate through `validateEmbeddedSpaces` once the session has
 * resolved the name.
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

  let embeddedSpace: string | undefined;
  if (parsed.space) {
    if (options.space !== undefined && isDID(options.space)) {
      if (parsed.space !== options.space) {
        throw spaceMismatchError(parsed.space, options.space);
      }
    } else {
      embeddedSpace = parsed.space;
    }
  }

  return {
    pieceId: parsed.id,
    ...(parsed.scope && { scope: parsed.scope as CellScope }),
    ...(embeddedSpace !== undefined && { embeddedSpace }),
    path: parsed.path.map(toCellPathSegment),
  };
}
