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

const onData = handler<CustomEvent, { data: any}>(
  ({ detail }, state) => {
    console.log("onData", detail);

    state.data = detail;
  });

const onSave = handler<MouseEvent, { data: any; collection: string; }>((_, state) => {
  console.log("onSave", state.data);
  const ok = confirm(`import "${JSON.stringify(state.data)}" to "${state.collection}"?`)
  if (ok) {
    alert("imported")
  }
});

export const jsonImporter = recipe<{
  title: string;
  collection: string;
  data: any;
}>("json importer", ({ title, data, collection }) => {
  data.setDefault({ key: 'value' });
  title.setDefault("Untitled JSON Importer");
  collection.setDefault("inbox");

  const schema = deriveJsonSchema({ data });
  const jsonText = cell<string>('{}');
  jsonText.setDefault('{}')

  const json = tryParseJson({ jsonText });
  json.setDefault({});

  return {
    [NAME]: str`${title}`,
    [UI]: html`<os-container>
        <common-input
          value=${collection}
          placeholder="collection"
          oncommon-input=${updateValue({ value: collection })}
        ></common-input>
        <button onclick=${onSave({ data, collection })}>Save</button>

      <common-import oncommon-data=${onData({ data })}>
      </common-import>

      <pre>${formatData({ obj: schema })}</pre>
    </os-container>`,
    title,
    data,
  };
});
