// types.ts — Core types for the FUSE filesystem tree
import type { CfcNodeAnnotation } from "./annotations.ts";
import type { CallableKind } from "./callables.ts";

export type JsonType =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "object"
  | "array";

export type CfcAnnotatedNode = {
  cfc?: CfcNodeAnnotation;
};

export type FsNode =
  | (
    & { kind: "dir"; children: Map<string, bigint>; jsonType?: JsonType }
    & CfcAnnotatedNode
  )
  | (
    & { kind: "file"; content: Uint8Array; jsonType: JsonType }
    & CfcAnnotatedNode
  )
  | ({ kind: "symlink"; target: string } & CfcAnnotatedNode)
  | ({
    kind: "callable";
    callableKind: CallableKind;
    cellKey: string;
    cellProp: "input" | "result";
    script: Uint8Array;
  } & CfcAnnotatedNode);
