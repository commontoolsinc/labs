import { html } from "@commontools/common-html";
import {
  recipe,
  UI,
  NAME,
  lift,
  handler,
  str,
  cell,
  createJsonSchema,
} from "@commontools/common-builder";

const formatData = lift(({ obj }) => {
  console.log("stringify", obj);
  return JSON.stringify(obj || {}, null, 2);
});

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => detail?.value && (state.value = detail.value),
);

const deriveJsonSchema = lift(({ data}) => {
  const schema = createJsonSchema({}, data)?.["properties"];
  if (!schema) return {};

  return schema;
});

const onInput = handler<KeyboardEvent, { value: string }>((input, state) => {
  state.value = (input.target as HTMLTextAreaElement).value;
});

const onAcceptData = handler<void, { json: string, data: string }>(
  (_, state) => {
    console.log("accept data", state.json, state.data);
    state.data = JSON.parse(JSON.stringify(state.json))
  }
);

const tryParseJson = lift(({ jsonText }) => {
  try {
    return JSON.parse(jsonText);
  } catch (error: any) {
    return {error: error?.message || 'Invalid JSON'};
  }
});

export const jsonImporter = recipe<{
  title: string;
  data: any;
}>("json importer", ({ title, data }) => {
  data.setDefault({ key: 'value' });
  title.setDefault("Untitled JSON Importer");

  const schema = deriveJsonSchema({ data });
  const jsonText = cell<string>('{}');
  jsonText.setDefault('{}')

  const json = tryParseJson({ jsonText });
  json.setDefault({});

  return {
    [NAME]: str`${title}`,
    [UI]: html`<div>
      <common-input
        value=${title}
        placeholder="title"
        oncommon-input=${updateValue({ value: title })}
      ></common-input>

      <pre>${formatData({ obj: json })}</pre>

      <textarea
        value=${jsonText}
        onkeyup=${onInput({ value: jsonText })}
        style="width: 100%; min-height: 128px;"
      ></textarea>

      <common-button
            onclick=${onAcceptData({ json, data })}
        >Import</common-button>

      <h3>schema</h3>
      <pre>${formatData({ obj: schema })}</pre>
    </div>`,
    title,
    data,
  };
});
