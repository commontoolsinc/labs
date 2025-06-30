/// <cts-enable />
import { OpaqueRef, derive } from "commontools";
const a: OpaqueRef<number> = {} as any;
const b: OpaqueRef<number> = {} as any;
const c: OpaqueRef<number> = {} as any;
const result = (a + b) * c;