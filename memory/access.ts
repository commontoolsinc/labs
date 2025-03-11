import {
  AsyncResult,
  Authorization,
  AuthorizationError,
  Invocation,
  Proof,
  Reference,
  Signer,
} from "./interface.ts";
import { refer } from "merkle-reference";
import { unauthorized } from "./error.ts";
import * as Principal from "./principal.ts";

// Derived from passphrase "implicit trust"
const SERVICE_DID = "did:key:z6MksHnZGdHxNoCqcC3kPvBSo2goCzLSWheQ8LrVpAtQwgwW";

/**
 * Claims access via provide authorization. Function either returns ok with
 * claimed access back or an error if authorization is invalid.
 */
export const claim = async <Access extends Invocation>(
  access: Access,
  authorization: Authorization<Invocation>,
): AsyncResult<Access, AuthorizationError> => {
  const claim = refer(access).toString();
  if (authorization.access[claim]) {
    const { ok: issuer, error } = Principal.fromDID(access.iss);
    if (error) {
      return { error: unauthorized(`Invalid issuer ${access.iss}`, error) };
    } else {
      const result = await issuer.verify({
        payload: refer(authorization.access).bytes,
        signature: authorization.signature,
      });

      if (result.error) {
        return result;
      } else {
        // Right now we enforce issuer to be authorized by a subject only if
        // subject space is a DID identifier. Furthermore we assume that the
        // subject and issuer are the same DID. In the future we will add UCANs
        // to allow delegations.
        const { ok: subject } = Principal.fromDID(access.sub);
        if (
          !subject || subject.did() === issuer.did() ||
          // At the moment allow invocations from SERVICE_DID
          issuer.did() === SERVICE_DID
        ) {
          return { ok: access };
        } else {
          return {
            error: unauthorized(
              `Principal ${issuer.did()} has no authority over ${subject.did()} space`,
            ),
          };
        }
      }
    }
  } else {
    return {
      error: unauthorized(`Authorization does not include claimed access`),
    };
  }
};

/**
 * Issues verifiable authorization signed by the given signer.
 */
export const authorize = async <Access extends Reference[]>(
  access: Access,
  as: Signer,
): AsyncResult<Authorization<Access[number]>, Error> => {
  const proof = {} as Proof<Access[number]>;
  for (const invocation of access) {
    proof[invocation.toString()] = {};
  }

  const { ok: signature, error } = await as.sign<Access[number]>(
    refer(proof).bytes,
  );
  if (error) {
    return { error };
  } else {
    return { ok: { signature, access: proof } };
  }
};
