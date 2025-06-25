import { OpaqueRef, derive } from "commontools";
const a: OpaqueRef<number> = {} as any;
const b: OpaqueRef<number> = {} as any;
const c: OpaqueRef<number> = {} as any;
const result = commontools_1.derive({ a, b, c }, ({ a: _v1, b: _v2, c: _v3 }) => (_v1 + _v2) * _v3);