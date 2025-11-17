import { Identity } from "./identity.ts";
import { type DID } from "./interface.ts";

export type Session = {
  spaceName: string;
  spaceIdentity?: Identity;
  space: DID;
  as: Identity;
};

// Create a session where `Identity` is used directly and not derived.
export const createSessionFromDid = (
  { identity, space, spaceName }: {
    identity: Identity;
    space: DID;
    spaceName: string;
  },
): Promise<Session> => {
  return Promise.resolve({
    spaceName,
    space,
    as: identity,
  });
};

// Create a session where `Identity` is used to derive a space key.
export const createSession = async (
  { identity, spaceName }: { identity: Identity; spaceName: string },
): Promise<Session> => {
  const spaceIdentity = await (await Identity.fromPassphrase("common user"))
    .derive(
      spaceName,
    );
  return {
    spaceName,
    spaceIdentity,
    space: spaceIdentity.did(),
    as: identity,
  };
};
