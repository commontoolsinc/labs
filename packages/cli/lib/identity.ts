import { Identity } from "@commontools/identity";
import { decode } from "@commontools/utils/encoding";

export async function pkcs8FromPassphrase(
  passphrase: string,
): Promise<string> {
  const identity = await Identity.fromPassphrase(passphrase, {
    implementation: "noble",
  });
  return decode(identity.toPkcs8());
}

export async function pkcs8FromEntropy(): Promise<string> {
  return decode(await Identity.generatePkcs8());
}

export async function getDidFromFile(
  keypath: string,
): Promise<`did:key:${string}`> {
  const keyBuffer = await Deno.readFile(keypath);
  return (await Identity.fromPkcs8(keyBuffer)).did();
}

export async function loadIdentity(
  filepath: string,
): Promise<Identity<`did:key:${string}`>> {
  return Identity.fromPkcs8(await Deno.readFile(filepath));
}
