import { OpaqueRef, derive, ifElse } from "commontools";
const sale: OpaqueRef<boolean> = {} as any;
const price = 5 - (sale ? 1 : 0);