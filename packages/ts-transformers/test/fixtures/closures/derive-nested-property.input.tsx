/// <cts-enable />
import { cell, derive } from "commontools";

interface State {
  config: {
    multiplier: number;
  };
}

export default function TestDerive(state: State) {
  const value = cell(10);

  const result = derive(value, (v) => v * state.config.multiplier);

  return result;
}
