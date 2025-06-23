import { OpaqueRef, ifElse } from "commontools";
const a: OpaqueRef<boolean> = {} as any;
const b: OpaqueRef<boolean> = {} as any;
const result = a ? (b ? 1 : 2) : 3;