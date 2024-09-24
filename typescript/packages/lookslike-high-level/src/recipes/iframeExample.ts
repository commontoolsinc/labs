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
  console.log(x);
  return x;
});

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => detail?.value && (state.value = detail.value)
);

const generate = handler<void, { prompt: string; schema: object; query: string; loading: boolean }>(
  (_, state) => {
    state.query = `
      <schema>
        ${JSON.stringify(state.schema, null, 2)}
      </schema>

      ${state.prompt}`;
    console.log("generating", state.query);
    state.loading = true;
  }
);

const randomize = handler<void, { data: Record<string, any> }>((_, state) => {
  for (const key in state.data) {
    if (typeof state.data[key] === "number") {
      state.data[key] = Math.round(Math.random() * 100); // Generates a random number between 0 and 100
    }
  }
});

const maybeHTML = lift(({ result }) => result?.html ?? "");

const viewSystemPrompt = `generate a complete HTML document within a html block , e.g.
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
      ...
    });
  });

  window.parent.postMessage({
    type: 'read',
    key: 'exampleKey'
  }, '*');

  window.parent.postMessage({
    type: 'write',
    key: 'exampleKey',
    value: 'Example data to write'
  }, '*');

  You can also subscribe and unsubscribe to changes from the keys:

  window.parent.postMessage({
    type: 'subscribe',
    key: 'exampleKey'
  }, '*');

  You receive 'update' messages with a 'key' and 'value' field.

  window.parent.postMessage({
    type: 'unsubscribe',
    key: 'exampleKey',
  }, '*');

  Do not explain the HTML, no-one will be able to read the explanation. If the user does not specify any style, make it beautiful. You got this.`;

const cloneRecipe = handler<void, { data: any, title: string, prompt: string }>((_, state) => {
  launch(iframeExample, { data: state.data, title: 'clone of ' + state.title, prompt: state.prompt });
});

const deriveJsonSchema = lift(({ data }) => {
  return createJsonSchema({}, data)?.["properties"];
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

export const iframeExample = recipe<{ title: string; prompt: string; data: any; src: string; loading: boolean; }>(
  "iFrame Example",
  ({ title, prompt, data, src, loading }) => {
    tap({ data });
    prompt.setDefault(
      "counter"
    );
    data.setDefault({ message: "hello" });
    src.setDefault('hi')
    loading.setDefault(false)

    const schema = deriveJsonSchema({ data });

    const query = cell<string>();
    const response = generateData<{ html: string }>({
      prompt: query,
      system: viewSystemPrompt,
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

        <div style="display: flex; align-items: flex-start;">
          <textarea
            value=${prompt}
            onkeyup=${onInput({ value: prompt })}
            style="width: 80%; min-height: 64px; margin-right: 10px;"
          ></textarea>
          <common-button
            onclick=${generate({ prompt, schema, query, loading })}
            style="white-space: nowrap;"
          >
            Generate
          </common-button>
        </div>

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

      </div>`,
      prompt,
      title,
      src,
      data,
    };
  }
);
