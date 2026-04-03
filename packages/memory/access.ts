import {
  ACL,
  AsyncResult,
  Authorization,
  AuthorizationError,
  Invocation,
  Proof,
  Signer,
} from "./interface.ts";
import { type HashObject, hashOf } from "@commonfabric/data-model/value-hash";
import { unauthorized } from "./error.ts";
import { type DID } from "@commonfabric/identity";
import { fromDID } from "./util.ts";
import { checkACL } from "./acl.ts";

/**
 * Claims access via provide authorization. Function either returns ok with
 * claimed access back or an error if authorization is invalid.
 *
 * Authorization is granted if:
 * 1. The issuer is the space owner (subject === issuer)
 * 2. The issuer is the service DID
 * 3. The issuer has appropriate capability in the space ACL
 */
export const claim = async <Access extends Invocation>(
  access: Access,
  authorization: Authorization<Invocation>,
  serviceDid: DID,
  acl?: ACL,
): AsyncResult<Access, AuthorizationError> => {
  const claim = hashOf(access).toString();
  if (authorization.access[claim]) {
    const { ok: issuer, error } = await fromDID(access.iss);
    if (error) {
      return {
        error: unauthorized(`Could not create issuer key`, error),
      };
    }
    const result = await issuer.verify({
      payload: hashOf(authorization.access).bytes,
      signature: authorization.signature,
    });

    if (result.error) {
      return result;
    } else {
      // Verify the issuer is authorized for this subject space
      const { ok: subject, error } = await fromDID(access.sub);
      if (error) {
        return {
          error: unauthorized(
            `Expected valid did:key identifier instead got "${access.sub}"`,
          ),
        };
      }

      // Space owner or service DID
      if (
        subject.did() === issuer.did() ||
        issuer.did() === serviceDid
      ) {
        return { ok: access };
      }

      // ACL-based authorization
      if (acl) {
        if (checkACL(acl, issuer.did(), access.cmd)) {
          return { ok: access };
        }
        // fallthrough
      }

      return {
        error: unauthorized(
          `Principal ${issuer.did()} has no authority over ${subject.did()} space`,
        ),
      };
    }
  } else {
    const availableKeys = Object.keys(authorization.access);
    const details = [
      `Authorization does not include claimed access.`,
      `  Expected claim hash: ${claim}`,
      `  Available keys (${availableKeys.length}): ${
        availableKeys.length > 0 ? availableKeys.join(", ") : "(none)"
      }`,
    ];
    // Detect legacy-vs-canonical hash format mismatch
    const claimIsCanonical = claim.includes(":");
    const keysAreCanonical = availableKeys.some((k) => k.includes(":"));
    if (claimIsCanonical !== keysAreCanonical && availableKeys.length > 0) {
      details.push(
        `  ⚠ Hash format mismatch: server computed ${
          claimIsCanonical ? "canonical" : "legacy"
        } hash but client sent ${
          keysAreCanonical ? "canonical" : "legacy"
        } hashes.`,
        `  This usually means the client and server have different EXPERIMENTAL_MODERN_HASH settings.`,
      );
    }
    console.error(`[access] ${details.join("\n")}`);
    return {
      error: unauthorized(details.join("\n")),
    };
  }
};

/**
 * Issues verifiable authorization signed by the given signer.
 */
export const authorize = async <Access extends HashObject[]>(
  access: Access,
  as: Signer,
): AsyncResult<Authorization<Access[number]>, Error> => {
  const proof = {} as Proof<Access[number]>;
  for (const invocation of access) {
    proof[invocation.toString()] = {};
  }

  const { ok: signature, error } = await as.sign<Access[number]>(
    hashOf(proof).bytes,
  );
  if (error) {
    return { error };
  } else {
    return { ok: { signature, access: proof } };
  }
};
