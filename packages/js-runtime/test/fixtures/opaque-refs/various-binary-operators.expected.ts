import { OpaqueRef, derive } from "commontools";
const num: OpaqueRef<number> = {} as any;
const a = commontools_1.derive(num, _v1 => _v1 + 1);
const b = commontools_1.derive(num, _v1 => _v1 - 1);
const c = commontools_1.derive(num, _v1 => _v1 * 2);
const d = commontools_1.derive(num, _v1 => _v1 / 2);
const e = commontools_1.derive(num, _v1 => _v1 % 3);