import type {
  IMemoryAddress,
  IMemorySpaceAddress,
  MemoryAddressPathComponent,
  URI,
} from "../storage/interface.ts";
import type { MemorySpace } from "../storage.ts";

/** Encode a string as base64url without padding. */
function base64UrlEncode(input: string): string {
  const b64 = btoa(input);
  return b64.replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Deterministic mapping from runner URI to storage docId. */
export function docIdFromUri(uri: URI): string {
  return `doc:${base64UrlEncode(uri)}`;
}

/** Pass-through; runner MemorySpace is already a DID. */
export function spaceDid(space: MemorySpace): string {
  return String(space);
}

/** Normalize path tokens to strings for the storage client. */
export function pathFromAddress(
  address: Pick<IMemoryAddress, "path">,
): string[] {
  return address.path.map((p: MemoryAddressPathComponent) => String(p));
}

export function getDocRef(
  address: IMemoryAddress | IMemorySpaceAddress,
): { docId: string; path: string[] } {
  return { docId: docIdFromUri(address.id), path: pathFromAddress(address) };
}


