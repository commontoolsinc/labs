import { OpaqueRef, derive } from "commontools";
const num: OpaqueRef<number> = {} as any;
const a = num + 1;
const b = num - 1;
const c = num * 2;
const d = num / 2;
const e = num % 3;