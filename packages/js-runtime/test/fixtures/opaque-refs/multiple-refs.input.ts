import { OpaqueRef, derive } from "commontools";
const count1: OpaqueRef<number> = {} as any;
const count2: OpaqueRef<number> = {} as any;
const sum = count1 + count2;
const product = count1 * count2;