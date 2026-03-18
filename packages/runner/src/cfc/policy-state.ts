import { canonicalHash } from "@commontools/memory/canonical-hash";
import { storableFromNativeValue } from "@commontools/memory/storable-value";
import type {
  IMemorySpaceAddress,
  MemorySpace,
  URI,
} from "../storage/interface.ts";
import { toHex } from "./shared.ts";

export function deriveCfcPolicyStateId(record: unknown): URI {
  const hash = canonicalHash(storableFromNativeValue(record));
  return `cfc:policy-state:${toHex(hash.hash)}` as URI;
}

export function cfcPolicyStateAddress(
  space: MemorySpace,
  record: unknown,
): IMemorySpaceAddress {
  return {
    space,
    id: deriveCfcPolicyStateId(record),
    type: "application/json",
    path: ["value"],
  };
}
