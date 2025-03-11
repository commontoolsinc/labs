import { DID, Identity } from "@commontools/identity";
export const ANYONE = "common user";

export const open = async (
  { passphrase, space, name }: { passphrase: string; space: DID; name: string },
) => ({
  private: name.startsWith("~"),
  name,
  space,
  as: await Identity.fromPassphrase(passphrase),
});
