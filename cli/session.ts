import { Identity } from "@commontools/identity";
export const ANYONE = "common user";

const isPrivateSpace = (name: string) => name.startsWith("~");

export const open = async (
  { passphrase = ANYONE, name = "" } = {},
) => {
  // For private space we use account derived from provided passphrase
  // otherwise we use passphrase for public spaces
  const account = isPrivateSpace(name)
    ? await Identity.fromPassphrase(passphrase)
    : await Identity.fromPassphrase(ANYONE);

  // Derive space access identity from the given space name.
  const space = await account.derive(name);

  return {
    private: name.startsWith("~"),
    name,
    space: space.did(),
    as: space,
  };
};
