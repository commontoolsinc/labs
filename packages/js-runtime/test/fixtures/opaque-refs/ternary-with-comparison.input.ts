/// <cts-enable />
import { cell, derive, ifElse, OpaqueRef } from "commontools";
const opaque = cell<number>(10);
const result = opaque > 5 ? 1 : 2;
