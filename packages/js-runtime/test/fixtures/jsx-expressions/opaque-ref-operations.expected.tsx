import { OpaqueRef, derive, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const price: OpaqueRef<number> = {} as any;
const element = (commontools_1.h("div", null,
    commontools_1.h("p", null,
        "Count: ",
        count),
    commontools_1.h("p", null,
        "Next: ",
        commontools_1.derive(count, _v1 => _v1 + 1)),
    commontools_1.h("p", null,
        "Double: ",
        commontools_1.derive(count, _v1 => _v1 * 2)),
    commontools_1.h("p", null,
        "Total: ",
        commontools_1.derive(price, _v1 => _v1 * 1.1))));