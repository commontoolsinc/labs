import { Cell, getEntityId } from "@commontools/runner";
import { Charm } from "@commontools/charm";
import type { DID } from "@commontools/identity";

/**
 * Custom logger that includes timestamp and charm ID
 */
export function log(charm?: Cell<Charm> | string, ...args: any[]) {
  const timestamp = new Date().toISOString();
  let charmIdSuffix = "";
  
  if (charm) {
    if (typeof charm === "string") {
      charmIdSuffix = ` [${charm.slice(-10)}]`;
    } else {
      const id = getEntityId(charm)?.["/"];
      if (id) {
        charmIdSuffix = ` [${id.slice(-10)}]`;
      }
    }
  }
  
  console.log(`${timestamp}${charmIdSuffix}`, ...args);
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
): ({ space: DID; charmId: string })[] {
  const result: ({ space: DID; charmId: string })[] = [];
  
  charms.split(",").forEach((entry) => {
    const parts = entry.split("/");
    if (parts.length !== 2) {
      log(undefined, `Invalid charm format: ${entry}. Expected format: space/charmId`);
      return; // Skip this entry
    }
    
    const [space, charmId] = parts;
    
    if (!isValidDID(space)) {
      log(undefined, `Invalid space ID: ${space}. Must be a valid DID.`);
      return; // Skip this entry
    }
    
    if (!isValidCharmId(charmId)) {
      log(undefined, `Invalid charm ID: ${charmId}. Must be a valid merkle ID.`);
      return; // Skip this entry
    }
    
    result.push({ space: space as DID, charmId });
  });
  
  return result;
}