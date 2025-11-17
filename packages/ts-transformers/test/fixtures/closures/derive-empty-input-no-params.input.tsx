/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDeriveEmptyInputNoParams() {
  const a = cell(10);
  const b = cell(20);

  // Zero-parameter callback that closes over a and b
  const result = derive({}, () => a.get() + b.get());

  return result;
}
