import { html } from "@commontools/common-html";
import {
  recipe,
  lift,
  generateData,
  handler,
  NAME,
  UI,
  ifElse,
} from "../builder/index.js";
import { run, getCellReferenceOrValue } from "../runner/index.js";
import { openSaga, addGems, ID } from "../data.js";

export const prompt = recipe<{ title: string }>("prompt", ({ title }) => {
  // this kinda makes sense but feels painful?  better syntactic sugar?

  const url = lift(
    ({ title }) =>
      `https://ct-img.m4ke.workers.dev/?prompt=${encodeURIComponent(title)}`,
  )({ title });

  const query = lift(({ title }) => ({
    prompt: `generate 10 image prompt variations for the current prompt: ${title}.  Some should change just the style, some should change the content, and some should change both. The last should be a completely different prompt.`,
    result: [],
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Image prompt",
          },
        },
        required: ["title"],
      },
    },
  }))({
    title,
  });

  const { result: variations } = generateData<string[]>(query);

  const inner = ({ title }) =>
    html`<common-button onclick=${handler({ title }, (_, { title }) => {
      const newPrompt = run(prompt, { title });
      addGems([newPrompt]);
      openSaga(newPrompt.get()[ID]);
    })}}">${title}</common-button>`;

  return {
    [NAME]: title,
    [UI]: html`<common-vstack gap="sm">
      ${title}
      <img src=${url} width="100%" />
      ${ifElse(variations, variations.map(inner), html`<i></i>`)}
    </common-vstack>`,
  };
});
