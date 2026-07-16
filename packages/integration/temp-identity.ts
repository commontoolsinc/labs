import { Identity, type IdentityCreateConfig } from "@commonfabric/identity";

export interface TempIdentity {
  /** The identity, for in-process use. */
  identity: Identity;
  /** Path to the PKCS8 keyfile, for a spawned CLI's `--identity` flag. */
  path: string;
}

/**
 * Generates a fresh identity and writes its PKCS8 keyfile to a temporary
 * file, giving a test both the in-process identity and a keyfile path that a
 * spawned CLI can load. The keyfile parses through the same
 * `Identity.fromPkcs8` path the CLI's `--identity` loading uses. The caller
 * owns the file and removes it when done. Callers that serialize the
 * identity (for example shell login) need `{ implementation: "noble" }`.
 */
export async function writeTempIdentity(
  config: IdentityCreateConfig = {},
): Promise<TempIdentity> {
  const pkcs8 = await Identity.generatePkcs8();
  const identity = await Identity.fromPkcs8(pkcs8, config);
  const path = await Deno.makeTempFile({ prefix: "cf-test-identity-" });
  await Deno.writeFile(path, pkcs8);
  return { identity, path };
}
