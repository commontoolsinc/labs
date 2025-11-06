/// <cts-enable />
import { cell } from "commontools";

interface State {
  value: number;
}

export default function TestDerive(state: State) {
  const cellValue = cell(state.value);
  const multiplier = cell(2);

  const result = cellValue.derive((v) => v * multiplier.get());

  return result;
}
