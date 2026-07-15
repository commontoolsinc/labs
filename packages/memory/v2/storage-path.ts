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

/** Whether a store URL is a single-file (`*.sqlite` DB_PATH) store, as opposed
 *  to the default directory-mode store. The two modes realize per-space
 *  filenames differently — see resolveSpaceStoreUrl. */
const isSingleFileStore = (store: URL): boolean => {
  const storePath = store.protocol === "file:"
    ? Path.fromFileUrl(store)
    : store.pathname;
  return Path.extname(storePath) !== "";
};

export const resolveSpaceStoreUrl = (
  store: URL,
  subject: MemorySpace,
): URL => {
  const filename = `${encodeStoreSubject(subject)}.sqlite`;
  const storePath = store.protocol === "file:"
    ? Path.fromFileUrl(store)
    : store.pathname;

  // NOTE: the two modes intentionally differ in how the filename is realized on
  // disk and this MUST NOT change — existing stores depend on it:
  //   * directory mode resolves the (percent-encoded) filename as a URL segment,
  //     so the encoding decodes away → `…/engine-v3/did:key:….sqlite` (the stem
  //     is the LITERAL space id).
  //   * single-file mode joins it as a literal path component, so the
  //     percent-encoding is preserved → `<stem>.engine-v3/did%3Akey%3A….sqlite`.
  // Changing either silently forks data into new per-space files on upgrade.
  // `spaceFromStoreFilename` below is the mode-aware inverse.
  if (!isSingleFileStore(store)) {
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
 * both modes; per-file name encoding differs (see resolveSpaceStoreUrl), so
 * map filenames back to space ids with `spaceFromStoreFilename` — NOT a blanket
 * `decodeURIComponent`, which corrupts directory-mode ids containing literal
 * percent-sequences (e.g. a `did:web:…%3A8080`).
 */
export const resolveSpaceStoreDirUrl = (store: URL): URL => {
  const storePath = store.protocol === "file:"
    ? Path.fromFileUrl(store)
    : store.pathname;

  if (!isSingleFileStore(store)) {
    return new URL("./engine-v3/", store);
  }

  const ext = Path.extname(storePath);
  const stem = ext === "" ? storePath : storePath.slice(0, -ext.length);
  return Path.toFileUrl(`${stem}.engine-v3/`);
};

/**
 * Resolves the service-wide schema content-addressed store. It deliberately
 * lives beside, rather than inside, the per-space `engine-v3` databases.
 * Non-file stores have no durable filesystem location and therefore use SQLite
 * in-memory storage.
 */
export const resolveSchemaStoreUrl = (store: URL): URL => {
  if (store.protocol !== "file:") return new URL("memory:");

  const storePath = Path.fromFileUrl(store);
  if (!isSingleFileStore(store)) {
    return new URL("./schema-store-v2.sqlite", store);
  }

  const ext = Path.extname(storePath);
  const stem = storePath.slice(0, -ext.length);
  return Path.toFileUrl(`${stem}.schema-store-v2.sqlite`);
};

/**
 * Mode-aware inverse of the filename encoding in `resolveSpaceStoreUrl`: map an
 * on-disk `.sqlite` filename stem (from the store's space dir) back to the
 * space id. Directory-mode stems are the LITERAL id (the URL resolution already
 * decoded them); single-file-mode stems are still percent-encoded. Returns null
 * for a stem that cannot be a store filename we wrote (bad encoding).
 */
export const spaceFromStoreFilename = (
  store: URL,
  stem: string,
): string | null => {
  if (!isSingleFileStore(store)) return stem;
  try {
    return decodeURIComponent(stem);
  } catch {
    return null;
  }
};
