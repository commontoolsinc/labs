/// <cts-enable />
import { OpaqueRef, derive, h } from "commontools";
const price: OpaqueRef<number> = {} as any;
const element = (commontools_1.h("div", null,
    commontools_1.h("p", null,
        "Price: ",
        price),
    commontools_1.h("p", null,
        "With tax: ",
        commontools_1.derive(price, _v1 => _v1 * 1.1)),
    commontools_1.h("p", null,
        "Discount: ",
        commontools_1.derive(price, _v1 => _v1 - 10))));