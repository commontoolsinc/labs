import { AsyncResult, DID, DIDKey } from "./interface.ts";
import { VerifierIdentity } from "@commonfabric/identity";

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
