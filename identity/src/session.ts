import { Identity } from "./identity.ts";
import { type DID } from "./interface.ts";
export const ANYONE = "common user";

export type Session = {
  private: boolean;
  name: string;
  space: DID;
  as: Identity;
};

export const openSessionFromPassphrase = async (
  { passphrase, space, name }: {
    passphrase: string;
    space: DID;
    name: string;
  },
) => ({
  private: name.startsWith("~"),
  name,
  space,
  as: await Identity.fromPassphrase(passphrase),
});

export const createSessionFromPassphrase = async (
  { passphrase, name }: { passphrase: string; name: string },
) => {
  const account = await Identity.fromPassphrase(passphrase);
  const space = await account.derive(name);

  return {
    private: name.startsWith("~"),
    name,
    space: space.did(),
    as: space,
  };
};

export const openSession = async (
  { identity, space, name }: {
    identity: Identity;
    space: DID;
    name: string;
  },
) => await ({
  private: name.startsWith("~"),
  name,
  space,
  as: identity,
});

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
