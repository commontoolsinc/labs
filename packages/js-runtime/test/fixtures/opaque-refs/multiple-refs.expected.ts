import { OpaqueRef, derive } from "commontools";
const count1: OpaqueRef<number> = {} as any;
const count2: OpaqueRef<number> = {} as any;
const sum = commontools_1.derive({ count1, count2 }, ({ count1: _v1, count2: _v2 }) => _v1 + _v2);
const product = commontools_1.derive({ count1, count2 }, ({ count1: _v1, count2: _v2 }) => _v1 * _v2);