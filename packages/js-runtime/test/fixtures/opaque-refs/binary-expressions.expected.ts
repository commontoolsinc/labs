import { OpaqueRef, derive } from "commontools";
const count: OpaqueRef<number> = {} as any;
const result = commontools_1.derive(count, _v1 => _v1 + 1);
const double = commontools_1.derive(count, _v1 => _v1 * 2);
const decrement = commontools_1.derive(count, _v1 => _v1 - 1);