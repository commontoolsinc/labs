import { html } from "@commontools/common-html";
import {
  recipe,
  UI,
  NAME,
  lift,
  generateData,
  handler,
  str,
  createJsonSchema,
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

const systemPrompt = `generate/modify a document based on input, respond within a json block , e.g.
  \`\`\`json
  ...
  \`\`\`

  No field can be set to null or undefined.`;

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
  state.prompt += "\n" + e.prompt;
  state.query = state.prompt;
});

const buildJSONGenPrompt = lift(({ prompt, data }) => {
  console.log("prompt", prompt, data);
  let fullPrompt = prompt;
  if (data) {
    fullPrompt += `\n\nHere's the previous JSON for reference:\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  }
  return fullPrompt;
});

const onAcceptData = handler<void, { data: any; lastData: any; result: any }>(
  (_, state) => {
    console.log("accept data", state.data, state.result);
    state.lastData = JSON.parse(JSON.stringify(state.data));
    state.data = JSON.parse(JSON.stringify(state.result))
  }
);

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
  const lastData = copy({ value: data });
  lastData.setDefault({});
  tap({ lastData });

  const { result } = generateData<any>({
    prompt: buildJSONGenPrompt({ prompt, data: lastData }),
    system: systemPrompt,
    mode: "json",
  });
  tap({ result })

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

      <pre>${formatData({ obj: result })}</pre>
      <common-button
        onclick=${onAcceptData({ data, lastData, result })}
      >Accept</common-button>

    </div>`,
    prompt,
    title,
    data,
    addToPrompt: addToPrompt({ prompt, query }),
  };
});
