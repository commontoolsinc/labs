import { OpaqueRef, derive, ifElse, cell } from "commontools";
const opaque = cell<number>(10);
const result = opaque > 5 ? 1 : 2;