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

/** Decode a base64url (no padding) string back to UTF-8 string. */
function base64UrlDecode(input: string): string {
  const s = input.replaceAll("-", "+").replaceAll("_", "/");
  // Pad to multiple of 4
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const padded = s + "=".repeat(pad);
  try {
    return atob(padded);
  } catch {
    return "";
  }
}

/** Deterministic mapping from runner URI to storage docId. */
export function docIdFromUri(uri: URI): string {
  return `doc:${base64UrlEncode(uri)}`;
}

/** Best-effort reverse mapping from storage docId to runner URI. */
export function uriFromDocId(docId: string): URI | undefined {
  if (!docId.startsWith("doc:")) return undefined;
  const encoded = docId.slice(4);
  const decoded = base64UrlDecode(encoded);
  return decoded as URI;
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
