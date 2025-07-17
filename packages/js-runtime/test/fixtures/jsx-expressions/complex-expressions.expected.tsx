/// <cts-enable />
import { OpaqueRef, derive, h, recipe, UI } from "commontools";
export default recipe("ComplexExpressions", (state) => {
    const price: OpaqueRef<number> = {} as any;
    return {
        [UI]: (<div>
        <p>Price: {price}</p>
        <p>With tax: {commontools_1.derive(price, _v1 => _v1 * 1.1)}</p>
        <p>Discount: {commontools_1.derive(price, _v1 => _v1 - 10)}</p>
      </div>)
    };
});