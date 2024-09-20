import { html } from "@commontools/common-html";
import {
  recipe,
  UI,
  NAME,
  lift,
  generateData,
  handler,
  cell,
} from "@commontools/common-builder";

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

const generate = handler<void, { prompt: string; query: string }>(
  (_, state) => {
    state.query = state.prompt;
    console.log("generarting", state.query);
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

const viewSystemPrompt = `generate a complete HTML document within a json block , e.g.
  \`\`\`json
  { html: "..."}
  \`\`\`

  This must be plain JSON.

  the document can and should make use of postMessage to read and write data from the host context. e.g.

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
  }, '*');`;

export const iframeExample = recipe<{ prompt: string; data: any }>(
  "iFrame Example",
  ({ prompt, data }) => {
    tap({ data });
    prompt.setDefault(
      "counter example using write and subscribe with key `counter`"
    );
    data.setDefault({ message: "hello", counter: 0 });

    const query = cell<string>();
    const response = generateData<{ html: string }>({
      prompt: query,
      system: viewSystemPrompt,
    });
    tap({ response });
    tap({ result: response.result });

    return {
      [NAME]: "iFrame Example",
      [UI]: html`<div>
        <pre>${formatData({ obj: data })}</pre>
        <common-input
          value=${prompt}
          placeholder="Prompt"
          oncommon-input=${updateValue({ value: prompt })}
        ></common-input>
        <common-button onclick=${randomize({ data })}
          >Randomize Values</common-button
        >
        <common-button onclick=${generate({ prompt, query })}
          >Generate</common-button
        >

        <common-iframe
          src=${maybeHTML({ result: response.result })}
          $context=${data}
        ></common-iframe>
        <pre>${maybeHTML({ result: response.result })}</pre>
      </div>`,
      response,
      data,
    };
  }
);
