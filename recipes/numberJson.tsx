import { h } from "@commontools/html";
import {
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
  const { result: { story, storyOrigin, seeAlso, title, imagePrompt } } =
    generateObject(generatePrompt({ number }));

  return {
    [NAME]: str`Story: ${title}`,
    [UI]: (
      <div>
        <button type="button" onClick={adder({ number })}>
          {number} (inc)
        </button>
        {ifElse(title, <h1>{title}</h1>, <p>no title</p>)}
        {ifElse(
          imagePrompt,
          <p>
            <img src={generateImageUrl({ imagePrompt })} />
          </p>,
          <p>no image prompt</p>,
        )}
        {ifElse(story, <p>{story}</p>, <p>no story yet</p>)}
        {ifElse(
          storyOrigin,
          <p>
            <em>{storyOrigin}</em>
          </p>,
          <p>no story origin</p>,
        )}
        {ifElse(
          seeAlso,
          <ul>
            {seeAlso.map((n: number) => (
              <li onClick={setNumber({ number, n })}>{n}</li>
            ))}
          </ul>,
          <p>no see also</p>,
        )}
      </div>
    ),
    story,
    number,
    seeAlso,
    imagePrompt,
    storyOrigin,
    title,
  };
});
