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
    number: { type: "number", default: 0 },
  },
  default: { number: 0 },
});

const outputSchema = {
  type: "object",
  properties: {
    number: { type: "number" },
    story: { type: "string" },
    storyOrigin: { type: "string" },
    seeAlso: { type: "array", items: { type: "number" } },
  },
} as const satisfies JSONSchema;

const adder = handler({}, inputSchema, (_, state) => {
  console.log("adding a value");
  state.number += 1;
});

const generatePrompt = lift(({ number: number }) => {
  console.log("number", number);
  return {
    prompt: `Generate a story about a number: ${number}`,
    schema: outputSchema,
  };
});

export default recipe(inputSchema, outputSchema, ({ number }) => {
  const { result: { story, storyOrigin, seeAlso } } = generateObject(
    generatePrompt({ number }),
  );

  return {
    [NAME]: str`Story: ${story}`,
    [UI]: (
      <div>
        <button type="button" onClick={adder({ number })}>
          {number} (inc)
        </button>
        {ifElse(story, <div>{story}</div>, <p>no story yet</p>)}
        {ifElse(storyOrigin, <div>{storyOrigin}</div>, <p>no story origin</p>)}
        {ifElse(
          seeAlso,
          <div>{seeAlso.map((n: number) => str`${n}`)}</div>,
          <p>no see also</p>,
        )}
      </div>
    ),
    story,
    number,
  };
});
