/// <cts-enable />
import { Cell, toSchema } from "commontools";

interface State {
  count: Cell<number>;
  name: Cell<string>;
  enabled: boolean;
}

const stateSchema = toSchema<State>({
  default: { count: 0, name: "test", enabled: true }
});
export { stateSchema };