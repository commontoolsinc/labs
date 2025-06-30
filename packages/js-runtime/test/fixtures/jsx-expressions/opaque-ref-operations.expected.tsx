/// <cts-enable />
import { cell, h, derive } from "commontools";
const count = cell(10);
const price = cell(10);
const element = (<div>
    <p>Count: {count}</p>
    <p>Next: {commontools_1.derive(count, _v1 => _v1 + 1)}</p>
    <p>Double: {commontools_1.derive(count, _v1 => _v1 * 2)}</p>
    <p>Total: {commontools_1.derive(price, _v1 => _v1 * 1.1)}</p>
  </div>);