/// <cts-enable />
import { OpaqueRef, derive } from "commontools";
const count: OpaqueRef<number> = {} as any;
const double = count + count;