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
  createJsonSchema,
} from "@commontools/common-builder";

import { launch } from "../data.js";

type Suggestion = {
  behaviour: 'append' | 'fork',
  prompt: string,
}

const formatData = lift(({ obj }) => {
  console.log("stringify", obj);
  return JSON.stringify(obj, null, 2);
});

const tap = lift((x) => {
  console.log(x, JSON.stringify(x, null, 2));
  return x;
});

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => detail?.value && (state.value = detail.value),
);

const maybeHTML = lift(({ result }) => {
  return result?.html || ''
});

const maybeSRC = lift(({ src, pending, partial }) => {
  if (src) return src;
  if (!pending) return `
    <div style="display: flex; justify-content: center; align-items: center; height: 100vh;">
      <span style="font-size: 40px;">❌</span>
      <p style="margin-left: 10px; font-family: Arial, sans-serif; color: #e74c3c;">Error generating content</p>
    </div>
  `;
  if (partial) return '<pre>' + partial.replace(/</g, '&lt;').slice(-1000);
});

const viewSystemPrompt = lift(
  ({ schema }) => `generate a complete HTML document within a html block , e.g.
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

  It's best to access and manage each state reference seperately.`,
);

const deriveJsonSchema = lift(({ data, filter }) => {
  const schema = createJsonSchema({}, data)?.["properties"];
  if (!schema) return {};

  const filterKeys = (filter || "")
    .split(",")
    .map((key: string) => key.trim())
    .filter(Boolean);

  if (filterKeys.length === 0) return schema;

  return Object.fromEntries(
    Object.entries(schema).filter(([key]) => filterKeys.includes(key)),
  );
});

const onInput = handler<KeyboardEvent, { value: string }>((input, state) => {
  state.value = (input.target as HTMLTextAreaElement).value;
});

const copy = lift(({ value }: { value: any }) => value);

const addToPrompt = handler<
  { prompt: string },
  { prompt: string; lastSrc: string; src: string, query: string }
>((e, state) => {
  state.prompt += "\n" + e.prompt;
  state.lastSrc = state.src;
  state.query = state.prompt;
});

const acceptSuggestion = handler<
  void,
  { suggestion: Suggestion; prompt: string; lastSrc: string; src: string, query: string, data: any; }
>((_, state) => {
  if (state.suggestion.behaviour === 'append') {
    console.log(state.prompt, state.query, state.suggestion.prompt)
    state.prompt += "\n" + state.suggestion.prompt;
    state.lastSrc = state.src;
    state.query = `${state.prompt}`;
  } else if (state.suggestion.behaviour === 'fork') {
    launch(iframe, { data: state.data, title: state.suggestion.prompt, prompt: state.suggestion.prompt });
  }
});

const buildUiMessages = lift(({ prompt, lastSrc }) => {
  let fullPrompt = prompt;
  if (lastSrc) {
    fullPrompt += `\n\nHere's the previous HTML for reference:\n\`\`\`html\n${lastSrc}\n\`\`\``;
  }
  return [fullPrompt, '```html\n<html>']
});

const buildSuggestionsMessages = lift(({ src, prompt, schema }) => {
  if (!src) return;

  let user = `Given the current prompt: "${prompt}"`;
  user += `\n\nGiven the following schema:\n<view-model-schema>\n${JSON.stringify(schema, null, 2)}\n</view-model-schema>`;
  user += `\n\nAnd the current HTML:\n\`\`\`html\n${src}\n\`\`\``;
  user += `\n\nSuggest 3 prompts to enhancem, refine or branch off into a new UI. Keep it simple these add or change a single feature. Return the suggestions in a JSON block with the following structure:
  \`\`\`json
  {
    "suggestions": [
      {
        "behaviour": "append" | "fork",
        "prompt": "string"
      }
    ]
  }
  \`\`\`

  Do not ever exceed a single sentence. Prefer terse, suggestions that take one step.
  `;

  return [user, '```json\n{"suggestions":['];
});

const getSuggestions = lift(({ result }) => result?.suggestions ?? []);

const getSuggestion = lift(({ suggestions, index }: { suggestions: Suggestion[], index: number }) => {
  return suggestions[index] || { behaviour: '', prompt: '' };
});

export const iframe = recipe<{
  title: string;
  prompt: string;
  data: any;
  src: string;
  filter: string;
}>("iframe", ({ title, prompt, filter, data, src }) => {
  tap({ data });
  prompt.setDefault("");
  data.setDefault({});
  src.setDefault("");

  filter.setDefault("");
  const schema = deriveJsonSchema({ data, filter });
  tap({ schema });

  const query = copy({ value: prompt });
  const lastSrc = cell<string>();

  // const scopedSchema = generateData<{ html: string }>({
  //   prompt: promptFilterSchema({ schema, prompt }),
  //   system: `Filter any keys from this schema that seem unrelated to the request. Respond in a json block.`,
  //   mode: "json",
  // });

  const { result: suggestionsResult } = generateData<{ suggestions: Suggestion[] }>({
    messages: buildSuggestionsMessages({ src, prompt, schema }),
    system: `Suggest extensions to the UI either as modifications or forks off into new interfaces. Avoid bloat, focus on the user experience and creative potential. Respond in a json block.`,
    mode: "json",
  });
  const suggestions = getSuggestions({ result: suggestionsResult });

  const { result: htmlResult, pending: htmlPending, partial: partialHtml } = generateData<{ html: string }>({
    messages: buildUiMessages({ prompt, lastSrc }),
    system: viewSystemPrompt({ schema }),
    mode: "html",
  });

  src = maybeHTML({ result: htmlResult });
  let preview = maybeSRC({ src, pending: htmlPending, partial: partialHtml });

  let firstSuggestion = getSuggestion({ suggestions, index: 0 });
  let secondSuggestion = getSuggestion({ suggestions, index: 1 });
  let thirdSuggestion = getSuggestion({ suggestions, index: 2 });

  return {
    [NAME]: str`${title} - iframe`,
    [UI]: html`<div>
      <common-input
        value=${title}
        placeholder="title"
        oncommon-input=${updateValue({ value: title })}
      ></common-input>
      <common-iframe src=${preview} $context=${data}></common-iframe>
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

      <button type="button"
        onclick=${acceptSuggestion({ suggestion: firstSuggestion, prompt, src, lastSrc, query, data })}
      >${firstSuggestion.behaviour} ${firstSuggestion.prompt}</button>
      <button type="button"
        onclick=${acceptSuggestion({ suggestion: secondSuggestion, prompt, src, lastSrc, query, data })}
      >${secondSuggestion.behaviour} ${secondSuggestion.prompt}</button>
      <button type="button"
        onclick=${acceptSuggestion({ suggestion: thirdSuggestion, prompt, src, lastSrc, query, data })}
      >${thirdSuggestion.behaviour} ${thirdSuggestion.prompt}</button>
    </div>`,
    prompt,
    title,
    src,
    data,
    addToPrompt: addToPrompt({ prompt, src, lastSrc, query }),
  };
});
