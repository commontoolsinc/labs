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

  if (!isFile) {
    return new URL(`./engine-v3/${filename}`, store);
  }

  const ext = Path.extname(storePath);
  const stem = ext === "" ? storePath : storePath.slice(0, -ext.length);
  return Path.toFileUrl(Path.join(`${stem}.engine-v3`, filename));
};
