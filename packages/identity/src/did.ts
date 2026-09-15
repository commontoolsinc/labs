/**
 * The DID vocabulary the whole repository shares: the types, the one test that
 * decides whether a string is a DID, the one way to take a DID apart, and the
 * guard for a value that must not be one.
 *
 * A string is a DID when it starts with `did:`, compared exactly. `DID:key:z…`,
 * ` did:key:z…` and `xdid:key:z…` are not DIDs. Nothing else about the string
 * is consulted: the number of colons, the method name, and the
 * method-specific identifier are all free. A caller that needs a narrower
 * answer — a `did:key` in particular, or a space DID of a particular shape —
 * asks that question on top of these, and says so where it asks.
 *
 * One rule in one place is what keeps the same string from meaning different
 * things depending on the route it took to get somewhere. Several surfaces
 * accept either a space DID or a space name, so a name that passed for a DID
 * on one route and a name on another would address two different spaces.
 *
 * This module imports nothing, and `@commonfabric/identity/did` reaches it
 * without loading any key material.
 */

/** The prefix that makes a string a DID. */
export const DID_PREFIX = "did:";

/** The prefix of a DID whose method is `key`. */
export const DID_KEY_PREFIX = "did:key:";

/** Any decentralized identifier. */
export type DID = `did:${string}`;

/** A decentralized identifier whose method is `key`. */
export type DIDKey = `did:key:${string}`;

/** Whether `input` is a DID: a string carrying the exact prefix `did:`. */
export function isDID(input: unknown): input is DID {
  return typeof input === "string" && input.startsWith(DID_PREFIX);
}

/** Whether `input` is a DID whose method is `key`. */
export function isDIDKey(input: unknown): input is DIDKey {
  return typeof input === "string" && input.startsWith(DID_KEY_PREFIX);
}

/** A DID split into the parts that follow its prefix. */
export interface ParsedDID {
  /** The whole DID, as it was given. */
  did: DID;
  /**
   * The method name: the text between the `did:` prefix and the next colon,
   * or the whole remainder when no colon follows the prefix.
   */
  method: string;
  /**
   * The method-specific identifier: the text after the method's colon, and the
   * empty string when no colon follows the method.
   */
  id: string;
}

/**
 * Splits `input` into its method and its method-specific identifier, or
 * returns `undefined` when `input` is not a DID.
 */
export function parseDID(input: unknown): ParsedDID | undefined {
  if (!isDID(input)) return undefined;
  const rest = input.slice(DID_PREFIX.length);
  const colon = rest.indexOf(":");
  return colon === -1
    ? { did: input, method: rest, id: "" }
    : { did: input, method: rest.slice(0, colon), id: rest.slice(colon + 1) };
}

/**
 * Throws when `value` is a DID. `role` names what the value is for and opens
 * the message, so pass a noun phrase: `assertNotDID(name, "A space name")`.
 */
export function assertNotDID(value: string, role: string): void {
  if (isDID(value)) {
    throw new Error(
      `${role} must not be a DID. ${JSON.stringify(value)} starts with ` +
        `"${DID_PREFIX}", and DIDs are not accepted here.`,
    );
  }
}
