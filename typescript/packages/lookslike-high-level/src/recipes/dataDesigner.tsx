import { h } from "@commontools/html";
import {
  recipe,
  UI,
  NAME,
  lift,
  llm,
  handler,
  str,
  cell,
  ifElse,
} from "@commontools/builder";
import { truncateAsciiArt } from "../loader.js";

const formatData = lift(({ obj }) => {
  console.log("stringify", obj);
  return JSON.stringify(obj || {}, null, 2);
});

const tap = lift((x) => {
  console.log(x, JSON.stringify(x, null, 2));
  return x;
});

const buildPrompt = lift(({ prompt, data }) => {
  let fullPrompt = prompt;
  if (data) {
    fullPrompt = `\n\nHere's the previous JSON for reference:\n\`\`\`json\n${JSON.stringify(
      data,
      null,
      2,
    )}\n\`\`\``;
  }

  return {
    messages: [prompt, "data plz", fullPrompt, "```json\n"],
    system: `You will transform JSON data as per the user's request, respond within a json block , e.g.
\`\`\`json
...
\`\`\`

If you would like to use generated images use the following URL:

\`https://ct-img.m4ke.workers.dev/?prompt=<URL_ENCODED_PROMPT>\`

No field can be set to null or undefined.`,
    stop: "```",
  };
});

const grabJSON = lift<{ result?: string }, any>(({ result }) => {
  if (!result) {
    return {};
  }
  const jsonMatch = result.match(/```json\n([\s\S]+?)```/);
  if (!jsonMatch) {
    console.error("No JSON found in text:", result);
    return {};
  }
  let d = JSON.parse(jsonMatch[1]);
  console.log("grabJSON", d);
  return d;
});

const copy = lift(({ value }: { value: any }) => value);

const addToPrompt = handler<
  { prompt: string },
  { prompt: string; query: string }
>((e, state) => {
  state.prompt = (state.prompt ? state.prompt + "\n" : "") + e.prompt;
  state.query = state.prompt;
});

const dots = lift<{ pending: boolean; partial?: string }, string>(
  ({ pending, partial }) => {
    if (!partial || !pending) {
      return "";
    }
    return truncateAsciiArt(partial.length / 2.0);
  },
);

export const dataDesigner = recipe<{
  title: string;
  prompt: string;
  data: any;
}>("Data Designer", ({ title, prompt, data }) => {
  prompt.setDefault("");
  data.setDefault({});
  title.setDefault("Untitled Data Designer");

  const query = copy({ value: prompt });
  // using copy for lastData was causing re-running llm whenever data changed in iframes
  const lastData = cell({ key: "value" });
  tap({ lastData });

  const { result, pending, partial } = llm(buildPrompt({ prompt, data }));
  const generatedData = grabJSON({ result });

  return {
    [NAME]: str`${title}`,
    [UI]: <div>
      {ifElse(
        pending,
        <pre style="padding: 32px; color: #ccc; text-align: center;">{dots({ partial, pending })}</pre>,
        <pre>{formatData({ obj: generatedData })}</pre>
      )}
    </div>,
    prompt,
    title,
    data: generatedData,
    addToPrompt: addToPrompt({ prompt, query }),
  };
});
