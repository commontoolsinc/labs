/// <cts-enable />
import {
  Cell,
  derive,
  generateObject,
  h,
  handler,
  ifElse,
  lift,
  NAME,
  recipe,
  str,
  toSchema,
  UI,
} from "commontools";

interface InputState {
  number: Cell<number>;
}

interface OutputState {
  title: string;
  story: string;
}

const inputSchema = toSchema<InputState>({
  default: { number: 0 },
});

const outputSchema = toSchema<OutputState>();

const adder = handler({}, inputSchema, (_, state) => {
  state.number.set(state.number.get() + 1);
});

const generatePrompt = lift(({ number }: { number: number }) => {
  return {
    prompt: `Tell me about the number ${number}`,
    schema: outputSchema,
  };
});

export default recipe(inputSchema, outputSchema, (cell) => {
  const { result: object, pending } = generateObject<OutputState>(
    generatePrompt({ number: cell.number }),
  );

  return {
    [NAME]: str`Number Story: ${object?.title || "Loading..."}`,
    [UI]: (
      <div>
        <ct-button onClick={adder({ number: cell.number })}>
          Current number: {cell.number} (click to increment)
        </ct-button>
        {ifElse(
          pending,
          <p>Generating story...</p>,
          <div>
            <h1>{object?.title}</h1>
            <p>{object?.story}</p>
          </div>,
        )}
      </div>
    ),
    number: cell.number,
    ...object,
  };
});