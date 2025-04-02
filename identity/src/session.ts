import { Identity } from "./identity.ts";
import { type DID } from "./interface.ts";
export const ANYONE = "common user";

export type Session = {
  private: boolean;
  name: string;
  space: DID;
  as: Identity;
};

// Create a session where `Identity` is used directly and not derived.
export const createAdminSession = async (
  { identity, space, name }: {
    identity: Identity;
    space: DID;
    name: string;
  },
) =>
  await ({
    private: name.startsWith("~"),
    name,
    space,
    as: identity,
  });

// Create a session where `Identity` is used to derive a space key.
export const createSession = async (
  { identity, name }: { identity: Identity; name: string },
) => {
  const space = await identity.derive(name);

  return {
    private: name.startsWith("~"),
    name,
    space: space.did(),
    as: space,
  };
};
