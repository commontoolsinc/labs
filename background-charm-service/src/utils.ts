import { Charm, CharmManager } from "@commontools/charm";
import { Cell, getEntityId } from "@commontools/runner";
import { DID, openSession, type Session } from "@commontools/identity";
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
