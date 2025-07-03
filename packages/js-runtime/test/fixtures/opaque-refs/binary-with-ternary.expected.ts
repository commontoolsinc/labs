/// <cts-enable />
import { OpaqueRef, derive, ifElse } from "commontools";
const sale: OpaqueRef<boolean> = {} as any;
const price = commontools_1.derive(sale, _v1 => 5 - (_v1 ? 1 : 0));