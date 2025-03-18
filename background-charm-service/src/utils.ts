import { Charm } from "@commontools/charm";
import type { DID } from "@commontools/identity";
import { Cell, getEntityId } from "@commontools/runner";

/**
 * Custom logger that includes timestamp and optionally charm ID
 * @param message - The message to log
 * @param options - Optional parameters
 * @param options.charm - Charm cell or ID to include in the log
 * @param args - Additional arguments to log
 */
export function log(
  message: any,
  options?: { charm?: Cell<Charm> | string },
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

  console.log(`${timestamp}${charmIdSuffix}`, message, ...args);
}

/**
 * Validates if a string is a valid DID
 */
export function isValidDID(did: string): boolean {
  return did?.startsWith("did:key:") && did.length > 10;
}

/**
 * Validates if a string looks like a valid merkle ID
 */
export function isValidCharmId(id: string): boolean {
  return !!id && id.length === 59;
}

/**
 * Parses input in the form:
 * `did:key:abc../xyzcharmid,did:key:def.../zyxcharmid`
 */
export function parseCharmsInput(
  charms: string,
): ({ space: DID; charmId: string; integration: string })[] {
  const result: ({ space: DID; charmId: string; integration: string })[] = [];

  charms.split(",").forEach((entry) => {
    const parts = entry.split("/");
    if (parts.length !== 3) {
      log(
        `Invalid charm format: ${entry}. Expected format: space/charmId/integration`,
      );
      return; // Skip this entry
    }

    const [space, charmId, integration] = parts;

    if (!isValidDID(space)) {
      log(`Invalid space ID: ${space}. Must be a valid DID.`);
      return; // Skip this entry
    }

    if (!isValidCharmId(charmId)) {
      log(`Invalid charm ID: ${charmId}. Must be a valid merkle ID.`);
      return; // Skip this entry
    }

    if (!integration) {
      log(`Invalid integration: ${integration}. Must be a valid integration.`);
      return; // Skip this entry
    }

    result.push({ space: space as DID, charmId, integration });
  });

  return result;
}
