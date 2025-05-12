import { h } from "@commontools/html";
import {
  derive,
  generateObject,
  handler,
  ifElse,
  JSONSchema,
  lift,
  NAME,
  recipe,
  schema,
  str,
  UI,
} from "@commontools/builder";

// Different way to define the same schema, using 'schema' helper function,
// let's as leave off `as const satisfies JSONSchema`.
const inputSchema = schema({
  type: "object",
  properties: {
    number: { type: "number", default: 0, asCell: true },
  },
  default: { number: 0 },
});

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

const adder = handler({}, inputSchema, (_, state) => {
  console.log("adding a value");
  state.number.set(state.number.get() + 1);
});

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
  } else {
    console.log({ state });
  }
});

const generatePrompt = lift(({ number: number }) => {
  console.log("number", number);
  return {
    prompt:
      `You are the parent of a young child who loves to learn about numbers. Luckily for your child, you are a historian of numbers and when the child says a number you make up an interesting story about it, including the history of the number. The child is currently at ${number}. Also return a recommendation for other numbers that might be interesting to the child to learn about next.`,
    schema: outputSchema,
  };
});

const generateImageUrl = lift(({ imagePrompt }) => {
  return `/api/ai/img?prompt=${encodeURIComponent(imagePrompt)}`;
});

export default recipe(inputSchema, outputSchema, ({ number }) => {
  const { result: object } = generateObject(generatePrompt({ number }));

  return {
    [NAME]: str`Story: ${object?.title}`,
    [UI]: (
      <div>
        <button type="button" onClick={adder({ number })}>
          {number} (inc)
        </button>
        {ifElse(object?.title, <h1>{object.title}</h1>, <p>no title</p>)}
        {ifElse(
          object?.imagePrompt,
          <p>
            <img src={generateImageUrl({ imagePrompt: object.imagePrompt })} />
          </p>,
          <p>no image prompt</p>,
        )}
        {ifElse(object?.story, <p>{object.story}</p>, <p>no story yet</p>)}
        {ifElse(
          object?.storyOrigin,
          <p>
            <em>{object.storyOrigin}</em>
          </p>,
          <p>no story origin</p>,
        )}
        {ifElse(
          object?.seeAlso,
          <ul>
            <li>
              See also one of{" "}
              {derive(object.seeAlso, (numbers) => numbers.length)} numbers:
            </li>
            {object.seeAlso.map((n: number) => (
              <li onClick={setNumber({ number, n })}>{n}</li>
            ))}
          </ul>,
          <p>no see also</p>,
        )}
      </div>
    ),
    number,
    ...object,
  };
});
