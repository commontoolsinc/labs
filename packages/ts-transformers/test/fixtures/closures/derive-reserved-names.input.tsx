/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDerive() {
  const value = cell(10);
  // Reserved JavaScript keyword as variable name (valid in TS with quotes)
  const __ct_reserved = cell(2);

  const result = derive(value, (v) => v.get() * __ct_reserved.get());

  return result;
}
