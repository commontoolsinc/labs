import type { IMemorySpaceAddress } from "../storage/interface.ts";

const CFC_SCHEMA_BLOB_PREFIX = "blob:";

export function cfcSchemaBlobId(
  schemaHash: string,
): IMemorySpaceAddress["id"] {
  return `${CFC_SCHEMA_BLOB_PREFIX}${schemaHash}` as IMemorySpaceAddress["id"];
}

export function cfcSchemaBlobAddress(
  space: IMemorySpaceAddress["space"],
  schemaHash: string,
): IMemorySpaceAddress {
  return {
    space,
    id: cfcSchemaBlobId(schemaHash),
    type: "application/json",
    path: [],
  };
}

export function isCfcSchemaBlobId(id: string): boolean {
  return id.startsWith(CFC_SCHEMA_BLOB_PREFIX);
}
