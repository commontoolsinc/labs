import { h } from "@commontools/html";
import {
  derive,
  handler,
  ifElse,
  JSONSchema,
  lift,
  llm,
  NAME,
  recipe,
  schema,
  str,
  UI,
} from "@commontools/builder";

const inputSchema = schema({
  type: "object",
  properties: {
    number: { type: "number", default: 0 },
  },
}) satisfies JSONSchema;

const nextNumber = handler<{}, { number: number }>(
  (_, state) => {
    state.number = (state.number ?? 0) + 1;
  },
);
const randomNumber = handler<{}, { number: number }>(
  (_, state) => {
    state.number = Math.floor(Math.random() * 102) - 1;
  },
);

const generateStory = lift(({ number }: { number: number }) => {
  return {
    system:
      "You are the parent of a young child who loves to learn about numbers. Luckily for your child, you are a historian of numbers and when the child says a number you make up an interesting story about it, including the history of the number.",
    messages: [`Tell me a story about ${number}`],
  };
});

const generatePrompt = lift(({ story }: { story: string | undefined }) => {
  if (!story) {
    return;
  }
  return {
    system:
      "You are an imaginative illustrator. Read the following story and create a vivid, detailed image prompt for an AI image generator. Focus on the most unique, visual, and interesting elements mentioned in the story. Include any historical figures, objects, or settings described. Be specific and creative, and use a storybook illustration style. Here is the story:",
    messages: ["Story: " + story],
  };
});

const getImageUrl = lift(({ prompt }: { prompt: string | undefined }) => {
  if (!prompt) {
    prompt =
      "A child at bedtime learning about the magic of numbers with their father, magical, mystical, storybook illustration style";
  }
  return "/api/ai/img?prompt=" + encodeURIComponent(prompt);
});

export default recipe(inputSchema, ({ number }) => {
  const { result: story, pending: storyPending } = llm(
    generateStory({ number }),
  );
  const { result: prompt } = llm(
    generatePrompt({ story }),
  );
  return {
    [NAME]: str`The story of ${derive(number, (number) => number)}`,
    [UI]: (
      <div>
        <button type="button" onClick={nextNumber({ number })}>
          Next Story!!
        </button>
        <button type="button" onClick={randomNumber({ number })}>
          Random Story!!
        </button>
        <div>
          <h1>{number}</h1>
          <img
            src={getImageUrl({ prompt })}
            title={prompt}
            width={512}
            height={512}
          />
          {ifElse(storyPending, <p>Hmm, let me think...</p>, <p>{story}</p>)}
        </div>
      </div>
    ),
    number,
    story,
  };
});
