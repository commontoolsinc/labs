/**
 * Turning a handle the run holds into the value it stands for, trusted-side
 * and at the point of use.
 *
 * A tool field that takes a value has a sibling that takes a handle instead.
 * The model writes the handle token; the prompt loop's inbound swap rewrites
 * it into the canonical LLM-friendly link string before the tool runs, so
 * what arrives here is normally an address. Either spelling is accepted, and
 * neither the value nor anything derived from it appears in a message this
 * returns.
 *
 * Accepting either spelling is why the reference is checked against the run's
 * handle table rather than read on sight. The inbound swap has already turned
 * tokens into addresses by the time a tool runs, so a tool cannot tell an
 * address that arrived that way from one the model wrote out itself — guessed,
 * or read off a page. Membership in the table is what separates them: a handle
 * this run was given has an entry, an address the model composed does not, and
 * only the first resolves. Without that check a handle field is a general read
 * of every cell in the run's space.
 *
 * The caller is responsible for the other half of the contract: recording the
 * resolved value in the run's
 * {@link ../contracts/resolved-value-register.ts | resolved-value register}
 * before using it, so that the value cannot travel back to the model through
 * the tool's own output.
 */
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";

import {
  handleRefAddressKey,
  resolveHandleRef,
  resolveHandleToken,
} from "../handle-table.ts";
import { ADDRESS_HANDLE_TOKEN_PREFIX } from "../contracts/handle-table.ts";
import type { HarnessToolContext } from "./types.ts";

export type HandleValueResolution =
  | { value: string; error?: undefined }
  | { value?: undefined; error: string };

/** The part of the tool context a handle resolution reads. */
export type HandleValueResolutionContext = Pick<
  HarnessToolContext,
  "getFabricSession" | "handleTable"
>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The origin of `url` when it is an http(s) URL, and `undefined` otherwise.
 * Origin is the whole of what a destination check compares and the whole of
 * what a refusal about one may name: it says where a value would go without
 * carrying the path, query, or fragment a caller chose.
 */
export const httpOriginOf = (url: string): string | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  return parsed.origin;
};

/**
 * The string value behind `handle`, or an explanation of why the run cannot
 * read one. `label` names the field being resolved — "browser valueHandle",
 * say — and opens every message, so a refusal says which position failed.
 *
 * Every failure is stated in terms of the reference, never the referent: a
 * value that is absent, of the wrong type, or in another space is reported as
 * such without any part of it being rendered. Only a `string` resolves; a
 * number or an object is refused rather than stringified, because a coerced
 * rendering is the value by another name.
 */
export const resolveHandleValue = async (
  context: HandleValueResolutionContext,
  handle: string,
  label: string,
): Promise<HandleValueResolution> => {
  const trimmed = handle.trim();
  if (trimmed === "") {
    return { error: `${label} requires a handle naming a value` };
  }
  if (context.getFabricSession === undefined) {
    return {
      error:
        `${label} requires a fabric session to resolve a handle, and this run has none`,
    };
  }
  const isToken = trimmed.startsWith(ADDRESS_HANDLE_TOKEN_PREFIX);
  if (!isToken && handleRefAddressKey(trimmed) === undefined) {
    return { error: `${label} does not name a reference this run holds` };
  }
  // Both spellings go through the table, and for the same reason: what
  // reaches a tool is an address either way, so holding the handle is the
  // only thing that distinguishes a delegated reference from a composed one.
  const entry = context.handleTable === undefined
    ? undefined
    : (isToken
      ? resolveHandleToken(context.handleTable, trimmed)
      : resolveHandleRef(context.handleTable, trimmed));
  if (entry === undefined) {
    return { error: `${label} does not name a handle this run holds` };
  }
  const ref = entry.ref;
  let pieces;
  try {
    pieces = (await context.getFabricSession()).pieces;
  } catch (error) {
    return {
      error: `${label} could not establish the fabric session: ${
        errorMessage(error)
      }`,
    };
  }
  const space = pieces.getSpace();
  let link;
  try {
    link = parseLLMFriendlyLink(ref.startsWith("/") ? ref : `/${ref}`, space);
  } catch {
    return { error: `${label} does not name a reference this run holds` };
  }
  if (link.space !== space) {
    return {
      error: `${label} can only read a reference in this run's own space`,
    };
  }
  let cell;
  try {
    cell = pieces.runtime.getCellFromLink({ ...link, schema: undefined });
  } catch (error) {
    return {
      error: `${label} does not name a readable reference: ${
        errorMessage(error)
      }`,
    };
  }
  try {
    await cell.sync();
  } catch (error) {
    return {
      error: `${label} could not load the referenced value: ${
        errorMessage(error)
      }`,
    };
  }
  const value = cell.get();
  if (value === undefined) {
    return { error: `${label} names an address that holds nothing` };
  }
  if (typeof value !== "string") {
    return {
      error:
        `${label} must name a string value; the reference holds a value of type ${typeof value}`,
    };
  }
  return { value };
};
