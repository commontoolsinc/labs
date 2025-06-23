import { OpaqueRef, derive, h } from "commontools";
const price: OpaqueRef<number> = {} as any;
const element = (
  <div>
    <p>Price: {price}</p>
    <p>With tax: {price * 1.1}</p>
    <p>Discount: {price - 10}</p>
  </div>
);