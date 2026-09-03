import { Identity } from "./identity.ts";
import { type DID } from "./interface.ts";

export type Session = {
  spaceName?: string;
  spaceIdentity?: Identity;
  space: DID;
  as: Identity;
};

export type SessionCreateOptions = {
  identity: Identity;
  spaceName: string;
} | {
  identity: Identity;
  spaceDid: DID;
};

/**
 * The passphrase the named-space key tree is rooted at. A named space's key
 * hangs off this root under the name, so the name alone decides its DID.
 */
const SPACE_ROOT_PASSPHRASE = "common user";

/**
 * The identity a space called `spaceName` is keyed by, derived from the name
 * and nothing else. It takes no account and no session, so a caller holding
 * only a name can reach the space that name denotes — which is what
 * {@link createSession} does with it, and what a caller asking whether a name
 * denotes a space it already has open does with it too.
 */
export const spaceIdentityForName = async (
  spaceName: string,
): Promise<Identity> =>
  await (await Identity.fromPassphrase(SPACE_ROOT_PASSPHRASE)).derive(
    spaceName,
  );

/**
 * Creates a session over the space `options` names, either by its DID or by a
 * name the space's key is reproducibly derived from.
 */
export const createSession = async (
  options: SessionCreateOptions,
): Promise<Session> => {
  if ("spaceName" in options) {
    const spaceIdentity = await spaceIdentityForName(options.spaceName);
    return {
      spaceName: options.spaceName,
      spaceIdentity,
      space: spaceIdentity.did(),
      as: options.identity,
    };
  }
  return {
    as: options.identity,
    space: options.spaceDid,
  };
};
