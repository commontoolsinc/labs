// types.ts — Core types for the FUSE filesystem tree

export type JsonType =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "object"
  | "array";

export type FsNode =
  | { kind: "dir"; children: Map<string, bigint>; jsonType?: JsonType }
  | { kind: "file"; content: Uint8Array; jsonType: JsonType }
  | { kind: "symlink"; target: string };
