/// <cts-enable />
import { OpaqueRef, derive } from "commontools";
const count: OpaqueRef<number> = {} as any;
const double = commontools_1.derive(count, _v1 => _v1 + _v1);