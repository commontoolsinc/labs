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

const maybeHTML = lift(({ result }) => result?.html ?? "");

const viewSystemPrompt = `generate a complete HTML document within a json block , e.g. \`\`\`json{ html: '...'}\`\`\`

  the document can and should make use of postMessage to read and write data from the host context. e.g.

  window.addEventListener('message', function(event) {
    if (event.data === 'init') {
      console.log('Initialized!');
    } else if (event.data.type === 'readResponse') {
      // use response
    }
  });

  window.parent.postMessage({
    type: 'read',
    key: 'exampleKey'
  }, '*');

  window.parent.postMessage({
    type: 'write',
    key: 'exampleKey',
    data: 'Example data to write'
  }, '*');`;

export const iframeExample = recipe<{ prompt: string; data: any }>(
  "iFrame Example",
  ({ prompt, data }) => {
    tap({ data });
    prompt.setDefault("make a red circle and say the message from the data");
    data.setDefault({ message: "hello" });

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
        <div>${formatData({ obj: data })}</div>
        <div>${maybeHTML({ result: response.result })}</div>
        <common-input
          value=${prompt}
          placeholder="Prompt"
          oncommon-input=${updateValue({ value: prompt })}
        ></common-input>
        <common-button onclick=${generate({ prompt, query })}
          >Generate</common-button
        >

        <common-iframe
          src=${maybeHTML({ result: response.result })}
          context=${{ context: data }}
        ></common-iframe>
      </div>`,
      response,
      data,
    };
  }
);
