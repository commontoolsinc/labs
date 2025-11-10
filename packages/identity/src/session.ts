import { Identity } from "./identity.ts";
import { type DID } from "./interface.ts";
export const ANYONE = "common user";

export type Session = {
  isPrivate: boolean;
  spaceName: string;
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
  const isPrivate = spaceName.startsWith("~");
  return Promise.resolve({
    isPrivate,
    spaceName,
    space,
    as: identity,
  });
};

// Create a session where `Identity` is used to derive a space key.
export const createSession = async (
  { identity, spaceName }: { identity: Identity; spaceName: string },
): Promise<Session> => {
  const isPrivate = spaceName.startsWith("~");
  const account = isPrivate ? identity : await Identity.fromPassphrase(ANYONE);

  const user = await account.derive(spaceName);
  return {
    isPrivate,
    spaceName,
    space: user.did(),
    as: user,
  };
};
