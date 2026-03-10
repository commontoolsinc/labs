/// <cts-enable />
import { Writable, derive, pattern } from "commontools";

interface State {
  config: {
    multiplier: number;
  };
}

export default pattern((state: State) => {
  const value = Writable.of(10);

  const result = derive(value, (v) => v.get() * state.config.multiplier);

  return result;
});
