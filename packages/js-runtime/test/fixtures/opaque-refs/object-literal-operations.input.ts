/// <cts-enable />
import { OpaqueRef, derive, cell } from "commontools";
const a = cell<number>(5);
const b = cell<number>(10);
const obj = { x: a + 1, y: b * 2, z: a + b };