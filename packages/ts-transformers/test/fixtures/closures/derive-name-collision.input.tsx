/// <cts-enable />
import { cell, derive } from "commontools";

export default function TestDerive() {
  const value = cell(10);
  const multiplier = cell(2);

  // Parameter name collides with capture name
  const result = derive(value, (multiplier) => multiplier * 3);

  return result;
}
