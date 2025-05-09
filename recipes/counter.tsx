// deno-lint-ignore-file jsx-no-useless-fragment
import { h } from "@commontools/html";
import {
  type BuiltInLLMParams,
  derive,
  handler,
  ifElse,
  lift,
  llm,
  NAME,
  recipe,
  schema,
  str,
  UI,
} from "@commontools/builder";

// Different way to define the same schema, using 'schema' helper function,
// let's as leave off `as const satisfies JSONSchema`.
const model = schema({
  type: "object",
  properties: {
    value: { type: "number", default: 0, asCell: true },
  },
  default: { value: 0 },
});

const increment = handler({}, model, (_, state) => {
  state.value.set(state.value.get() + 1);
});

const decrement = handler({}, model, (_, state) => {
  state.value.set(state.value.get() - 1);
});

const genRequest = lift(({ number: number }): BuiltInLLMParams | undefined => {
  return {
    system:
      "You are a helpful assistant that returns a short random facts about a number, reply with a JSON object with the following properties: number (number), story (string), origin (string), related_numbers (array of numbers)",
    messages: [`${number}`],
    mode: "json",
  };
});

export default recipe(model, model, (cell) => {
  const { result: story } = llm<{
    story: string;
    origin: string;
    number: number;
    related_numbers: number[];
  }>(genRequest({ number: cell.value }));
  return {
    [NAME]: str`Number time: ${derive(cell.value, String)}`,
    [UI]: (
      <div>
        <button type="button" onClick={increment(cell)}>+</button>
        <b>{cell.value}</b>
        <button type="button" onClick={decrement(cell)}>-</button>
        <p>{derive(story, JSON.stringify)}</p>
      </div>
    ),
    value: cell.value,
  };
});
