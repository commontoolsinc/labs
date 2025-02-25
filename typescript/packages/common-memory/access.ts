import {
  Authorization,
  Invocation,
  AsyncResult,
  AuthorizationError,
  Signer,
  Proof,
  Reference,
} from "./interface.ts";
import { refer } from "merkle-reference";
import { unauthorized } from "./error.ts";
import * as Principal from "./principal.ts";

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
        return { ok: access };
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

  const { ok: signature, error } = await as.sign<Access[number]>(refer(proof).bytes);
  if (error) {
    return { error };
  } else {
    return { ok: { signature, access: proof } };
  }
};
