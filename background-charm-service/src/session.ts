import { DID, Identity } from "@commontools/identity";
import { env } from "./config.ts";

export const ANYONE = "common user";
export const OPERATOR_PASS = env.OPERATOR_PASS;

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
