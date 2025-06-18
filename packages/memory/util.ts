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

/**
 * A data structure that maps keys to sets of values, allowing multiple values
 * to be associated with a single key without duplication.
 *
 * @template K The type of keys in the map
 * @template V The type of values stored in the sets
 */
export class MapSet<K, V> {
  private map = new Map<K, Set<V>>();

  public get(key: K): Set<V> | undefined {
    return this.map.get(key);
  }

  public add(key: K, value: V) {
    if (!this.map.has(key)) {
      const values = new Set<V>([value]);
      this.map.set(key, values);
    } else {
      this.map.get(key)!.add(value);
    }
  }

  public has(key: K): boolean {
    return this.map.has(key);
  }
}
