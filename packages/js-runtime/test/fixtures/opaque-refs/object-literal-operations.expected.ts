/// <cts-enable />
import { OpaqueRef, derive, cell } from "commontools";
const a = cell<number>(5);
const b = cell<number>(10);
const obj = { x: commontools_1.derive(a, _v1 => _v1 + 1), y: commontools_1.derive(b, _v1 => _v1 * 2), z: commontools_1.derive({ a, b }, ({ a: _v1, b: _v2 }) => _v1 + _v2) };