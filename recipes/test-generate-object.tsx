import {
  derive,
  generateObject,
  h,
  handler,
  ifElse,
  type JSONSchema,
  lift,
  NAME,
  recipe,
  schema,
  str,
  UI,
} from "commontools";

// Input schema with a number that can be incremented
const inputSchema = schema({
  type: "object",
  properties: {
    number: { type: "number", default: 0, asCell: true },
  },
  default: { number: 0 },
});

// Output schema for the generated object
const outputSchema = {
  type: "object",
  properties: {
    number: { type: "number" },
    story: { type: "string" },
    title: { type: "string" },
    storyOrigin: { type: "string" },
    seeAlso: { type: "array", items: { type: "number" } },
    imagePrompt: { type: "string" },
  },
} as const satisfies JSONSchema;

// Handler to increment the number
const adder = handler({}, inputSchema, (_, state) => {
  console.log("incrementing number");
  state.number.set(state.number.get() + 1);
});

// Handler to set a specific number
const setNumber = handler({
  type: "object",
  properties: {},
}, {
  type: "object",
  properties: {
    number: { type: "number", asCell: true },
    n: { type: "number" },
  },
}, (_, state) => {
  if (state.number && state.n) {
    state.number.set(state.n);
  }
});

// Generate the prompt for the LLM
const generatePrompt = lift(({ number: number }) => {
  return {
    prompt:
      `You are the parent of a young child who loves to learn about numbers. Luckily for your child, you are a historian of numbers and when the child says a number you make up an interesting story about it, including the history of the number. The child is currently at ${number}. Also return a recommendation for other numbers that might be interesting to the child to learn about next.`,
    schema: outputSchema,
  };
});

// Generate an image URL from the prompt
const generateImageUrl = lift(({ imagePrompt }) => {
  return `/api/ai/img?prompt=${encodeURIComponent(imagePrompt)}`;
});

export default recipe(inputSchema, outputSchema, (cell) => {
  // Use generateObject to get structured data from the LLM
  const { result: object, pending } = generateObject(generatePrompt({ number: cell.number }));

  return {
    [NAME]: str`Number Story: ${object?.title || "Loading..."}`,
    [UI]: (
      <div>
        <ct-button onClick={adder(cell)}>
          Current number: {cell.number} (click to increment)
        </ct-button>
        {ifElse(
          pending,
          <p>Generating story...</p>,
          <div>
            {ifElse(object?.title, <h1>{object.title}</h1>, <p>No title</p>)}
            {ifElse(
              object?.imagePrompt,
              <p>
                <img src={generateImageUrl({ imagePrompt: object.imagePrompt })} />
              </p>,
              <p>No image prompt</p>,
            )}
            {ifElse(object?.story, <p>{object.story}</p>, <p>No story yet</p>)}
            {ifElse(
              object?.storyOrigin,
              <p>
                <em>{object.storyOrigin}</em>
              </p>,
              <p>No story origin</p>,
            )}
            {ifElse(
              object?.seeAlso,
              <div>
                <p>See also these interesting numbers:</p>
                <ul>
                  {object.seeAlso.map((n: number) => (
                    <li>
                      <ct-button onClick={setNumber({ number: cell.number, n })}>
                        {n}
                      </ct-button>
                    </li>
                  ))}
                </ul>
              </div>,
              <p>No related numbers</p>,
            )}
          </div>
        )}
      </div>
    ),
    number: cell.number,
    ...object,
  };
});