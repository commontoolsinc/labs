import { Identity } from "./identity.ts";
import { assertNotDID, type DID } from "./did.ts";

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
//
// The two forms address different spaces from the same string, so a name that
// is also a DID would name one space here and another wherever the DID form is
// taken. Every caller that accepts "a DID or a name" splits on `isDID`, and
// this refuses the name form for a DID so the split cannot be skipped.
export const createSession = async (
  options: SessionCreateOptions,
): Promise<Session> => {
  if ("spaceName" in options) {
    assertNotDID(options.spaceName, "A space name");
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
