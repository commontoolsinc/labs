import { Authorization, Invocation, AsyncResult, AuthorizationError } from "./interface.ts";
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
  const [proof, granted] = authorization;
  if (!granted[refer(access).toString()]) {
    const { ok: issuer, error } = Principal.fromDID(access.iss);
    if (error) {
      return { error: unauthorized(`Invalid issuer ${access.iss}`, error) };
    } else {
      const result = await issuer.verify(refer(access).bytes, proof);
      if (result.error) {
        return result;
      } else {
        return { ok: access };
      }
    }
  } else {
    return {
      error: unauthorized(`Provided authorization does not provide claimed access`),
    };
  }
};
