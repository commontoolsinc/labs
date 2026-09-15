// Turning a DID into something a person can read in a terminal or a table.

import { parseDID } from "@commonfabric/identity/did";

/**
 * The method-specific identifier of a DID — what `did:key:` or `did:web:`
 * introduces. A string that is not a DID comes back whole, which is what the
 * display paths want: they are handed principals, space ids and entity ids
 * alike, and only some of those are DIDs.
 */
export function didTail(did: string): string {
  return parseDID(did)?.id ?? did;
}

/**
 * A DID as a short label: its method-specific identifier, keeping `head`
 * characters and `tail` characters and eliding the middle once dropping the
 * middle would actually save room.
 */
export function shortDid(did: string, head = 6, tail = 4): string {
  const id = didTail(did);
  return id.length > head + tail + 2
    ? `${id.slice(0, head)}…${id.slice(-tail)}`
    : id;
}
