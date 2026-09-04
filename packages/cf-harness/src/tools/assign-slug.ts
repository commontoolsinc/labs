import { getPatternIdentityRef, validateSlug } from "@commonfabric/runner";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";
import {
  assignSlug,
  pieceId,
  resolvePieceAddress,
  SlugResolutionError,
} from "@commonfabric/piece";
import type { PiecesController } from "@commonfabric/piece/ops";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface AssignSlugToolInput {
  token?: string;
  slug?: string;
}

export interface AssignSlugToolSuccessOutput {
  outputId: string;
  status: "ok";

  /** The assigned slug, the caller's own word echoed back. */
  slug: string;

  /**
   * Absolute URL for the named piece, composed from the session's API URL
   * and the space's configured name. Absent when the session was configured
   * by `did:key` rather than by name: the only URL available then would
   * carry the space DID, a bare fabric identifier that does not cross the
   * model boundary, so no URL is offered rather than a fabricated one.
   */
  url?: string;
}

export interface AssignSlugToolErrorOutput {
  outputId: string;
  status: "error";
  message: string;
}

export type AssignSlugToolOutput =
  | AssignSlugToolSuccessOutput
  | AssignSlugToolErrorOutput;

/**
 * Names a piece the caller holds a handle to: registers it in the space's
 * piece list and points `slug` — the named address a person opens — at it.
 * Naming is separate from creation on purpose: `run_pattern` always returns
 * a plain handle, and whether a piece deserves a public name is a decision
 * the caller can make later, about any piece it can reference, and revise by
 * naming a replacement under a fresh slug. Nothing is disclosed in the
 * process — the slug is the caller's own word, the address behind the token
 * stays trusted-side, and no value is read.
 *
 * A slug rather than a free-text name because the slug is the only handle
 * the tool can set: what the piece list displays is the pattern's own `NAME`
 * result, which the pattern source carries and nothing outside it writes.
 */
export const assignSlugToolDescriptor: HarnessToolDescriptor = {
  toolId: "assign_slug",
  title: "Assign Slug",
  description:
    "Register the piece behind a handle token in the space's piece list and give it a named address a person can open. Use it after run_pattern when a piece deserves a name; a piece never named stays out of the list, which is what pure computation wants. A slug already naming another piece, or a collection, is refused rather than repointed.",
  effectClass: "side-effect",
  inputSchema: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description:
          "A handle token of the form cfh:a:<suffix> referring to a piece — a run_pattern resultRef, or any granted or discovered piece reference.",
      },
      slug: {
        type: "string",
        description:
          "Named address for the piece: lowercase letters, numbers, and single hyphens between words, at most 80 characters.",
      },
    },
    required: ["token", "slug"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      outputId: { type: "string" },
      status: { enum: ["ok", "error"] },
      slug: { type: "string" },
      url: { type: "string" },
      message: { type: "string" },
    },
    required: ["outputId", "status"],
    additionalProperties: false,
  },
  tags: ["fabric", "piece"],
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * What each `SlugResolutionError` code says about the name.
 *
 * `free` is a positive statement about what the space holds, arrived at by
 * reading it: the slug's document is absent, holds no usable redirect, or
 * redirects to something that is not a piece, and a name only ever competes
 * with a piece. `in-use` is equally positive the other way — the name
 * resolves to a collection, which is a thing a person opens, so assigning
 * over it would take the address away from whoever holds it.
 *
 * `unknown` is a failure to establish anything: a storage error, a sync that
 * never landed, a lost connection. `invalid` sits there too — the slug was
 * validated before this is asked, so a resolver calling it unusable means the
 * two disagree about the rule rather than that the space is empty.
 *
 * The map is total over the code union, so a code added to the resolver does
 * not compile until it is classified here. Totality is the point: only
 * `inside-piece` can reach this from an address with no path, and
 * `missing-member` is classified because it belongs to the same answer, not
 * because it arrives.
 */
const SLUG_CODE_STATES: Readonly<
  Record<
    NonNullable<SlugResolutionError["code"]>,
    "free" | "in-use" | "unknown"
  >
> = {
  invalid: "unknown",
  missing: "free",
  malformed: "free",
  "not-piece": "free",
  "missing-piece-id": "free",
  "inside-piece": "in-use",
  "missing-member": "in-use",
};

/**
 * Whether `slug` already names a piece in the session's space — and which —
 * whether it names something else a person opens, or whether that could not
 * be established at all.
 *
 * Assignment is a blind write: the slug document is pointed at the piece
 * whatever it held before, and last writer wins. So without asking first, a
 * request naming a slug a person already opens would repoint that name at
 * whatever the caller passed. That makes an unanswered question a refusal
 * rather than a "free": a resolution that failed operationally says nothing
 * about what the slug holds, and treating it as vacancy would reopen exactly
 * the overwrite this asks to prevent.
 *
 * The outcomes are told apart by the typed `code` `resolvePieceAddress`
 * carries on its `SlugResolutionError`, never by the message text.
 */
const slugAvailability = async (
  pieces: PiecesController,
  slug: string,
): Promise<
  | { state: "free" }
  | { state: "taken"; pieceId: string }
  | { state: "in-use"; reason: string }
  | { state: "unknown"; reason: string }
> => {
  try {
    const holder = await resolvePieceAddress(pieces, slug);
    return { state: "taken", pieceId: holder };
  } catch (error) {
    const state = error instanceof SlugResolutionError &&
        error.code !== undefined
      ? SLUG_CODE_STATES[error.code]
      : "unknown";
    if (state === "free") return { state };
    return { state, reason: errorMessage(error) };
  }
};

/**
 * The URL a person opens for a named piece, or `undefined` when none can be
 * composed without inventing one. The address is the session's API URL, then
 * the space, then the slug — the same shape `cf piece new` prints. Only a
 * space configured by NAME yields one: a space configured by `did:key` would
 * put a bare fabric identifier in the URL, and that does not cross the model
 * boundary.
 */
export const namedPieceUrl = (
  pieces: PiecesController,
  slug: string,
): string | undefined => {
  const spaceName = pieces.getSpaceName();
  if (spaceName === undefined) {
    return undefined;
  }
  try {
    const url = new URL(pieces.runtime.apiUrl);
    const base = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    url.pathname = `${base}${encodeURIComponent(spaceName)}/${slug}`;
    return url.toString();
  } catch {
    return undefined;
  }
};

/**
 * Puts `cell` in the space's piece list unless the list already holds it.
 * Establishes the space root first because the registry belongs to it. The
 * registry's addPiece handler appends unconditionally, so membership is asked
 * first — by piece id over the registered list — rather than by re-adding and
 * hoping.
 */
const ensureRegistered = async (
  pieces: PiecesController,
  cell: Parameters<PiecesController["add"]>[0][number],
  targetId: string,
): Promise<void> => {
  await pieces.ensureDefaultPattern();
  const registered = await pieces.getRegisteredPieces();
  if (registered.some((piece) => piece.id === targetId)) {
    return;
  }
  await pieces.add([cell]);
};

export const assignSlugTool: HarnessToolDefinition<
  AssignSlugToolInput,
  AssignSlugToolOutput
> = {
  descriptor: assignSlugToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("assign_slug");
    const errorOutput = (message: string): AssignSlugToolErrorOutput => ({
      outputId,
      status: "error",
      message,
    });
    if (context.getFabricSession === undefined) {
      return errorOutput(
        "assign_slug requires a fabric session; run without one cannot name pieces",
      );
    }
    const ref = typeof input.token === "string" ? input.token.trim() : "";
    if (ref.length === 0) {
      return errorOutput("assign_slug requires a token naming a piece");
    }
    if (typeof input.slug !== "string") {
      return errorOutput("assign_slug requires a string slug");
    }
    let slug: string;
    try {
      slug = validateSlug(input.slug);
    } catch (error) {
      return errorOutput(
        `assign_slug slug is invalid: ${errorMessage(error)}`,
      );
    }
    let pieces: PiecesController;
    try {
      pieces = (await context.getFabricSession()).pieces;
    } catch (error) {
      return errorOutput(
        `assign_slug could not establish the fabric session: ${
          errorMessage(error)
        }`,
      );
    }
    const space = pieces.getSpace();
    let link;
    try {
      link = parseLLMFriendlyLink(
        ref.startsWith("/") ? ref : `/${ref}`,
        space,
      );
    } catch {
      return errorOutput(
        "assign_slug token does not name a reference this run holds",
      );
    }
    if (link.space !== space) {
      return errorOutput(
        "assign_slug can only name a piece in this run's own space",
      );
    }
    if (link.path.length > 0) {
      return errorOutput(
        "assign_slug token must name a piece itself, not a position inside one",
      );
    }
    const cell = pieces.runtime.getCellFromLink({
      ...link,
      schema: undefined,
    });
    try {
      await cell.sync();
    } catch (error) {
      return errorOutput(
        `assign_slug could not load the referenced piece: ${
          errorMessage(error)
        }`,
      );
    }
    // The same discriminators the slug resolver applies to what a slug
    // redirects to: a document with no pattern identity, or no piece id, is
    // not a piece, and naming it would put a dead entry in the piece list.
    const targetId = pieceId(cell);
    if (getPatternIdentityRef(cell) === undefined || targetId === undefined) {
      return errorOutput(
        "assign_slug token does not refer to a piece; only a piece can be named",
      );
    }
    const availability = await slugAvailability(pieces, slug);
    if (availability.state === "taken") {
      if (availability.pieceId === targetId) {
        // The name already points where the caller is pointing it, so the
        // request is already true, and saying so beats refusing it. The
        // contract's other half still has to hold: a slug can point at a
        // piece the registry does not list — a pre-existing name, a naming
        // interrupted between its two steps — so membership is ensured
        // before answering, without duplicating an entry that is there.
        try {
          await ensureRegistered(pieces, cell, targetId);
        } catch (error) {
          return errorOutput(
            `assign_slug failed while listing the piece: ${
              errorMessage(error)
            }`,
          );
        }
        const url = namedPieceUrl(pieces, slug);
        return {
          outputId,
          status: "ok",
          slug,
          ...(url !== undefined ? { url } : {}),
        };
      }
      return errorOutput(
        `assign_slug slug "${slug}" already names another piece in this space, and assigning would repoint that address. Choose another slug.`,
      );
    }
    if (availability.state === "in-use") {
      return errorOutput(
        `assign_slug slug "${slug}" already names a collection in this space, and assigning would repoint that address. Choose another slug. The resolver reported: ${availability.reason}`,
      );
    }
    if (availability.state === "unknown") {
      return errorOutput(
        `assign_slug could not establish whether slug "${slug}" is available: ${availability.reason}. Nothing was assigned. Try the same call again.`,
      );
    }
    try {
      // The registry join goes first, so a failure between the two leaves a
      // listed-but-unnamed piece — visible and reachable by its handle —
      // rather than an orphan name pointing outside the list. Membership is
      // ensured rather than appended: a retry after exactly that failure
      // must not list the piece twice.
      await ensureRegistered(pieces, cell, targetId);
      await assignSlug(pieces, cell, slug);
    } catch (error) {
      return errorOutput(
        `assign_slug failed while naming the piece: ${errorMessage(error)}`,
      );
    }
    const url = namedPieceUrl(pieces, slug);
    return {
      outputId,
      status: "ok",
      slug,
      ...(url !== undefined ? { url } : {}),
    };
  },
};
