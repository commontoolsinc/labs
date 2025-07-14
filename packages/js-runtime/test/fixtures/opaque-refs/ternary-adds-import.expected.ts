/// <cts-enable />
import { OpaqueRef, ifElse } from "commontools";
const isActive: OpaqueRef<boolean> = {} as any;
const result = commontools_1.ifElse(isActive, "active", "inactive");