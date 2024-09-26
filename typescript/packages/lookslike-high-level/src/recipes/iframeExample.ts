import { html } from "@commontools/common-html";
import {
  recipe,
  UI,
  NAME,
  lift,
  generateData,
  handler,
  str,
  cell,
  createJsonSchema
} from "@commontools/common-builder";

import { launch } from "../data.js";

const formatData = lift(({ obj }) => {
  console.log("stringify", obj);
  return JSON.stringify(obj, null, 2);
});

const tap = lift((x) => {
  console.log(x, JSON.stringify(x, null, 2));
  return x;
});

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => detail?.value && (state.value = detail.value)
);

const generate = handler<void, { prompt: string; schema: object; query: string; loading: boolean }>(
  (_, state) => {
    state.prompt = `${state.query}`;
    console.log("generating", state.query);
    state.loading = true;
  }
);

const maybeHTML = lift(({ result }) => result?.html ?? "");

const viewSystemPrompt = lift(({ schema }) => `generate a complete HTML document within a html block , e.g.
  \`\`\`html
  ...
  \`\`\`

  This must be complete HTML.
  Import Tailwind (include \`<script src="https://cdn.tailwindcss.com"></script>\`) and style the page using it. Use tasteful, minimal defaults with a consistent style but customize based on the request.
  Import React (include \`
    <script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  \`) and write the app using it.

  You may not use any other libraries unless requested by the user.

  The document can and should make use of postMessage to read and write data from the host context. e.g.

  document.addEventListener('DOMContentLoaded', function() {
    console.log('Initialized!');

    window.parent.postMessage({
        type: 'subscribe',
        key: 'exampleKey'
      }, '*');

    window.addEventListener('message', function(event) {
      if (event.data.type === 'readResponse') {
        // use response
        console.log('readResponse', event.data.key,event.data.value);
      } else if (event.data.type === 'update') {
        // event.data.value is a JSON object already
        // refer to schema for structure
      ...
    });
  });

  window.parent.postMessage({
    type: 'write',
    key: 'exampleKey',
    value: 'Example data to write'
  }, '*');

  You can subscribe and unsubscribe to changes from the keys:

  window.parent.postMessage({
    type: 'subscribe',
    key: 'exampleKey'
  }, '*');

  You receive 'update' messages with a 'key' and 'value' field.

  window.parent.postMessage({
    type: 'unsubscribe',
    key: 'exampleKey',
  }, '*');

  <view-model-schema>
    ${JSON.stringify(schema, null, 2)}
  </view-model-schema>

  It's best to access and manage each state reference seperately.`);

const cloneRecipe = handler<void, { data: any, title: string, prompt: string }>((_, state) => {
  launch(iframeExample, { data: state.data, title: 'clone of ' + state.title, prompt: state.prompt });
});

const deriveJsonSchema = lift(({ data, filter }) => {
  const schema = createJsonSchema({}, data)?.["properties"];
  if (!schema) return {};

  const filterKeys = (filter || '').split(',').map(key => key.trim()).filter(Boolean);

  if (filterKeys.length === 0) return schema;

  return Object.fromEntries(
    Object.entries(schema).filter(([key]) => filterKeys.includes(key))
  );
});

const onInput = handler<{ input: Event }, { value: string; }>(
  (input, state) => {
    state.value = input.target.value;
  }
);

const onContentLoaded = handler<void, { loading: boolean }>(
  (_, state) => {
    state.loading = false;
  }
);

const loadingStatus = lift(({ loading }) =>
  loading ? html`<div>Loading...</div>` : html`<div></div>`
);

const objectKeys = lift(({ obj }) => Object.keys(obj).map(key => ({ key })));

const onToggle = handler<Event, { key: string, selected: string[] }>((input, { key, selected }) => {
  const checkbox = input.target as HTMLInputElement;
  const isChecked = checkbox.checked;
  if (isChecked) {
    if (!selected.includes(key)) {
      selected.push(key);
    }
  } else {
    selected = selected.filter(item => item !== key);
  }
});

const copy = lift(({ value }: { value: any }) => value);

const selectedKeys = lift(({ keys }) => {
  let result = [];
  for (const key of keys) {
    if (key.checked) {
      result.push(key.key);
    }
  }
  return result;
});

const stringify = lift(({ value }) => JSON.stringify(value, null, 2));

const promptFilterSchema = lift(({ schema, prompt }) => `Given the following schema:

${JSON.stringify(schema, null, 2)}

Filter and return only the relevant parts of this schema for the following request:

${prompt}`);

const addToPrompt = handler((e, state) => {
  state.prompt += '\n' + e.prompt;
  state.lastSrc = state.src;
});

const buildUiPrompt = lift(({ prompt, lastSrc }) => {
  let fullPrompt = prompt;
  if (lastSrc) {
    fullPrompt += `\n\nHere's the previous HTML for reference:\n\`\`\`html\n${lastSrc}\n\`\`\``;
  }
  return fullPrompt;
});

export const iframeExample = recipe<{ title: string; prompt: string; data: any; src: string; loading: boolean; filter: string; }>(
  "iFrame Example",
  ({ title, prompt, filter, data, src, loading }) => {
    tap({ data });
    prompt.setDefault(
      "counter"
    );
    data.setDefault({ message: "hello" });
    src.setDefault('hi')
    loading.setDefault(false)

    filter.setDefault("");
    const schema = deriveJsonSchema({ data, filter });
    tap({ schema });
    console.log('prompt', prompt)
    const query = copy({ value: prompt });
    const lastSrc = cell()

    const scopedSchema = generateData<{ html: string }>({
      prompt: promptFilterSchema({ schema, prompt }),
      system: `Filter any keys from this schema that seem unrelated to the request. Respond in a json block.`,
      mode: "json",
    });

    tap({ scopedSchema });

    const response = generateData<{ html: string }>({
      prompt: buildUiPrompt({ prompt, lastSrc }),
      system: viewSystemPrompt({ schema: scopedSchema.result }),
      mode: "html",
    });
    tap({ response });
    tap({ result: response.result });

    src = maybeHTML({ result: response.result });

    return {
      [NAME]: str`${title} - iframe`,
      [UI]: html`<div>
        <common-input
          value=${title}
          placeholder="title"
          oncommon-input=${updateValue({ value: title })}
        ></common-input>


        ${loadingStatus({ loading })}

        <common-iframe
          src=${src}
          $context=${data}
          onloaded=${onContentLoaded({loading})}
        ></common-iframe>
        <common-button onclick=${cloneRecipe({ data, title, prompt })}
          >Clone</common-button
        >
        <details>
          <summary>View Data</summary>
          <common-input
            value=${filter}
            placeholder="Filter keys (comma-separated)"
            oncommon-input=${updateValue({ value: filter })}
          ></common-input>
          <pre>${formatData({ obj: data })}</pre>
        </details>
        <details>
          <summary>Edit Source</summary>
          <textarea
            value=${src}
            onkeyup=${onInput({ value: src })}
            style="width: 100%; min-height: 192px;"
          ></textarea>
        </details>

        <textarea
        value=${query}
        onkeyup=${onInput({ value: query })}
        style="width: 100%; min-height: 128px;"
        ></textarea>

      </div>`,
      prompt,
      title,
      src,
      data,
      addToPrompt: addToPrompt({ prompt, src, lastSrc }),
    };
  }
);
