import { isRecord } from "@commonfabric/utils/types";
import { ACL, ACLUser, ANYONE, Capability, DID, DIDKey } from "./interface.ts";
import { isDID } from "../identity/src/interface.ts";

export type { ACL, ACLUser, ANYONE, Capability, DID, DIDKey };

export const ANYONE_USER: ANYONE = "*";

export function isACLUser(value: unknown): value is ACLUser {
  return value === ANYONE_USER || isDID(value);
}

export function isCapability(value: unknown): value is Capability {
  return value === "READ" || value === "WRITE" || value === "OWNER";
}

export function isACL(value: unknown): value is ACL {
  if (!isRecord(value)) return false;
  for (const [did, cap] of Object.entries(value)) {
    if (!isACLUser(did)) return false;
    if (!isCapability(cap)) return false;
  }
  return true;
}

const CapabilityMap: Record<Capability, number> = {
  READ: 0,
  WRITE: 1,
  OWNER: 2,
};

export function isCapable(
  capability: Capability,
  requirement: Capability,
): boolean {
  return CapabilityMap[capability] >=
    CapabilityMap[requirement];
}
