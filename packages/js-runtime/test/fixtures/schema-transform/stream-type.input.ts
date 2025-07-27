/// <cts-enable />
import { Stream, toSchema } from "commontools";

interface State {
  events: Stream<string>;
  label: string;
}

const stateSchema = toSchema<State>();
export { stateSchema };