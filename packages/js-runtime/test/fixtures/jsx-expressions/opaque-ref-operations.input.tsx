import { OpaqueRef, derive, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const price: OpaqueRef<number> = {} as any;

const element = (
  <div>
    <p>Count: {count}</p>
    <p>Next: {count + 1}</p>
    <p>Double: {count * 2}</p>
    <p>Total: {price * 1.1}</p>
  </div>
);