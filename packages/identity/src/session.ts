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

// Create a session with DID and identity provided, or where
// a key is reproducibly derived via the provided space name.
export const createSession = async (
  options: SessionCreateOptions,
): Promise<Session> => {
  if ("spaceName" in options) {
    const spaceIdentity = await (await Identity.fromPassphrase("common user"))
      .derive(
        options.spaceName,
      );
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
