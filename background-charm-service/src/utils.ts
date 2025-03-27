import { Charm, CharmManager } from "@commontools/charm";
import { Cell, getEntityId } from "@commontools/runner";
import { Identity, DID, type Session } from "@commontools/identity";
import { env } from "./env.ts";

/**
 * Custom logger that includes timestamp and optionally charm ID
 * @param message - The message to log
 * @param options - Optional parameters
 * @param options.charm - Charm cell or ID to include in the log
 * @param options.error - Whether to log as error instead of info
 * @param args - Additional arguments to log
 */
export function log(
  message: any,
  options?: { charm?: Cell<Charm> | string; error?: boolean },
  ...args: any[]
) {
  const timestamp = new Date().toISOString();
  let charmIdSuffix = "";

  if (options?.charm) {
    const charm = options.charm;
    if (typeof charm === "string") {
      charmIdSuffix = ` [${charm.slice(-10)}]`;
    } else {
      const id = getEntityId(charm)?.["/"];
      if (id) {
        charmIdSuffix = ` [${id.slice(-10)}]`;
      }
    }
  }

  if (options?.error) {
    console.error(`${timestamp}${charmIdSuffix}`, message, ...args);
  } else {
    console.log(`${timestamp}${charmIdSuffix}`, message, ...args);
  }
}

export function isValidDID(did: string): boolean {
  return did?.startsWith("did:key:") && did.length > 10;
}

export function isValidCharmId(id: string): boolean {
  return !!id && id.length === 59;
}

// Derives the identity configured for this service,
// receiving an `IDENTITY` and `OPERATOR_PASS` from the environment.
//
// First, uses the key path to load a key.
// If not set, falls back to operator pass to
// use an insecure passphrase.
// This fallback should be removed once fully migrated
// over to using keyfiles. 
export async function getIdentity(identityPath?: string, operatorPass?: string): Promise<Identity> {
  if (identityPath) {
    console.log(`Using identity at ${identityPath}`);
    try {
      const pkcs8Key = await Deno.readFile(identityPath);
      return await Identity.fromPkcs8(pkcs8Key);
    } catch (e) {
      throw new Error(`Could not read key at ${identityPath}.`);
    }
  } else if (operatorPass) {
    console.warn("Using insecure passphrase identity.");
    return await Identity.fromPassphrase(operatorPass);
  }
  throw new Error("No IDENTITY or OPERATOR_PASS environemnt set.");
}
