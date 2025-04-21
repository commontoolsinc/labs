import * as Path from "@std/path";
import { AsyncResult, DID, DIDKey } from "./interface.ts";
import { VerifierIdentity } from "@commontools/identity";

/**
 * Returns file URL for the current working directory.
 */
export const baseURL = () => asDirectory(Path.toFileUrl(Deno.cwd()));

export const createTemporaryDirectory = async () =>
  asDirectory(Path.toFileUrl(await Deno.makeTempDir()));

export const asDirectory = (
  url: URL,
) => (url.href.endsWith("/") ? url : new URL(`${url.href}/`));

const DID_PREFIX = "did:";
const DID_KEY_PREFIX = `did:key:`;

/**
 * Parses a DID string into an Identity
 */
export const fromDID = async <ID extends DIDKey>(
  id: ID | DID | string,
): AsyncResult<VerifierIdentity<ID>, SyntaxError> => {
  if (!id.startsWith(DID_PREFIX)) {
    return {
      error: new SyntaxError(`Invalid DID "${id}", must start with "did:"`),
    };
  } else if (!id.startsWith(DID_KEY_PREFIX)) {
    return {
      error: new SyntaxError(
        `Invalid DID "${id}", only "did:key:" are supported right now`,
      ),
    };
  } else {
    try {
      return { ok: await VerifierIdentity.fromDid(id as ID) };
    } catch (e) {
      return { error: new SyntaxError(`Invalid DID "${id}", ${e}`) };
    }
  }
};

export function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}
