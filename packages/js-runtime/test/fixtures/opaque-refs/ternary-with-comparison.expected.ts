import { OpaqueRef, derive, ifElse, cell } from "commontools";
const opaque = cell<number>(10);
const result = commontools_1.ifElse(commontools_1.derive(opaque, _v1 => _v1 > 5), 1, 2);