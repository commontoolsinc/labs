import { html } from "@commontools/common-html";
import {
  recipe,
  fetchData,
  UI,
  NAME,
  ifElse,
  lift,
  generateData,
  handler,
} from "@commontools/common-builder";
import { cell} from "@commontools/common-runner";

const formatData = lift(({ obj }) => {
  console.log('stringify', obj)
  return JSON.stringify(obj, null, 2)
})

const tap = lift(x => {
  console.log(x);
  return x;
})

// TODO(ben): this is the shared state with the iframe, unsure if this is the right way to orchestrate
const context = cell({ exampleKey: 456 })
const data = context.getAsProxy()
const getHtml = lift((obj) => obj?.html)

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => detail?.value && (state.value = detail.value)
);

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
  }, '*');`

export const iframeExample = recipe<{ prompt: string }>(
  "iFrame Example",
  ({ prompt }) => {
    const dataPayload = formatData({ obj: data })
    tap({ data, dataPayload })
    prompt.setDefault("make a red circle and say hello")

    const response = generateData({ prompt, system: viewSystemPrompt })
    tap(response)
    tap(response.result)
    response.result.setDefault({ html: '' })
    const srcHtml = getHtml(response.result)

    // TOOD(ben): dataPayload does not update as I would expect when written to
    // via the postMessage API
    return {
      [NAME]: "iFrame Example",
      [UI]: html`<div>
        <div>${dataPayload}</div>
        <div>${response.result}</div>
        <common-input
          value=${prompt}
          placeholder="Prompt"
          oncommon-input=${updateValue({ value: prompt })}
        ></common-input>

        <common-iframe src=${srcHtml} context=${data} ></common-iframe>
      </div>`,
      dataPayload,
      response,
      data
    };
  }
);
