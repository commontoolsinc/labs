import { OpaqueRef, derive, cell } from "commontools";
const a = cell<number>(10);
const b = cell<number>(20);
const c = [a + 1, b - 1];