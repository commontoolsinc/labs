import { Identity } from "./identity.ts";
import { type DID } from "./interface.ts";
export const ANYONE = "common user";

export type Session = {
  private: boolean;
  name: string;
  space: DID;
  as: Identity;
};

export const open = async (
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

export const create = async (
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
