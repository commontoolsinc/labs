import { DID, Identity } from "@commontools/identity";
export const ANYONE = "common user";

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
