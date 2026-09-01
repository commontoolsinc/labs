/**
 * The reference form — `/[@space/]<piece>[@scope][/path]`, the runner's
 * `parseReferenceParts` grammar — is the canonical way to name a cell: the
 * same structure names the same cell in patterns, in the shell, and at this
 * CLI's intake seams.
 *
 * What a reader may write in the space and piece segments is where the
 * readings differ, and the difference is what each of them can resolve. A
 * pattern resolves a link from the string alone, so it requires the
 * self-identifying spellings — a space DID and a piece handle. This CLI opens
 * a session before it reads anything, so it resolves a space by name and a
 * piece by slug as well, and accepts both here. `did:key:...` and `fid1:...`
 * say what they are, so neither can be mistaken for a name and the wider
 * vocabulary costs the narrower one nothing.
 *
 * At these seams the reference may additionally end in the `#argument`
 * suffix, which selects the piece's arguments cell the way `--input` does.
 *
 * The CLI's bare grammar (`pieceId[@scope]`, `pieceId[@scope]/path` at link
 * endpoints, and slugs) is a convenience alias for interactive use. New
 * reference-syntax capabilities land in the canonical form first, and the
 * alias must not grow a capability the canonical form lacks.
 */

import { ValidationError } from "@cliffy/command";
import type { CellScope } from "@commonfabric/api";
import { isDID } from "@commonfabric/identity";
import {
  isPieceHandle,
  linkPathSegmentToCellPathSegment,
  parseReferenceParts,
} from "@commonfabric/runner/shared";
import { isSlugAddress, isValidSlug } from "@commonfabric/runner/slugs";

/** A piece reference normalized from its canonical reference form. */
export interface NormalizedLLMFriendlyRef {
  /** The piece, as the reference spelled it: a handle or a slug. */
  pieceId: string;
  scope?: CellScope;

  /**
   * True when the reference ended in the `#argument` suffix: the caller
   * selected the piece's arguments cell, the same selection `--input`
   * spells as a flag. Only commands that take `--input` accept it.
   */
  input?: boolean;

  /**
   * The space embedded in the reference, when it cannot be compared against
   * the command's target space yet. Two spaces written the same way — both
   * DIDs, or both names — are settled at parse time. Written differently,
   * only a resolved DID can compare them, so the reference's spelling is
   * carried here for `validateEmbeddedSpaces` to settle once a session
   * exists.
   */
  embeddedSpace?: string;

  /**
   * Path segments embedded in the reference: a canonical array-index
   * segment is a number, everything else stays a string.
   */
  path: (string | number)[];
}

/**
 * Whether a token is written as a reference rather than as a bare id, a slug,
 * or a cell path.
 *
 * A reference is rooted — it begins with `/` — and none of the others ever is,
 * which is what lets one positional hold either without a flag to say which.
 */
export function isReference(token: string): boolean {
  return token.trim().startsWith("/");
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
 * embedded-space check: compare the spaces embedded in a command's references
 * against the space its session actually resolved to. Call it once the session
 * exists; `resolvedSpace` is that DID, and `resolveName` derives the DID a
 * space name stands for, which is what an embedded name has to be held to.
 */
export async function validateEmbeddedSpaces(
  embeddedSpaces: readonly string[] | undefined,
  resolvedSpace: string,
  resolveName: (name: string) => Promise<string>,
): Promise<void> {
  for (const embedded of embeddedSpaces ?? []) {
    const embeddedDid = isDID(embedded)
      ? embedded
      : await resolveName(embedded);
    if (embeddedDid !== resolvedSpace) {
      throw spaceMismatchError(embedded, resolvedSpace);
    }
  }
}

/**
 * Whether a reference names its parts in the self-identifying spellings — a
 * handle and a DID — rather than in ones only a session resolves.
 *
 * A reference bound for a durable link has to. A link stores the id and the
 * space verbatim, so a slug or a space name written into one is an edge that
 * resolves to nothing: the name was never the identity, and nothing downstream
 * of the write is holding a session to look it up with. `cf`'s own intake
 * resolves both before it uses them, which is why it takes the wider
 * vocabulary; a value crossing into stored data has no such step and is held
 * to the narrower one.
 */
export function namesResolvedParts(ref: NormalizedLLMFriendlyRef): boolean {
  return isPieceHandle(ref.pieceId) &&
    (ref.embeddedSpace === undefined || isDID(ref.embeddedSpace));
}

/**
 * Hold the piece segment to one of the two vocabularies a reference admits.
 *
 * A colon is what separates them: a handle carries one (`of:fid1:...`) and a
 * slug may not, so the segment says which it is before either is checked. A
 * segment that is neither is reported as neither, rather than as a failure of
 * whichever check happened to run last.
 */
function validatePieceSegment(pieceId: string): void {
  if (isSlugAddress(pieceId)) {
    if (!isValidSlug(pieceId)) {
      throw new ValidationError(
        `"${pieceId}" is not a slug: a slug is lowercase letters, numbers, ` +
          `and single hyphens between words.`,
        { exitCode: 1 },
      );
    }
    return;
  }
  if (!isPieceHandle(pieceId)) {
    throw new ValidationError(
      `"${pieceId}" is neither a piece handle (of:fid1:...) nor a slug.`,
      { exitCode: 1 },
    );
  }
}

/**
 * Normalize a piece reference — `/of:fid1:abc.../path`, or `/tracker/path`,
 * optionally with a `/@space/` prefix or an `@scope` suffix on the piece —
 * into the piece, scope, and path the CLI's own intake uses.
 *
 * Returns `undefined` when `ref` is not written as a reference at all, so a
 * caller can fall through to its existing handling. The grammar itself is the
 * runner's (`parseReferenceParts`); a rooted string that fails to parse is a
 * usage error, as is a space that differs from the command's target space
 * where the two spellings can be compared without a session. When they cannot,
 * the reference's space comes back as `embeddedSpace` for the caller to settle
 * through `validateEmbeddedSpaces` once the session has resolved its own.
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
  if (!isReference(trimmed)) return undefined;

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
    parsed = parseReferenceParts(trimmed);
  } catch (error) {
    throw new ValidationError(
      error instanceof Error ? error.message : String(error),
      { exitCode: 1 },
    );
  }

  const pieceId = parsed.id;
  validatePieceSegment(pieceId);

  let embeddedSpace: string | undefined;
  if (parsed.space !== undefined) {
    // Two spellings of the same kind are the same string when they name the
    // same space, so the refusal lands at parse time with nothing loaded.
    // Across kinds only a derivation can compare them, and that needs the
    // session the target space is resolved by.
    if (
      options.space !== undefined &&
      isDID(parsed.space) === isDID(options.space)
    ) {
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
