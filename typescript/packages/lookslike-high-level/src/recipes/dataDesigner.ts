import { html } from "@commontools/common-html";
import {
  recipe,
  UI,
  NAME,
  lift,
  llm,
  handler,
  str,
  createJsonSchema,
  cell,
} from "@commontools/common-builder";


const formatData = lift(({ obj }) => {
  console.log("stringify", obj);
  return JSON.stringify(obj || {}, null, 2);
});

const tap = lift((x) => {
  console.log(x, JSON.stringify(x, null, 2));
  return x;
});

const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
  ({ detail }, state) => detail?.value && (state.title = detail.value),
);

const buildPrompt = lift(({ prompt, data }) => {
  let fullPrompt = prompt;
  if (data) {
    fullPrompt += `\n\nHere's the previous JSON for reference:\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  }

  return {
    messages: [fullPrompt, '```json\n'],
    system: `generate/modify a document based on input, respond within a json block , e.g.
\`\`\`json
...
\`\`\`

No field can be set to null or undefined.`,
    stop: '```'
  }
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

const deriveJsonSchema = lift(({ data }) => {
  const schema = createJsonSchema({}, data)?.["properties"];
  if (!schema) return {};

  return schema;
});

const onInput = handler<KeyboardEvent, { value: string }>((input, state) => {
  state.value = (input.target as HTMLTextAreaElement).value;
});

const copy = lift(({ value }: { value: any }) => value);

const addToPrompt = handler<
  { prompt: string },
  { prompt: string; query: string }
>((e, state) => {
  state.prompt = (state.prompt ? state.prompt + "\n" : "") + e.prompt;
  state.query = state.prompt;
});

const onAcceptData = handler<void, { data: any; lastData: any; generatedData: any }>(
  (_, state) => {
    state.lastData = JSON.parse(JSON.stringify(state.data));
    state.data = JSON.parse(JSON.stringify(state.generatedData))
  }
);

const tail = lift<{ pending: boolean, partial?: string, lines: number }, string>(({ pending, partial, lines }) => {
  if (!partial || !pending) {
    return "";
  }
  return partial.split('\n').slice(-lines).join('\n');
});


export const dataDesigner = recipe<{
  title: string;
  prompt: string;
  data: any;
}>("iframe", ({ title, prompt, data }) => {
  prompt.setDefault("");
  data.setDefault({ key: 'value' });
  title.setDefault("Untitled Data Designer");

  const schema = deriveJsonSchema({ data });
  const query = copy({ value: prompt });
  // using copy for lastData was causing re-running llm whenever data changed in iframes
  const lastData = cell({ key: 'value' })
  tap({ lastData });

  const {result, pending, partial} = llm(buildPrompt({ prompt, data: lastData }));
  const generatedData = grabJSON({ result });

  return {
    [NAME]: str`${title}`,
    [UI]: html`<div>
      <common-input
        value=${title}
        placeholder="title"
        oncommon-input=${updateTitle({ title })}
      ></common-input>

      <pre>${formatData({ obj: data })}</pre>
      <pre>${formatData({ obj: schema })}</pre>

      <textarea
        value=${query}
        onkeyup=${onInput({ value: query })}
        style="width: 100%; min-height: 128px;"
      ></textarea>
      <pre>${tail({ partial, pending, lines: 5 })}
      <pre>${formatData({ obj: generatedData })}</pre>
      <common-button
        onclick=${onAcceptData({ data, lastData, generatedData })}
      >Accept</common-button>

    </div>`,
    prompt,
    title,
    data,
    addToPrompt: addToPrompt({ prompt, query }),
  };
});
