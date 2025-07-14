/// <cts-enable />
import { OpaqueRef, ifElse } from "commontools";
const a: OpaqueRef<boolean> = {} as any;
const b: OpaqueRef<boolean> = {} as any;
const result = commontools_1.ifElse(a, commontools_1.ifElse(b, 1, 2), 3);