/// <cts-enable />
import { OpaqueRef, derive, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const element = commontools_1.h("div", null, commontools_1.derive(count, _v1 => _v1 + 1));