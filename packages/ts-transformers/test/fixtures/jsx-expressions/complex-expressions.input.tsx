/// <cts-enable />
import { pattern, UI } from "commonfabric";

interface Problem {
  price: number;
  discount: number;
  tax: number;
}

// FIXTURE: complex-expressions
// Verifies: multi-variable arithmetic in JSX is wrapped in derive() with captured refs
//   {price - discount}             → derive({price, discount}, (...) => price - discount)
//   {(price - discount) * (1+tax)} → derive({price, discount, tax}, (...) => ...)
export default pattern<Problem>(
  ({ price, discount, tax }) => {
    return {
      [UI]: (
        <div>
          <p>Price: {price}</p>
          <p>Discount: {price - discount}</p>
          <p>With tax: {(price - discount) * (1 + tax)}</p>
        </div>
      ),
    };
  },
);
