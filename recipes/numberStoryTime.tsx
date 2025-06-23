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
        <style>
          {`
            .story-container {
              position: relative;
              min-height: 300px;
              font-family: 'Segoe UI', 'Helvetica Neue', Arial, 'Liberation Sans', sans-serif;
              background: #f9f7f3;
              border-radius: 16px;
              box-shadow: 0 4px 24px rgba(0,0,0,0.07);
              padding: 2em 2em 2em 1.5em;
              margin-top: 1.5em;
            }
            .story-image {
              float: right;
              margin: 0 0 1em 2em;
              max-width: 260px;
              border-radius: 12px;
              box-shadow: 0 2px 8px rgba(0,0,0,0.13);
            }
            .story-title {
              font-size: 2.2em;
              font-weight: 700;
              margin-bottom: 0.2em;
              color: #2d2d2d;
              letter-spacing: 0.01em;
            }
            .story-number {
              font-size: 1.2em;
              color: #888;
              margin-bottom: 1em;
            }
            .story-text {
              white-space: pre-line;
              font-size: 1.18em;
              line-height: 1.7;
              color: #333;
              margin-top: 1em;
            }
            button {
              font-size: 1em;
              padding: 0.5em 1.2em;
              margin: 0.5em 0.7em 0.5em 0;
              border-radius: 8px;
              border: 1px solid #ddd;
              background: #f5f5fa;
              cursor: pointer;
              transition: background 0.2s;
            }
            button:hover {
              background: #e0e0f7;
            }
            @media (max-width: 700px) {
              .story-container {
                padding: 1em 0.5em;
              }
              .story-image {
                float: none;
                display: block;
                margin: 0 auto 1em auto;
                max-width: 100%;
              }
            }
          `}
        </style>
        <button type="button" onClick={nextNumber({ number })}>
          Next Story!!
        </button>
        <button type="button" onClick={randomNumber({ number })}>
          Random Story!!
        </button>
        <div className="story-container">
          <div className="story-title">
            The story of <span className="story-number">{number}</span>
          </div>
          <img
            className="story-image"
            src={getImageUrl({ prompt })}
            title={prompt}
            width={256}
            height={256}
          />
          {ifElse(
            storyPending,
            <p className="story-text">Hmm, let me think...</p>,
            <div className="story-text">{story}</div>,
          )}
        </div>
      </div>
    ),
    number,
    story,
  };
});
