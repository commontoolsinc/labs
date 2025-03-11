import { Identity } from "@commontools/identity";
export const EVERYONE_KEY = "common user";

export const open = async (
  { passphrase = EVERYONE_KEY, name = "" } = {},
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
