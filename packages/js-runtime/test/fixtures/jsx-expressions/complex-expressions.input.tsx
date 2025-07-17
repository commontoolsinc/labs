/// <cts-enable />
import { OpaqueRef, derive, h, recipe, UI } from "commontools";

export default recipe("ComplexExpressions", (state) => {
  const price: OpaqueRef<number> = {} as any;
  return {
    [UI]: (
      <div>
        <p>Price: {price}</p>
        <p>With tax: {price * 1.1}</p>
        <p>Discount: {price - 10}</p>
      </div>
    )
  };
});