/**
 * The LLM-friendly link form — `/[@did:.../]of:fid1:<id>[@scope][/path]`,
 * the runner's `parseLLMFriendlyLink` grammar — is the canonical reference
 * syntax of the fabric: the same string names the same cell in patterns, in
 * the shell, and at this CLI's intake seams. At those seams the reference
 * may additionally end in the `#argument` suffix, which selects the piece's
 * arguments cell the way `--input` does. The CLI's bare grammar
 * (`pieceId[@scope]`, `pieceId[@scope]/path` at link endpoints, and slugs)
 * is a convenience alias for interactive use. New reference-syntax
 * capabilities land in the canonical form first, and the alias must not
 * grow a capability the canonical form lacks.
 */

import { ValidationError } from "@cliffy/command";
import type { CellScope } from "@commonfabric/api";
import { isDID } from "@commonfabric/identity";
import {
  linkPathSegmentToCellPathSegment,
  matchLLMFriendlyLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner/shared";

/** A piece reference normalized from its LLM-friendly link form. */
export interface NormalizedLLMFriendlyRef {
  pieceId: string;
  scope?: CellScope;

  /**
   * True when the reference ended in the `#argument` suffix: the caller
   * selected the piece's arguments cell, the same selection `--input`
   * spells as a flag. Only commands that take `--input` accept it.
   */
  input?: boolean;

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
 *
 * The one addition to the runner's grammar is the trailing `#argument`
 * suffix, which comes back as `input`. `#` is reserved for it: a reference
 * carrying any other fragment is refused, so a path key containing `#` needs
 * the positional path spelling rather than the embedded one.
 */
export function normalizeLLMFriendlyRef(
  ref: string,
  options: { space?: string } = {},
): NormalizedLLMFriendlyRef | undefined {
  let trimmed = ref.trim();
  if (!matchLLMFriendlyLink.test(trimmed)) return undefined;

  let input = false;
  const hash = trimmed.indexOf("#");
  if (hash !== -1) {
    const suffix = trimmed.slice(hash);
    if (suffix !== "#argument") {
      throw new ValidationError(
        `Unknown reference suffix "${suffix}". The one supported suffix ` +
          `is "#argument", which selects the piece's arguments cell the ` +
          `way "--input" does.`,
        { exitCode: 1 },
      );
    }
    input = true;
    trimmed = trimmed.slice(0, hash);
  }

  let parsed;
  try {
    parsed = parseLLMFriendlyLink(trimmed);
  } catch (error) {
    throw new ValidationError(
      error instanceof Error ? error.message : String(error),
      { exitCode: 1 },
    );
  }

  // The parser throws rather than return a link without an id, so the
  // optional field on its return type is populated here.
  const pieceId = parsed.id!;

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
    pieceId,
    ...(parsed.scope && { scope: parsed.scope as CellScope }),
    ...(embeddedSpace !== undefined && { embeddedSpace }),
    ...(input && { input: true }),
    path: parsed.path.map(linkPathSegmentToCellPathSegment),
  };
}
