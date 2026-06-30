import * as Path from "@std/path";
import type { MemorySpace } from "../interface.ts";

export const encodeStoreSubject = (subject: MemorySpace): string => {
  const value = String(subject);
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`Invalid memory space identifier for store path: ${value}`);
  }

  try {
    return encodeURIComponent(value);
  } catch {
    throw new Error(`Invalid memory space identifier for store path: ${value}`);
  }
};

export const resolveSpaceStoreUrl = (
  store: URL,
  subject: MemorySpace,
): URL => {
  const filename = `${encodeStoreSubject(subject)}.sqlite`;
  const storePath = store.protocol === "file:"
    ? Path.fromFileUrl(store)
    : store.pathname;
  const isFile = Path.extname(storePath) !== "";

  // NOTE: the two modes intentionally differ in how the filename is realized on
  // disk and this MUST NOT change — existing stores depend on it:
  //   * directory mode resolves the (percent-encoded) filename as a URL segment,
  //     so `%3A` decodes back to ":" → `…/engine-v3/did:key:….sqlite`.
  //   * single-file mode joins it as a literal path component, so the literal
  //     `%3A` is preserved → `<stem>.engine-v3/did%3Akey%3A….sqlite`.
  // Changing either silently forks data into new per-space files on upgrade.
  if (!isFile) {
    return new URL(`./engine-v3/${filename}`, store);
  }

  const ext = Path.extname(storePath);
  const stem = ext === "" ? storePath : storePath.slice(0, -ext.length);
  return Path.toFileUrl(Path.join(`${stem}.engine-v3`, filename));
};

/**
 * The directory that holds per-space sqlite files for a given store. Directory
 * mode nests under `engine-v3/`; single-file mode (a `*.sqlite` DB_PATH) nests
 * under a sibling `<stem>.engine-v3/`. The directory itself is unambiguous in
 * both modes (only the per-file name encoding differs — see resolveSpaceStoreUrl),
 * so read-only consumers like the dump endpoint use this to enumerate the store
 * and `decodeURIComponent` each filename stem back to its DID.
 */
export const resolveSpaceStoreDirUrl = (store: URL): URL => {
  const storePath = store.protocol === "file:"
    ? Path.fromFileUrl(store)
    : store.pathname;
  const isFile = Path.extname(storePath) !== "";

  if (!isFile) {
    return new URL("./engine-v3/", store);
  }

  const ext = Path.extname(storePath);
  const stem = ext === "" ? storePath : storePath.slice(0, -ext.length);
  return Path.toFileUrl(`${stem}.engine-v3/`);
};
