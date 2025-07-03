/// <cts-enable />
import { OpaqueRef, derive } from "commontools";
const count: OpaqueRef<number> = {} as any;
const result = count + 1;
const double = count * 2;
const decrement = count - 1;