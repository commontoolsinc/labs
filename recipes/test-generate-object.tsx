import {
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

// Define types using TypeScript interfaces
interface InputState {
  number: number; // @asCell
}

interface OutputState {
  number: number;
  story: string;
  title: string;
  storyOrigin: string;
  seeAlso: number[];
  imagePrompt: string;
}

interface SetNumberEvent {
  number: number; // @asCell
  n: number;
}

// Transform to schemas at compile time
const inputSchema = toSchema<InputState>({
  default: { number: 0 },
});

const outputSchema = toSchema<OutputState>();

// Handler to increment the number
const adder = handler({}, inputSchema, (_, state) => {
  state.number.set(state.number.get() + 1);
});

// Handler to set a specific number
const setNumber = handler({}, toSchema<SetNumberEvent>(), (_, state) => {
  if (state.number && state.n) {
    state.number.set(state.n);
  }
});

// Generate the prompt for the LLM
const generatePrompt = lift(({ number }: { number: number }) => {
  return {
    prompt:
      `You are the parent of a young child who loves to learn about numbers. Luckily for your child, you are a historian of numbers and when the child says a number you make up an interesting story about it, including the history of the number. The child is currently at ${number}. Also return a recommendation for other numbers that might be interesting to the child to learn about next.`,
    schema: outputSchema,
  };
});

// Generate an image URL from the prompt
const generateImageUrl = lift(({ imagePrompt }: { imagePrompt: string }) => {
  return `/api/ai/img?prompt=${encodeURIComponent(imagePrompt)}`;
});

export default recipe(inputSchema, outputSchema, (cell) => {
  // Use generateObject to get structured data from the LLM
  const { result: object, pending } = generateObject<OutputState>(
    generatePrompt({ number: cell.number }),
  );

  const imageUrl = generateImageUrl({
    imagePrompt: object?.imagePrompt || "robot thinking",
  });

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
            <p>
              <img
                src={imageUrl}
              />
            </p>
            <p>{object?.story}</p>
            <p>
              <em>{object?.storyOrigin}</em>
            </p>
            <div>
              <p>See also these interesting numbers:</p>
              <ul>
                {object?.seeAlso?.map((n: number) => (
                  <li>
                    <ct-button
                      onClick={setNumber({ number: cell.number, n })}
                    >
                      {n}
                    </ct-button>
                  </li>
                ))}
              </ul>
            </div>
          </div>,
        )}
      </div>
    ),
    number: cell.number,
    ...object,
  };
});
