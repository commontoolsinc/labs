// types.ts — Core types for the FUSE filesystem tree
import type { CallableKind } from "./callables.ts";

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
  | { kind: "symlink"; target: string }
  | {
    kind: "callable";
    callableKind: CallableKind;
    cellKey: string;
    cellProp: "input" | "result";
    script: Uint8Array;
  };
