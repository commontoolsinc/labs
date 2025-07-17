/// <cts-enable />
import { cell, derive, h, recipe, UI } from "commontools";

interface Problem {
  price: number;
  discount: number;
  tax: number;
}

export default recipe<Problem>("ComplexExpressions", 
  ({ price, discount, tax }) => {
  return {
    [UI]: (
      <div>
        <p>Price: {price}</p>
        <p>Discount: {price - discount}</p>
        <p>With tax: {(price - discount) * (1 + tax)}</p>
      </div>
    )
  };
});