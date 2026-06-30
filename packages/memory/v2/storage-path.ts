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

/**
 * The directory that holds per-space sqlite files for a given store. Directory
 * mode nests under `engine-v3/`; single-file mode (a `*.sqlite` DB_PATH) nests
 * under a sibling `<stem>.engine-v3/`. This is the single source of truth shared
 * by `resolveSpaceStoreUrl` (and read-only consumers like the dump endpoint), so
 * the "where do space DBs live" rule lives in exactly one place.
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

export const resolveSpaceStoreUrl = (
  store: URL,
  subject: MemorySpace,
): URL => {
  const filename = `${encodeStoreSubject(subject)}.sqlite`;
  return new URL(`./${filename}`, resolveSpaceStoreDirUrl(store));
};
