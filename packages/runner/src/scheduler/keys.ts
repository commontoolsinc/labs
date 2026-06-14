import { normalizeCellScope } from "../scope.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type { SpaceScopeAndURI } from "./types.ts";

export function entityKey(
  address: Pick<IMemorySpaceAddress, "space" | "id" | "scope">,
): SpaceScopeAndURI {
  return `${address.space}/${normalizeCellScope(address.scope)}/${address.id}`;
}
