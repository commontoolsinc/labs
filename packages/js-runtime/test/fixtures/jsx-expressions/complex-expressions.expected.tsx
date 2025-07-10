/// <cts-enable />
import { OpaqueRef, derive, h } from "commontools";
const price: OpaqueRef<number> = {} as any;
const element = (<div>
    <p>Price: {price}</p>
    <p>With tax: {commontools_1.derive(price, _v1 => _v1 * 1.1)}</p>
    <p>Discount: {commontools_1.derive(price, _v1 => _v1 - 10)}</p>
  </div>);